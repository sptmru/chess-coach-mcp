import { and, eq, inArray, sql, lt } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';
import type { DB } from '../database/client.js';
import { jobs, users } from '../database/schema.js';
import { DomainError, hash, log, metric, missing, safeError } from '../utils/core.js';
export type Job = typeof jobs.$inferSelect;
export type JobControl = {
  progress: (done: number, total: number, failed?: number, result?: unknown) => Promise<void>;
  checkCancelled: () => Promise<void>;
};
export type JobHandler = (job: Job, control: JobControl) => Promise<unknown>;
export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private active = new Set<Promise<void>>();
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private polling = false;
  private lease?: PoolClient;
  constructor(
    private db: DB,
    private pool: Pool,
    private concurrency: number,
  ) {}
  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }
  async start() {
    this.lease = await this.pool.connect();
    const lock = await this.lease.query('select pg_try_advisory_lock(624681903) as locked');
    if (!lock.rows[0].locked) {
      this.lease.release();
      this.lease = undefined;
      throw new Error('Only one worker process is supported; another worker holds the lease');
    }
    this.lease.on('error', () => {
      this.stopping = true;
      log.error('Worker database lease lost');
    });
    await this.recover();
    this.timer = setInterval(() => void this.tick().catch(() => log.error('Job poll failed')), 500);
    this.timer.unref();
  }
  async recover() {
    await this.db
      .update(jobs)
      .set({
        state: 'queued',
        retries: sql`${jobs.retries}+1`,
        error: 'Interrupted by restart; safe retry queued',
        startedAt: null,
      })
      .where(and(eq(jobs.state, 'running'), lt(jobs.retries, 3)));
    await this.db
      .update(jobs)
      .set({
        state: 'failed',
        error: 'Interrupted too many times; submit a new job',
        finishedAt: new Date(),
      })
      .where(eq(jobs.state, 'running'));
  }
  async enqueue(
    userId: string,
    identityId: string,
    type: string,
    payload: Record<string, unknown>,
    key: string,
    correlationId: string,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(624681904)`);
      await tx.select().from(users).where(eq(users.id, userId)).for('update');
      const idempotencyKey = hash({ identityId, type, key });
      const [existing] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.userId, userId), eq(jobs.idempotencyKey, idempotencyKey)));
      if (existing) return this.compact(existing);
      const pending = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(eq(jobs.userId, userId), inArray(jobs.state, ['queued', 'running'])));
      if (pending.length >= 5) throw new DomainError('limits', 'At most 5 pending jobs per user');
      const [count] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(jobs)
        .where(inArray(jobs.state, ['queued', 'running']));
      if (count.n >= 100) throw new DomainError('busy', 'Job queue is full');
      const [created] = await tx
        .insert(jobs)
        .values({ userId, identityId, type, payload, idempotencyKey, correlationId })
        .returning();
      return this.compact(created);
    });
  }
  compact(job: Job) {
    const { payload, idempotencyKey, userId, identityId, correlationId, ...result } = job;
    return result;
  }
  async get(userId: string, id: string) {
    const [job] = await this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.userId, userId), eq(jobs.id, id)));
    if (!job) throw missing();
    return this.compact(job);
  }
  async cancel(userId: string, id: string) {
    await this.get(userId, id);
    await this.db
      .update(jobs)
      .set({ cancelRequested: true })
      .where(
        and(eq(jobs.userId, userId), eq(jobs.id, id), inArray(jobs.state, ['queued', 'running'])),
      );
    return this.get(userId, id);
  }
  private async tick() {
    if (this.stopping || this.polling || this.active.size >= this.concurrency) return;
    this.polling = true;
    try {
      const job = await this.db.transaction(async (tx) => {
        const [j] = await tx
          .select()
          .from(jobs)
          .where(eq(jobs.state, 'queued'))
          .orderBy(jobs.createdAt)
          .limit(1)
          .for('update', { skipLocked: true });
        if (!j) return;
        await tx
          .update(jobs)
          .set({ state: 'running', startedAt: new Date(), error: null, completed: 0, failed: 0 })
          .where(eq(jobs.id, j.id));
        return j;
      });
      if (!job) return;
      const promise = this.run(job).catch(() =>
        log.error(
          { jobId: job.id, correlationId: job.correlationId },
          'Job state persistence failed; restart will recover it',
        ),
      );
      this.active.add(promise);
      void promise.finally(() => this.active.delete(promise));
    } finally {
      this.polling = false;
    }
  }
  private async run(job: Job) {
    const checkCancelled = async () => {
      const [current] = await this.db
        .select({ cancel: jobs.cancelRequested })
        .from(jobs)
        .where(eq(jobs.id, job.id));
      if (!current || current.cancel) throw new DomainError('cancelled', 'Job cancelled');
      if (this.stopping) throw new DomainError('interrupted', 'Service is stopping');
    };
    try {
      await checkCancelled();
      const handler = this.handlers.get(job.type);
      if (!handler) throw new Error('missing handler');
      const result = await handler(job, {
        checkCancelled,
        progress: async (completed, total, failed = 0, result) => {
          await checkCancelled();
          await this.db
            .update(jobs)
            .set({ completed, total, failed, ...(result === undefined ? {} : { result }) })
            .where(eq(jobs.id, job.id));
        },
      });
      await checkCancelled();
      await this.db
        .update(jobs)
        .set({ state: 'succeeded', result, finishedAt: new Date() })
        .where(eq(jobs.id, job.id));
      metric('jobs_succeeded');
    } catch (e) {
      const interrupted = e instanceof DomainError && e.code === 'interrupted';
      await this.db
        .update(jobs)
        .set({
          state: interrupted
            ? 'queued'
            : e instanceof DomainError && e.code === 'cancelled'
              ? 'cancelled'
              : 'failed',
          error: safeError(e),
          finishedAt: interrupted ? null : new Date(),
        })
        .where(eq(jobs.id, job.id));
      metric('jobs_failed');
      log.warn(
        {
          jobId: job.id,
          correlationId: job.correlationId,
          code: e instanceof DomainError ? e.code : 'internal',
        },
        'Job stopped',
      );
    }
  }
  async close() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.all(this.active);
    if (this.lease) {
      await this.lease.query('select pg_advisory_unlock(624681903)');
      this.lease.release();
      this.lease = undefined;
    }
  }
}
