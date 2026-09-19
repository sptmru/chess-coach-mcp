import { and, desc, eq, sql } from 'drizzle-orm';
import { Chess } from 'chess.js';
import type { DB } from '../database/client.js';
import { exercises, trainingSets, setExercises, attempts } from '../database/schema.js';
import type { ReportService } from '../services/reports.js';
import type { SemanticService } from '../services/semantics.js';
import { perspective } from '../analysis/evaluation.js';
import { DomainError, hash, missing } from '../utils/core.js';
export type TrainingCriteria = {
  count?: number;
  theme?: string;
  since?: string;
  timeControl?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  pattern?: string;
  sourcePeriod?: { since: string; until: string };
  targetPattern?: string;
};
export const publicExercise = (e: typeof exercises.$inferSelect) => ({
  exerciseId: e.id,
  version: e.version,
  fen: e.fen,
  sideToMove: e.sideToMove,
  promptType: 'find_best_move',
  difficulty: e.difficulty,
});
export class TrainingService {
  constructor(
    readonly db: DB,
    readonly reports: ReportService,
    readonly semantics: SemanticService,
  ) {}
  async generate(userId: string, identityId: string | undefined, criteria: TrainingCriteria = {}) {
    const d = await this.reports.dataset(userId, identityId, {
      since: criteria.since,
      ...criteria.sourcePeriod,
      timeControl: criteria.timeControl,
    });
    const theme = criteria.theme ?? criteria.pattern ?? criteria.targetPattern;
    const candidates = d.ownPositions
      .filter(
        (p) =>
          p.severity >= 100 &&
          (!theme || d.evidence.some((e) => e.id === p.id && e.type === theme)),
      )
      .sort((a, b) => b.severity - a.severity);
    const result: ReturnType<typeof publicExercise>[] = [];
    for (const p of candidates) {
      if (result.length >= (criteria.count ?? 5)) break;
      const m = d.samples.find((g) => g.id === p.gameId)!.moves.find((m) => m.ply === p.ply)!;
      if (!m.bestMove) continue;
      const difficulty = m.severity >= 300 ? 'easy' : m.severity >= 180 ? 'medium' : 'hard';
      if (criteria.difficulty && criteria.difficulty !== difficulty) continue;
      const labels = await this.semantics.list(userId, d.identity.id, p.id);
      const solution = {
        bestMove: m.bestMove,
        playedMove: m.uci,
        evaluationBefore: perspective(m.before, m.color),
        evaluationAfter: perspective(m.after, m.color),
        cpl: m.cpl,
        pv: m.alternatives[0]?.pv ?? [],
        semanticClassifications: labels.items,
        sourceGame: { id: p.gameId, ply: p.ply },
        analysisVersion: d.metadata.analysisVersion,
      };
      const version = hash({ runId: p.runId, solution });
      const [created] = await this.db
        .insert(exercises)
        .values({
          userId,
          identityId: d.identity.id,
          positionId: p.id,
          version,
          fen: m.fenBefore,
          sideToMove: m.color === 'w' ? 'white' : 'black',
          difficulty,
          solution,
        })
        .onConflictDoNothing()
        .returning();
      const saved =
        created ??
        (
          await this.db
            .select()
            .from(exercises)
            .where(
              and(
                eq(exercises.userId, userId),
                eq(exercises.identityId, d.identity.id),
                eq(exercises.positionId, p.id),
                eq(exercises.version, version),
              ),
            )
        )[0];
      result.push(publicExercise(saved));
    }
    return {
      items: result,
      requested: criteria.count ?? 5,
      available: result.length,
      warnings: [
        ...d.metadata.warnings,
        ...(result.length < (criteria.count ?? 5)
          ? ['Not enough matching critical positions']
          : []),
      ],
      difficultyMethod: 'CPL-based heuristic; not a calibrated puzzle rating',
    };
  }
  async requireExercise(userId: string, id: string) {
    const [e] = await this.db
      .select()
      .from(exercises)
      .where(and(eq(exercises.userId, userId), eq(exercises.id, id)));
    if (!e) throw missing();
    return e;
  }
  async solution(userId: string, id: string) {
    const e = await this.requireExercise(userId, id);
    return { exerciseId: e.id, version: e.version, ...e.solution };
  }
  async createSet(userId: string, identityId: string | undefined, criteria: TrainingCriteria) {
    const i = await this.reports.games.identity.require(userId, identityId);
    const generated = await this.generate(userId, i.id, criteria);
    const set = await this.db.transaction(async (tx) => {
      const [s] = await tx
        .insert(trainingSets)
        .values({ userId, identityId: i.id, theme: criteria.theme, criteria })
        .returning();
      if (generated.items.length)
        await tx
          .insert(setExercises)
          .values(
            generated.items.map((e, n) => ({ setId: s.id, exerciseId: e.exerciseId, ordinal: n })),
          );
      return s;
    });
    return { trainingSetId: set.id, ...generated };
  }
  async set(userId: string, id: string) {
    const [set] = await this.db
      .select()
      .from(trainingSets)
      .where(and(eq(trainingSets.userId, userId), eq(trainingSets.id, id)));
    if (!set) throw missing();
    const items = await this.db
      .select({ exercise: exercises })
      .from(setExercises)
      .innerJoin(
        exercises,
        and(eq(exercises.id, setExercises.exerciseId), eq(exercises.userId, userId)),
      )
      .where(eq(setExercises.setId, id))
      .orderBy(setExercises.ordinal);
    return {
      trainingSetId: id,
      theme: set.theme,
      createdAt: set.createdAt,
      items: items.map((i) => publicExercise(i.exercise)),
    };
  }
  async record(
    userId: string,
    input: {
      exerciseId: string;
      idempotencyKey: string;
      result: 'solved' | 'failed' | 'partial';
      timeSpent?: number;
      attemptedMove?: string;
      notes?: string;
    },
  ) {
    const e = await this.requireExercise(userId, input.exerciseId);
    if (input.attemptedMove) {
      try {
        new Chess(e.fen).move(input.attemptedMove);
      } catch {
        throw new DomainError(
          'invalid_move',
          'Attempted move is not legal in the exercise position',
        );
      }
    }
    const [created] = await this.db
      .insert(attempts)
      .values({ ...input, userId, identityId: e.identityId, exerciseVersion: e.version })
      .onConflictDoNothing()
      .returning();
    const saved =
      created ??
      (
        await this.db
          .select()
          .from(attempts)
          .where(
            and(eq(attempts.userId, userId), eq(attempts.idempotencyKey, input.idempotencyKey)),
          )
      )[0];
    if (
      saved.exerciseId !== input.exerciseId ||
      saved.result !== input.result ||
      saved.timeSpent !== (input.timeSpent ?? null) ||
      saved.attemptedMove !== (input.attemptedMove ?? null) ||
      saved.notes !== (input.notes ?? null)
    )
      throw new DomainError(
        'idempotency_conflict',
        'Idempotency key already used for a different attempt',
      );
    return {
      attemptId: saved.id,
      exerciseId: saved.exerciseId,
      result: saved.result,
      createdAt: saved.createdAt,
    };
  }
  async progress(userId: string, identityId: string | undefined, limit = 20, offset = 0) {
    const i = await this.reports.games.identity.require(userId, identityId);
    const where = and(eq(attempts.userId, userId), eq(attempts.identityId, i.id));
    const counts = await this.db
      .select({
        result: attempts.result,
        attempts: sql<number>`count(*)::int`,
        exercises: sql<number>`count(distinct ${attempts.exerciseId})::int`,
      })
      .from(attempts)
      .where(where)
      .groupBy(attempts.result);
    const recent = await this.db
      .select({
        id: attempts.id,
        exerciseId: attempts.exerciseId,
        result: attempts.result,
        timeSpent: attempts.timeSpent,
        createdAt: attempts.createdAt,
      })
      .from(attempts)
      .where(where)
      .orderBy(desc(attempts.createdAt), desc(attempts.id))
      .limit(limit + 1)
      .offset(offset);
    return {
      counts,
      items: recent.slice(0, limit),
      nextOffset: recent.length > limit ? offset + limit : null,
    };
  }
}
