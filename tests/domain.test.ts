import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import {
  clockSeconds,
  parsePgn,
  gameFingerprint,
  phase,
  recognizeOpening,
} from '../src/chess/normalize.js';
import {
  canonical,
  centipawnLoss,
  groupCritical,
  perspective,
  state,
  transitions,
} from '../src/analysis/evaluation.js';
import { classificationSchema, features, MockReasoner } from '../src/semantics/reasoner.js';
import { detectPatterns, type PatternEvidence } from '../src/patterns/aggregate.js';
import { fen, move, toolDefinitions } from '../src/mcp/tools.js';
import { publicExercise } from '../src/training/service.js';
import type { AnalyzedMove } from '../src/domain/types.js';
import type { exercises } from '../src/database/schema.js';
import { readConfig } from '../src/config.js';
import { createServices } from '../src/services/container.js';
const pgn = readFileSync(new URL('./fixtures/fools-mate.pgn', import.meta.url), 'utf8');
function measured(): AnalyzedMove {
  return {
    ...parsePgn(pgn, '600+5').moves[2],
    before: { type: 'cp', value: 0 },
    after: { type: 'mate', value: -1, winning: false },
    cpl: null,
    bestMove: 'e2e4',
    alternatives: [],
    transitions: ['allowed_forced_mate'],
    severity: 1000,
  };
}
describe('PGN normalization', () => {
  it('preserves legal positions, clocks, increments and think time', () => {
    const p = parsePgn(pgn, '600+5');
    expect(p.moves).toHaveLength(4);
    expect(p.moves[0]).toMatchObject({
      uci: 'f2f3',
      clockBefore: 600,
      clockAfter: 602,
      thinkTime: 3,
    });
    expect(p.moves[2]).toMatchObject({ clockBefore: 602, clockAfter: 605, thinkTime: 2 });
    expect(new Chess(p.moves[3].fenAfter).isCheckmate()).toBe(true);
    expect(p.moves[3].color).toBe('b');
  });
  it('does not invent clocks for missing annotations or staged time controls', () => {
    expect(
      parsePgn(pgn.replace(/\{[^}]+\}/g, ''), '600').moves.every((m) => m.clockAfter === null),
    ).toBe(true);
    expect(parsePgn(pgn, '40/7200').moves[0].thinkTime).toBeNull();
    expect(clockSeconds('[%clk 0:99:00]')).toBeNull();
  });
  it('does not consume clocks from side variations', () => {
    const variation = pgn.replace('e5 {', '(1... d5 {[%clk 0:01:00]}) e5 {');
    expect(parsePgn(variation, '600+5').moves[1].clockAfter).toBe(603);
  });
  it('deduplicates stable IDs independently of clock annotations and casing', () => {
    const p = parsePgn(pgn, '600');
    expect(gameFingerprint({ uuid: 'same' }, p.headers, p.moves)).toBe(
      gameFingerprint(
        { uuid: 'same' },
        { ...p.headers, White: p.headers.White.toUpperCase() },
        p.moves,
      ),
    );
    expect(gameFingerprint({}, p.headers, p.moves)).toBe(
      gameFingerprint({}, { ...p.headers, White: p.headers.White.toUpperCase() }, p.moves),
    );
  });
  it('rejects malformed and empty PGNs', () => {
    expect(() => parsePgn('1. e4 e5 2. nonsense', '600')).toThrow();
    expect(() => parsePgn('*', '600')).toThrow();
  });
  it('recognizes opening prefixes without claiming a theory exit', () => {
    const p = parsePgn('1. e4 e5 2. Nf3 Nc6 3. d4 exd4 4. Nxd4 *', '600');
    expect(recognizeOpening({}, p.moves)).toMatchObject({
      opening: 'Scotch Game',
      theoryExitPly: null,
    });
  });
});
describe('evaluation', () => {
  it('normalizes black score and CPL in the mover perspective', () => {
    expect(canonical({ type: 'cp', value: 120 }, 'b')).toEqual({ type: 'cp', value: -120 });
    expect(centipawnLoss({ type: 'cp', value: -100 }, { type: 'cp', value: 50 }, 'b')).toBe(150);
    expect(centipawnLoss({ type: 'cp', value: 100 }, { type: 'cp', value: 200 }, 'w')).toBe(0);
  });
  it('retains mates, including mate zero after black has been checkmated', () => {
    const score = canonical({ type: 'mate', value: 0 }, 'b');
    expect(state(score)).toBe('winning');
    expect(state(perspective(score, 'b'))).toBe('losing');
    expect(JSON.parse(JSON.stringify(score)).winning).toBe(true);
    expect(centipawnLoss({ type: 'cp', value: 800 }, score, 'w')).toBeNull();
    expect(transitions({ type: 'cp', value: 0 }, { type: 'mate', value: -2 }, 'w', null)).toContain(
      'allowed_forced_mate',
    );
  });
  it('classifies phase from material and ply', () => {
    expect(phase(new Chess().fen(), 1)).toBe('opening');
    expect(phase(new Chess().fen(), 25)).toBe('middlegame');
    expect(phase('8/8/8/4k3/8/8/4K3/8 w - - 0 1', 1)).toBe('endgame');
  });
  it('groups nearby mistakes by color while retaining contributing plies', () => {
    const m = measured();
    const groups = groupCritical([
      { ...m, ply: 3 },
      { ...m, ply: 5, severity: 200 },
      { ...m, ply: 13 },
      { ...m, ply: 4, color: 'b' },
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0].plies).toEqual([3, 5]);
    expect(groups[0].representativePly).toBe(3);
  });
});
describe('semantics and patterns', () => {
  it('extracts inspectable legal checks/captures and geometric attack maps', () => {
    const m = measured();
    const f = features(m);
    expect(f.materialBefore.w).toBe(39);
    expect(f.attackers).toHaveProperty('e1');
    expect(Array.isArray(f.legalChecks)).toBe(true);
  });
  it('validates labels, confidence and rejects extra provider instructions', () => {
    expect(
      classificationSchema.safeParse({
        primary: 'invented',
        secondary: [],
        confidence: 1,
        explanation: 'x',
        evidence: [],
      }).success,
    ).toBe(false);
    expect(
      classificationSchema.safeParse({
        primary: 'unclear',
        secondary: [],
        confidence: 2,
        explanation: 'x',
        evidence: [],
      }).success,
    ).toBe(false);
  });
  it('deterministic reasoner labels forced mate using engine evidence', async () => {
    const m = measured();
    const result = await new MockReasoner().classify({
      move: m,
      features: features(m),
      opening: null,
      surrounding: [],
    });
    expect(result.classification.primary).toBe('missed_tactical_defense');
    expect(result.classification.secondary).toContain('rushed_move');
  });
  it('requires multiple occurrences in multiple games and deduplicates evidence', () => {
    const e: PatternEvidence = {
      id: 'p',
      gameId: 'g',
      date: '2026-01-01',
      type: 'missed_capture',
      severity: 200,
      confidence: 0.8,
      phase: 'middlegame',
      clock: 60,
    };
    expect(detectPatterns([e, e], [{ id: 'g', date: e.date }])[0]).toMatchObject({
      frequency: 1,
      detected: false,
      trend: 'insufficient_data',
    });
  });
  it('uses per-game denominators for trends', () => {
    const games = Array.from({ length: 6 }, (_, i) => ({
      id: String(i),
      date: `2026-01-0${i + 1}`,
    }));
    const evidence = games.slice(0, 3).map((g) => ({
      id: g.id,
      gameId: g.id,
      date: g.date,
      type: 'missed_capture',
      severity: 200,
      confidence: 0.8,
      phase: 'middlegame',
      clock: 60,
    }));
    expect(detectPatterns(evidence, games)[0]).toMatchObject({
      detected: true,
      trend: 'improving',
      earlierPerGame: 1,
      laterPerGame: 0,
    });
  });
});
describe('public contracts', () => {
  it('separates training answers even when the stored object has sensitive fields', () => {
    const result = publicExercise({
      id: 'x',
      version: 'v',
      fen: 'fen',
      sideToMove: 'white',
      difficulty: 'easy',
      solution: { bestMove: 'e2e4' },
      userId: 'u',
      identityId: 'i',
      positionId: 'p',
      createdAt: new Date(),
    } as typeof exercises.$inferSelect);
    expect(JSON.stringify(result)).not.toContain('e2e4');
    expect(result).not.toHaveProperty('solution');
    expect(result).not.toHaveProperty('userId');
  });
  it('validates FEN, moves, limits and rejects client supplied user IDs', async () => {
    expect(fen.safeParse('invalid').success).toBe(false);
    expect(move.safeParse('e2e4').success).toBe(true);
    expect(move.safeParse('e7e8q').success).toBe(true);
    expect(move.safeParse('a2a1n').success).toBe(true);
    expect(move.safeParse('rm -rf /').success).toBe(false);
    const s = createServices(
      readConfig({
        DATABASE_URL: 'postgresql://unused:unused@localhost/chess_test',
        LOG_LEVEL: 'silent',
      }),
    );
    const defs = toolDefinitions(s);
    expect(defs.length).toBe(44);
    expect(
      defs
        .find((t) => t.name === 'analyze_position')!
        .schema.safeParse({ fen: new Chess().fen(), depth: 999 }).success,
    ).toBe(false);
    expect(
      defs.find((t) => t.name === 'get_me')!.schema.safeParse({ userId: 'other' }).success,
    ).toBe(false);
    await s.close();
  });
});
