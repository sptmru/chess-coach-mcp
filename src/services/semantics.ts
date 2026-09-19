import { and, desc, eq } from 'drizzle-orm';
import type { DB } from '../database/client.js';
import { classifications } from '../database/schema.js';
import type { AnalysisService } from './analysis.js';
import {
  features,
  MockReasoner,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  TAXONOMY_VERSION,
  classificationSchema,
  type PositionReasoner,
} from '../semantics/reasoner.js';
import { DomainError, hash, safeError } from '../utils/core.js';
export class SemanticService {
  private inflight = new Map<string, Promise<unknown>>();
  constructor(
    readonly db: DB,
    readonly analysis: AnalysisService,
    readonly configured: PositionReasoner,
  ) {}
  approved() {
    return [
      ...new Map([new MockReasoner(), this.configured].map((r) => [r.provider, r])).values(),
    ].map((r) => ({ provider: r.provider, model: r.model }));
  }
  async classify(
    userId: string,
    identityId: string | undefined,
    positionId: string,
    provider?: string,
    model?: string,
  ) {
    const p = await this.analysis.position(userId, identityId, positionId);
    const r: PositionReasoner = provider === 'mock' ? new MockReasoner() : this.configured;
    if ((provider && r.provider !== provider) || (model && r.model !== model))
      throw new DomainError('provider_not_allowed', 'Choose a server-approved provider and model');
    const context = {
      move: p.move,
      features: features(p.move),
      opening: p.game.opening,
      surrounding: p.surrounding,
    };
    const fingerprint = hash({
      positionId,
      context,
      provider: r.provider,
      model: r.model,
      prompt: PROMPT_VERSION,
      taxonomy: TAXONOMY_VERSION,
      schema: SCHEMA_VERSION,
    });
    const key = `${userId}/${p.identity.id}/${fingerprint}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const work = (async () => {
      const condition = and(
        eq(classifications.userId, userId),
        eq(classifications.identityId, p.identity.id),
        eq(classifications.fingerprint, fingerprint),
      );
      const [cached] = await this.db.select().from(classifications).where(condition);
      if (cached?.status === 'succeeded') return this.compact(cached);
      const start = Date.now();
      try {
        const result = await r.classify(context);
        const c = classificationSchema.parse(result.classification);
        const value = {
          userId,
          identityId: p.identity.id,
          positionId,
          fingerprint,
          provider: r.provider,
          model: r.model,
          promptVersion: PROMPT_VERSION,
          taxonomyVersion: TAXONOMY_VERSION,
          schemaVersion: SCHEMA_VERSION,
          primary: c.primary,
          secondary: c.secondary,
          confidence: c.confidence,
          normalized: c,
          raw: result.raw,
          usage: result.usage,
          cost: result.cost,
          latencyMs: Date.now() - start,
          status: 'succeeded',
          error: null,
        };
        const [saved] = await this.db
          .insert(classifications)
          .values(value)
          .onConflictDoUpdate({
            target: [
              classifications.userId,
              classifications.identityId,
              classifications.fingerprint,
            ],
            set: value,
          })
          .returning();
        return this.compact(saved);
      } catch (e) {
        await this.db
          .insert(classifications)
          .values({
            userId,
            identityId: p.identity.id,
            positionId,
            fingerprint,
            provider: r.provider,
            model: r.model,
            promptVersion: PROMPT_VERSION,
            taxonomyVersion: TAXONOMY_VERSION,
            schemaVersion: SCHEMA_VERSION,
            status: 'failed',
            latencyMs: Date.now() - start,
            error: safeError(e),
          })
          .onConflictDoNothing();
        throw e;
      }
    })();
    this.inflight.set(key, work);
    try {
      return await work;
    } finally {
      this.inflight.delete(key);
    }
  }
  compact(c: typeof classifications.$inferSelect) {
    return {
      id: c.id,
      positionId: c.positionId,
      provider: c.provider,
      model: c.model,
      classification: c.normalized,
      taxonomyVersion: c.taxonomyVersion,
      promptVersion: c.promptVersion,
      status: c.status,
      latencyMs: c.latencyMs,
      createdAt: c.createdAt,
    };
  }
  async list(userId: string, identityId: string | undefined, positionId: string) {
    const p = await this.analysis.position(userId, identityId, positionId);
    return {
      items: (
        await this.db
          .select()
          .from(classifications)
          .where(
            and(
              eq(classifications.userId, userId),
              eq(classifications.identityId, p.identity.id),
              eq(classifications.positionId, positionId),
            ),
          )
          .orderBy(desc(classifications.createdAt))
          .limit(20)
      ).map((c) => this.compact(c)),
      warning: 'Provider outputs are hypotheses; agreement does not establish ground truth',
    };
  }
}
