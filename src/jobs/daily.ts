import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { DB } from '../database/client.js';
import { identities, jobs } from '../database/schema.js';
import type { AnalysisService } from '../services/analysis.js';
import type { GameService } from '../services/games.js';
import type { SemanticService } from '../services/semantics.js';
import { DomainError, log } from '../utils/core.js';
import { analysisHandler } from './analysis.js';
import type { JobHandler, JobQueue } from './queue.js';

export const DAILY_JOB_TYPE = 'daily_analysis_classification';
const clock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Yerevan',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

// One run for yesterday, due from 03:00 until the end of the local calendar day.
// Armenia observes UTC+04:00 year-round; the host/container timezone is irrelevant.
export function dailyPeriod(now: Date) {
  const parts = Object.fromEntries(clock.formatToParts(now).map((p) => [p.type, p.value]));
  if (Number(parts.hour) < 3) return null;
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const previous = new Date(`${today}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const date = previous.toISOString().slice(0, 10);
  return {
    date,
    since: new Date(`${date}T00:00:00+04:00`).toISOString(),
    until: new Date(new Date(`${today}T00:00:00+04:00`).getTime() - 1).toISOString(),
  };
}

export class DailyAnalysisScheduler {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private stopping = false;
  private date?: string;
  private submitted = new Set<string>();
  constructor(
    private db: DB,
    private queue: JobQueue,
    private config: Config,
    private analysis: AnalysisService,
    private semantics: SemanticService,
  ) {}

  start() {
    if (!this.config.DAILY_ANALYSIS_ENABLED || this.timer) return;
    this.stopping = false;
    const poll = () => {
      if (this.active || this.stopping || !this.queue.isRunning) return;
      this.active = this.tick()
        .catch(() => log.error('Daily analysis scheduling failed'))
        .finally(() => {
          this.active = undefined;
        });
    };
    poll();
    this.timer = setInterval(poll, 30_000);
    this.timer.unref();
    log.info({ timeZone: 'Asia/Yerevan', hour: 3 }, 'Daily analysis scheduler started');
  }

  async tick(now = new Date()) {
    if (!this.config.DAILY_ANALYSIS_ENABLED || this.stopping || !this.queue.isRunning) return;
    const period = dailyPeriod(now);
    if (!period) return;
    if (this.date !== period.date) {
      this.date = period.date;
      this.submitted.clear();
    }
    const owners = await this.db
      .select()
      .from(identities)
      .where(eq(identities.provider, 'chesscom'));
    const reasoner = this.semantics.resolveReasoner();
    for (const owner of owners) {
      if (this.stopping || !this.queue.isRunning) return;
      if (this.submitted.has(owner.id)) continue;
      try {
        const job = await this.queue.enqueue(
          owner.userId,
          owner.id,
          DAILY_JOB_TYPE,
          {
            ...period,
            options: this.analysis.config(),
            provider: reasoner.provider,
            model: reasoner.model,
            positionsPerGame: this.config.DAILY_ANALYSIS_POSITIONS_PER_GAME,
            maxGames: this.config.MAX_BATCH_ANALYSIS_GAMES,
          },
          period.date,
          randomUUID(),
        );
        this.submitted.add(owner.id);
        log.info(
          { jobId: job.id, date: period.date, state: job.state },
          'Daily analysis scheduled',
        );
      } catch (error) {
        // Capacity failures are retried on the next tick; do not starve other users.
        log.warn(
          {
            identityId: owner.id,
            date: period.date,
            code: error instanceof DomainError ? error.code : 'internal',
          },
          'Daily analysis enqueue failed',
        );
      }
    }
  }

  async close() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
}

export function dailyAnalysisHandler(
  db: DB,
  games: GameService,
  analysis: AnalysisService,
  semantics: SemanticService,
): JobHandler {
  const pipeline = analysisHandler(analysis, semantics);
  return async (job, control) => {
    const { since, until, date } = job.payload as { since: string; until: string; date: string };
    let payload = job.payload;
    semantics.resolveReasoner(payload.provider as string, payload.model as string);
    if (!Array.isArray(payload.gameIds)) {
      await control.checkCancelled();
      const sync = await games.sync(
        job.userId,
        job.identityId,
        2,
        async () => {
          await control.checkCancelled();
        },
        control.checkCancelled,
        { since, until },
      );
      if (sync.failed)
        throw new DomainError('sync_failed', 'Daily game sync was incomplete; retry the period');
      await control.checkCancelled();
      const gameIds = await games.selectBatch(
        job.userId,
        job.identityId,
        { since, until, timeControl: 'rapid' },
        payload.maxGames as number,
      );
      payload = { ...payload, gameIds };
      // Persist the selection before analysis so a delayed restart uses the same day and games.
      await db.update(jobs).set({ payload }).where(eq(jobs.id, job.id));
    }
    const result = await pipeline({ ...job, type: 'analysis_classification', payload }, control);
    return {
      ...(result as Record<string, unknown>),
      date,
      since,
      until,
      ...(Array.isArray(payload.gameIds) && !payload.gameIds.length
        ? { skipped: 'no_matching_games' }
        : {}),
    };
  };
}
