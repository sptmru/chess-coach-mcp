import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { DB } from '../database/client.js';
import { analysisRuns, moves, moveAnalyses, criticalPositions } from '../database/schema.js';
import type { EnginePool } from '../stockfish/engine.js';
import type { EngineConfig, AnalyzedMove, Color, EngineResult } from '../domain/types.js';
import {
  ALGORITHM_VERSION,
  centipawnLoss,
  groupCritical,
  transitions,
  severity,
  perspective,
  state,
} from '../analysis/evaluation.js';
import { hash, missing } from '../utils/core.js';
import type { GameService } from './games.js';
import { Chess } from 'chess.js';
export class AnalysisService {
  private inflight = new Map<string, Promise<{ runId: string; reused: boolean }>>();
  constructor(
    readonly db: DB,
    readonly games: GameService,
    readonly engine: EnginePool,
  ) {}
  config(options?: Partial<EngineConfig>): EngineConfig {
    return {
      depth: options?.depth ?? this.engine.config.ANALYSIS_DEPTH,
      multiPv: options?.multiPv ?? Math.min(3, this.engine.config.MAX_MULTIPV),
    };
  }
  metadata(options: EngineConfig) {
    return {
      depth: options.depth,
      multiPv: options.multiPv,
      threads: this.engine.config.ENGINE_THREADS,
      hashMb: this.engine.config.ENGINE_HASH_MB,
      platform: `${process.platform}/${process.arch}`,
      binaryHash: this.engine.binaryHash,
    };
  }
  compatibility(options: EngineConfig) {
    return hash({
      config: this.metadata(options),
      engine: this.engine.version,
      algorithm: ALGORITHM_VERSION,
    });
  }
  async analyze(
    userId: string,
    identityId: string,
    gameId: string,
    options: EngineConfig,
    checkCancelled: () => Promise<void> = async () => {},
  ) {
    await this.games.require(userId, identityId, gameId);
    const key = hash({ gameId, options });
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const work = this.calculate(userId, identityId, gameId, options, checkCancelled);
    this.inflight.set(key, work);
    try {
      return await work;
    } finally {
      this.inflight.delete(key);
    }
  }
  private async calculate(
    userId: string,
    identityId: string,
    gameId: string,
    options: EngineConfig,
    checkCancelled: () => Promise<void>,
  ) {
    const { game } = await this.games.require(userId, identityId, gameId);
    const fingerprint = hash({
      game: game.id,
      contentHash: game.contentHash,
      compatibility: this.compatibility(options),
    });
    const [cached] = await this.db
      .select()
      .from(analysisRuns)
      .where(and(eq(analysisRuns.fingerprint, fingerprint), eq(analysisRuns.status, 'completed')));
    if (cached) return { runId: cached.id, reused: true };
    const facts = await this.db
      .select()
      .from(moves)
      .where(eq(moves.gameId, gameId))
      .orderBy(moves.ply);
    const analyzed: AnalyzedMove[] = [];
    let previous: EngineResult | undefined;
    for (const m of facts) {
      await checkCancelled();
      const before = previous ?? (await this.engine.analyze(m.fenBefore, options));
      const after = await this.engine.analyze(m.fenAfter, options);
      previous = after;
      const color = m.color as Color,
        cpl = centipawnLoss(before.lines[0].score, after.lines[0].score, color);
      const t = transitions(before.lines[0].score, after.lines[0].score, color, cpl);
      const opponentLast = analyzed.at(-1);
      if (
        opponentLast &&
        (opponentLast.cpl ?? 0) >= 100 &&
        state(perspective(before.lines[0].score, color)) === 'winning' &&
        state(perspective(after.lines[0].score, color)) !== 'winning'
      )
        t.push('failure_to_punish');
      const second = before.lines[1];
      if (
        second &&
        state(perspective(before.lines[0].score, color)) !== 'losing' &&
        state(perspective(second.score, color)) === 'losing'
      )
        t.push('only_move');
      analyzed.push({
        ...m,
        color,
        phase: m.phase as AnalyzedMove['phase'],
        before: before.lines[0].score,
        after: after.lines[0].score,
        cpl,
        bestMove: before.bestMove,
        alternatives: before.lines,
        transitions: t,
        severity: severity(before.lines[0].score, after.lines[0].score, color, cpl),
      });
    }
    await checkCancelled();
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .insert(analysisRuns)
        .values({
          gameId,
          fingerprint,
          engineVersion: this.engine.version,
          algorithmVersion: ALGORITHM_VERSION,
          config: this.metadata(options),
          status: 'completed',
          completedAt: new Date(),
        })
        .onConflictDoNothing()
        .returning();
      if (!run) {
        const [existing] = await tx
          .select()
          .from(analysisRuns)
          .where(eq(analysisRuns.fingerprint, fingerprint));
        return { runId: existing.id, reused: true };
      }
      if (analyzed.length)
        await tx.insert(moveAnalyses).values(
          analyzed.map((m) => ({
            runId: run.id,
            ply: m.ply,
            color: m.color,
            cpl: m.cpl,
            phase: m.phase,
            severity: m.severity,
            facts: m,
          })),
        );
      const groups = groupCritical(analyzed);
      if (groups.length)
        await tx.insert(criticalPositions).values(
          groups.map((g) => ({
            runId: run.id,
            gameId,
            color: g.color,
            ply: g.representativePly,
            severity: g.severity,
            group: g,
          })),
        );
      return { runId: run.id, reused: false };
    });
  }
  async latest(gameId: string, runId?: string) {
    const [run] = await this.db
      .select()
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.gameId, gameId),
          eq(analysisRuns.status, 'completed'),
          runId ? eq(analysisRuns.id, runId) : undefined,
        ),
      )
      .orderBy(desc(analysisRuns.createdAt), desc(analysisRuns.id))
      .limit(1);
    return run;
  }
  async critical(
    userId: string,
    identityId: string | undefined,
    gameId: string,
    runId?: string,
    limit = 20,
    offset = 0,
    detail: 'summary' | 'standard' | 'full' = 'summary',
    compatibleOnly = false,
  ) {
    const { color, game } = await this.games.require(userId, identityId, gameId);
    const run = compatibleOnly
      ? await this.latestCompatible(game, runId)
      : await this.latest(gameId, runId);
    if (!run) return { items: [], warning: 'Game has not been analyzed' };
    const positions = await this.db
      .select({ position: criticalPositions, facts: moveAnalyses.facts })
      .from(criticalPositions)
      .innerJoin(
        moveAnalyses,
        and(
          eq(moveAnalyses.runId, criticalPositions.runId),
          eq(moveAnalyses.ply, criticalPositions.ply),
        ),
      )
      .where(and(eq(criticalPositions.runId, run.id), eq(criticalPositions.color, color)))
      .orderBy(asc(criticalPositions.ply))
      .limit(limit + 1)
      .offset(offset);
    const surrounding =
      detail === 'summary'
        ? []
        : await this.db
            .select({ ply: moves.ply, san: moves.san })
            .from(moves)
            .where(eq(moves.gameId, gameId))
            .orderBy(moves.ply);
    return {
      runId: run.id,
      opening: { name: game.opening, eco: game.eco, variation: game.variation },
      analysisVersion: this.version(run),
      items: positions.slice(0, limit).map(({ position: p, facts: m }) => ({
        id: p.id,
        ply: p.ply,
        moveNumber: m.moveNumber,
        fen: m.fenBefore,
        playedMove: m.uci,
        bestMove: m.bestMove,
        cpl: m.cpl,
        before: perspective(m.before, m.color),
        after: perspective(m.after, m.color),
        perspective: m.color,
        severity: p.severity,
        phase: m.phase,
        clock: m.clockAfter,
        clockBefore: m.clockBefore,
        thinkTime: m.thinkTime,
        transitions: m.transitions,
        contributingPlies: p.group.plies,
        ...(detail === 'summary'
          ? {}
          : {
              alternatives: m.alternatives.map((l) => ({
                ...l,
                score: perspective(l.score, m.color),
                pv: l.pv.slice(0, detail === 'full' ? 24 : 8),
              })),
              surrounding: surrounding.filter((x) => Math.abs(x.ply - p.ply) <= 4),
            }),
      })),
      nextOffset: positions.length > limit ? offset + limit : null,
    };
  }
  async latestCompatible(game: { id: string; contentHash: string }, runId?: string) {
    const candidates = await this.db
      .select()
      .from(analysisRuns)
      .where(
        and(
          eq(analysisRuns.gameId, game.id),
          eq(analysisRuns.status, 'completed'),
          eq(analysisRuns.engineVersion, this.engine.version),
          eq(analysisRuns.algorithmVersion, ALGORITHM_VERSION),
          runId ? eq(analysisRuns.id, runId) : undefined,
        ),
      )
      .orderBy(desc(analysisRuns.createdAt), desc(analysisRuns.id));
    // Keep the run's depth/MultiPV, but require the current engine, algorithm and runtime settings.
    return candidates.find(
      (run) =>
        run.fingerprint ===
        hash({
          game: game.id,
          contentHash: game.contentHash,
          compatibility: this.compatibility(run.config),
        }),
    );
  }
  version(run: typeof analysisRuns.$inferSelect) {
    return {
      engine: run.engineVersion,
      algorithm: run.algorithmVersion,
      ...run.config,
      key: hash({ engine: run.engineVersion, algorithm: run.algorithmVersion, config: run.config }),
    };
  }
  async position(userId: string, identityId: string | undefined, id: string) {
    const [p] = await this.db.select().from(criticalPositions).where(eq(criticalPositions.id, id));
    if (!p) throw missing();
    const authorized = await this.games.require(userId, identityId, p.gameId);
    if (authorized.color !== p.color) throw missing();
    const [m] = await this.db
      .select()
      .from(moveAnalyses)
      .where(and(eq(moveAnalyses.runId, p.runId), eq(moveAnalyses.ply, p.ply)));
    const surrounding = await this.db
      .select({ ply: moves.ply, san: moves.san })
      .from(moves)
      .where(
        and(eq(moves.gameId, p.gameId), sql`${moves.ply} between ${p.ply - 4} and ${p.ply + 3}`),
      )
      .orderBy(moves.ply);
    return { position: p, move: m.facts, ...authorized, surrounding };
  }
  async compare(fen: string, move: string, options: EngineConfig) {
    const board = new Chess(fen);
    const color = board.turn();
    const played = board.move(move);
    const uci = played.from + played.to + (played.promotion ?? '');
    const best = await this.engine.analyze(fen, options);
    const chosen = await this.engine.analyze(fen, options, uci);
    return {
      playedMove: uci,
      bestMove: best.bestMove,
      before: perspective(best.lines[0].score, color),
      after: perspective(chosen.lines[0].score, color),
      cpl: centipawnLoss(best.lines[0].score, chosen.lines[0].score, color),
      pv: chosen.lines[0].pv.slice(0, 8),
      perspective: color,
      analysisVersion: {
        engine: this.engine.version,
        algorithm: ALGORITHM_VERSION,
        ...this.metadata(options),
      },
    };
  }
}
