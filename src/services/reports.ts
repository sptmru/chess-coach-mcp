import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DB } from '../database/client.js';
import {
  analysisRuns,
  moveAnalyses,
  criticalPositions,
  classifications,
  patterns,
} from '../database/schema.js';
import type { GameService, GameFilters } from './games.js';
import type { AnalysisService } from './analysis.js';
import { perspective, state } from '../analysis/evaluation.js';
import { detectPatterns, type PatternEvidence } from '../patterns/aggregate.js';
import { categories } from '../semantics/reasoner.js';
export const mean = (v: number[]) => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null);
export function median(v: number[]) {
  const a = [...v].sort((a, b) => a - b);
  return a.length
    ? a.length % 2
      ? a[Math.floor(a.length / 2)]
      : (a[a.length / 2 - 1] + a[a.length / 2]) / 2
    : null;
}
export type ReportFilters = GameFilters & { analysisKey?: string };
export class ReportService {
  constructor(
    readonly db: DB,
    readonly games: GameService,
    readonly analysis: AnalysisService,
  ) {}
  async dataset(userId: string, identityId: string | undefined, filters: ReportFilters = {}) {
    const identity = await this.games.identity.require(userId, identityId);
    const page = await this.games.list(userId, identity.id, { ...filters, limit: 100 });
    const selected = page.items;
    const runs = selected.length
      ? await this.db
          .select()
          .from(analysisRuns)
          .where(
            and(
              inArray(
                analysisRuns.gameId,
                selected.map((g) => g.id),
              ),
              eq(analysisRuns.status, 'completed'),
            ),
          )
          .orderBy(desc(analysisRuns.createdAt), desc(analysisRuns.id))
      : [];
    const key = filters.analysisKey ?? (runs[0] ? this.analysis.version(runs[0]).key : null);
    const chosen = new Map<string, (typeof runs)[number]>();
    for (const r of runs)
      if (!chosen.has(r.gameId) && this.analysis.version(r).key === key) chosen.set(r.gameId, r);
    const runIds = [...chosen.values()].map((r) => r.id);
    const measured = runIds.length
      ? await this.db.select().from(moveAnalyses).where(inArray(moveAnalyses.runId, runIds))
      : [];
    const samples = selected
      .filter((g) => chosen.has(g.id))
      .map((g) => ({
        ...g,
        runId: chosen.get(g.id)!.id,
        moves: measured
          .filter((m) => m.runId === chosen.get(g.id)!.id && m.color === g.color)
          .map((m) => m.facts),
      }));
    const positions = runIds.length
      ? await this.db
          .select()
          .from(criticalPositions)
          .where(inArray(criticalPositions.runId, runIds))
      : [];
    const ownPositions = positions.filter((p) =>
      samples.some((s) => s.id === p.gameId && s.color === p.color),
    );
    const labels = ownPositions.length
      ? await this.db
          .select()
          .from(classifications)
          .where(
            and(
              eq(classifications.userId, userId),
              eq(classifications.identityId, identity.id),
              inArray(
                classifications.positionId,
                ownPositions.map((p) => p.id),
              ),
              eq(classifications.status, 'succeeded'),
            ),
          )
          .orderBy(desc(classifications.createdAt))
      : [];
    const byPosition = new Map<string, (typeof labels)[number]>();
    for (const l of labels) if (!byPosition.has(l.positionId)) byPosition.set(l.positionId, l);
    const evidence: PatternEvidence[] = [];
    for (const p of ownPositions) {
      const l = byPosition.get(p.id);
      if (!l) continue;
      const g = samples.find((g) => g.id === p.gameId)!;
      const m = g.moves.find((m) => m.ply === p.ply)!;
      for (const type of [l.primary, ...(l.secondary ?? [])]) {
        if (!type || categories.unknown.includes(type as 'unclear')) continue;
        evidence.push({
          id: p.id,
          gameId: p.gameId,
          date: g.date.toISOString(),
          type,
          severity: p.severity,
          confidence: l.confidence ?? 0,
          phase: m.phase,
          clock: m.clockBefore,
        });
      }
    }
    return {
      identity,
      samples,
      ownPositions,
      evidence,
      metadata: {
        sampleGames: samples.length,
        availableGames: selected.length,
        unanalysedOrIncompatible: selected.length - samples.length,
        analysisKey: key,
        analysisVersion: chosen.size ? this.analysis.version([...chosen.values()][0]) : null,
        filters,
        boundaries: { newest: selected[0]?.date ?? null, oldest: selected.at(-1)?.date ?? null },
        warnings: [
          ...(page.nextCursor ? ['Report capped at 100 games; narrow the date range'] : []),
          ...(selected.length !== samples.length
            ? ['Some games are unanalysed or use incompatible settings']
            : []),
          ...(samples.length < 10
            ? ['Small sample; avoid interpreting changes as established improvement']
            : []),
        ],
        truncated: !!page.nextCursor,
      },
    };
  }
  async report(userId: string, identityId: string | undefined, filters: ReportFilters = {}) {
    const d = await this.dataset(userId, identityId, filters);
    const all = d.samples.flatMap((g) => g.moves),
      cp = all.flatMap((m) => (m.cpl === null ? [] : [m.cpl]));
    const phase = Object.fromEntries(
      ['opening', 'middlegame', 'endgame'].map((p) => {
        const ms = all.filter((m) => m.phase === p);
        return [
          p,
          {
            moves: ms.length,
            acpl: mean(ms.flatMap((m) => (m.cpl === null ? [] : [m.cpl]))),
            majorMistakes: ms.filter((m) => m.severity >= 200).length,
          },
        ];
      }),
    );
    const won = (g: (typeof d.samples)[number]) => g.result === (g.color === 'w' ? '1-0' : '0-1');
    const advantaged = d.samples.filter((g) =>
      g.moves.some((m) => state(perspective(m.before, m.color)) === 'winning'),
    );
    const groups = Object.fromEntries(
      Object.entries(categories)
        .filter(([k]) => k !== 'unknown')
        .map(([k, v]) => [
          k,
          new Set(
            d.evidence.filter((e) => (v as readonly string[]).includes(e.type)).map((e) => e.id),
          ).size,
        ]),
    );
    return {
      ...d.metadata,
      gamesAnalyzed: d.samples.length,
      movesAnalyzed: all.length,
      meanCpl: mean(cp),
      medianCpl: median(cp),
      mateTransitionsExcludedFromCpl: all.length - cp.length,
      majorMistakesPerGame: d.samples.length
        ? all.filter((m) => m.severity >= 200).length / d.samples.length
        : null,
      groupedCriticalPositions: d.ownPositions.length,
      phases: phase,
      semanticGroups: groups,
      semanticClassifiedPositions: new Set(d.evidence.map((e) => e.id)).size,
      conversion: {
        advantagedGames: advantaged.length,
        wins: advantaged.filter(won).length,
        rate: advantaged.length ? advantaged.filter(won).length / advantaged.length : null,
        thrownAdvantages: d.samples.filter((g) =>
          g.moves.some((m) =>
            m.transitions.some((t) => t === 'winning_to_equal' || t === 'winning_to_losing'),
          ),
        ).length,
      },
      ratingSnapshot: d.samples[0]
        ? d.samples[0].color === 'w'
          ? d.samples[0].whiteRating
          : d.samples[0].blackRating
        : null,
    };
  }
  async mistakePatterns(
    userId: string,
    identityId: string | undefined,
    filters: ReportFilters = {},
    minimum = 3,
  ) {
    const d = await this.dataset(userId, identityId, filters);
    const result = detectPatterns(
      d.evidence,
      d.samples.map((g) => ({ id: g.id, date: g.date.toISOString() })),
      minimum,
    );
    await this.db.transaction(async (tx) => {
      await tx
        .delete(patterns)
        .where(
          and(
            eq(patterns.userId, userId),
            eq(patterns.identityId, d.identity.id),
            eq(patterns.analysisKey, d.metadata.analysisKey ?? 'none'),
          ),
        );
      if (result.length)
        await tx.insert(patterns).values(
          result.map((p) => ({
            userId,
            identityId: d.identity.id,
            type: p.type,
            analysisKey: d.metadata.analysisKey ?? 'none',
            evidence: p,
          })),
        );
    });
    return {
      ...d.metadata,
      items: result,
      status:
        d.samples.length < minimum || new Set(d.evidence.map((e) => e.id)).size < minimum
          ? 'insufficient_data'
          : result.some((p) => p.detected)
            ? 'patterns_detected'
            : 'no_repeated_pattern_detected',
    };
  }
  async similar(
    userId: string,
    identityId: string | undefined,
    filters: ReportFilters & {
      type?: string;
      pattern?: string;
      minimumSeverity?: number;
      limit?: number;
      offset?: number;
    } = {},
  ) {
    const d = await this.dataset(userId, identityId, filters);
    const wanted = filters.type ?? filters.pattern;
    const evidence = d.evidence.filter(
      (e) => (!wanted || e.type === wanted) && e.severity >= (filters.minimumSeverity ?? 0),
    );
    const unique = [...new Map(evidence.map((e) => [e.id, e])).values()].sort((a, b) =>
      b.date.localeCompare(a.date),
    );
    const offset = filters.offset ?? 0,
      limit = filters.limit ?? 20;
    return {
      ...d.metadata,
      items: unique.slice(offset, offset + limit),
      nextOffset: unique.length > offset + limit ? offset + limit : null,
    };
  }
  async openings(userId: string, identityId: string | undefined, filters: ReportFilters = {}) {
    const d = await this.dataset(userId, identityId, filters);
    const names = [...new Set(d.samples.map((g) => g.opening ?? 'Unknown'))];
    return {
      ...d.metadata,
      items: names.map((opening) => {
        const games = d.samples.filter((g) => (g.opening ?? 'Unknown') === opening);
        return {
          opening,
          games: games.length,
          frequency: d.samples.length ? games.length / d.samples.length : 0,
          wins: games.filter((g) => g.result === (g.color === 'w' ? '1-0' : '0-1')).length,
          draws: games.filter((g) => g.result === '1/2-1/2').length,
          acpl: mean(games.flatMap((g) => g.moves.flatMap((m) => (m.cpl === null ? [] : [m.cpl])))),
          theoryDeviation: null,
          postTheoryAcpl: null,
        };
      }),
      theoryWarning:
        'Theory exit and post-theory performance unavailable: bundled prefix catalogue is not a complete theory database',
    };
  }
  async time(userId: string, identityId: string | undefined, filters: ReportFilters = {}) {
    const d = await this.dataset(userId, identityId, filters);
    const moves = d.samples.flatMap((g) => g.moves);
    return {
      ...d.metadata,
      unknownClockMoves: moves.filter((m) => m.clockBefore === null).length,
      buckets: [
        { name: 'below_2_minutes', min: 0, max: 120 },
        { name: '2_to_5_minutes', min: 120, max: 300 },
        { name: 'over_5_minutes', min: 300, max: Infinity },
      ].map((b) => {
        const items = moves.filter(
          (m) => m.clockBefore !== null && m.clockBefore >= b.min && m.clockBefore < b.max,
        );
        return {
          bucket: b.name,
          moves: items.length,
          meanCpl: mean(items.flatMap((m) => (m.cpl === null ? [] : [m.cpl]))),
          majorMistakes: items.filter((m) => m.severity >= 200).length,
          meanThinkTime: mean(items.flatMap((m) => (m.thinkTime === null ? [] : [m.thinkTime]))),
        };
      }),
      caveat:
        'Clock correlation does not establish causation; phase and position difficulty can confound it',
    };
  }
  async compare(
    userId: string,
    identityId: string | undefined,
    a: { since: string; until: string },
    b: { since: string; until: string },
  ) {
    const first = await this.report(userId, identityId, a);
    const second = await this.report(userId, identityId, {
      ...b,
      ...(first.analysisKey ? { analysisKey: first.analysisKey } : {}),
    });
    return {
      first,
      second,
      compatible:
        !!first.analysisKey && first.analysisKey === second.analysisKey && second.gamesAnalyzed > 0,
      delta:
        typeof first.meanCpl === 'number' && typeof second.meanCpl === 'number'
          ? { meanCpl: second.meanCpl - first.meanCpl }
          : null,
    };
  }
}
