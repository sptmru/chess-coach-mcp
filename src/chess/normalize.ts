import { Chess, validateFen } from 'chess.js';
import type { MoveFact, Phase } from '../domain/types.js';
import { DomainError, hash } from '../utils/core.js';
export function validFen(fen: string) {
  return validateFen(fen).ok;
}
export function phase(fen: string, ply: number): Phase {
  const pieces = new Chess(fen)
    .board()
    .flat()
    .filter((p) => p && !['p', 'k'].includes(p.type));
  const queens = pieces.filter((p) => p?.type === 'q').length;
  if (pieces.length <= 4 || (queens === 0 && pieces.length <= 6)) return 'endgame';
  return ply <= 20 ? 'opening' : 'middlegame';
}
export function clockSeconds(comment: string): number | null {
  const m = /\[%clk\s+(\d+):(\d{2}):(\d{2}(?:\.\d+)?)\]/.exec(comment);
  if (!m || Number(m[2]) >= 60 || Number(m[3]) >= 60) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
export function parsePgn(
  pgn: string,
  timeControl: string,
): { headers: Record<string, string>; moves: MoveFact[] } {
  if (pgn.length > 500000) throw new DomainError('invalid_pgn', 'PGN too large');
  const chess = new Chess();
  try {
    chess.loadPgn(pgn, { strict: false });
  } catch {
    throw new DomainError('invalid_pgn', 'Invalid or unsupported PGN');
  }
  const headers = chess.getHeaders();
  const history = chess.history({ verbose: true });
  if (history.length === 0 || history.length > 800)
    throw new DomainError('invalid_pgn', 'Empty or oversized game');
  // Read clocks in mainline order, including repeated FENs. chess.js validates all moves;
  // this scanner only handles annotations, never chess rules.
  const mainline = pgn.replace(/^\s*\[[^\n]*\]\s*$/gm, '').replace(/;[^\n]*/g, '');
  const clocks: (number | null)[] = [];
  let variationDepth = 0;
  for (const token of mainline.matchAll(/\{[^}]*\}|\(|\)|[^\s(){}]+/g)) {
    const t = token[0];
    if (t === '(') {
      variationDepth++;
      continue;
    }
    if (t === ')') {
      variationDepth--;
      continue;
    }
    if (variationDepth !== 0) continue;
    if (t.startsWith('{')) {
      if (clocks.length) clocks[clocks.length - 1] = clockSeconds(t) ?? clocks[clocks.length - 1];
      continue;
    }
    const san = t.replace(/^\d+\.(?:\.\.)?/, '').replace(/[!?]+$/, '');
    if (!san || /^\$\d+$/.test(san) || /^(1-0|0-1|1\/2-1\/2|\*|\.+)$/.test(san)) continue;
    clocks.push(null);
  }
  const tc = /^(\d+)(?:\+(\d+))?$/.exec(timeControl);
  const previous: Record<'w' | 'b', number | null> = {
    w: tc ? Number(tc[1]) : null,
    b: tc ? Number(tc[1]) : null,
  };
  const increment = tc ? Number(tc[2] ?? 0) : null;
  // If annotations cannot be aligned, omit clocks instead of attaching them to wrong plies.
  return {
    headers,
    moves: history.map((m, i) => {
      const after = clocks.length === history.length ? clocks[i] : null;
      const before = previous[m.color];
      previous[m.color] = after;
      const spent =
        before !== null && after !== null && increment !== null ? before + increment - after : null;
      return {
        ply: i + 1,
        moveNumber: Number(m.before.split(' ')[5]),
        color: m.color,
        san: m.san,
        uci: m.from + m.to + (m.promotion ?? ''),
        fenBefore: m.before,
        fenAfter: m.after,
        clockBefore: before,
        clockAfter: after,
        thinkTime: spent !== null && spent >= 0 ? spent : null,
        phase: phase(m.before, i + 1),
      };
    }),
  };
}
export function gameFingerprint(
  input: { uuid?: string; url?: string },
  headers: Record<string, string>,
  moves: MoveFact[],
) {
  if (input.uuid) return hash(`chesscom:uuid:${input.uuid}`);
  const id = input.url?.match(/(?:live|daily)\/(\d+)/)?.[0];
  if (id) return hash(`chesscom:${id}`);
  return hash({
    white: headers.White?.toLowerCase(),
    black: headers.Black?.toLowerCase(),
    date: headers.UTCDate ?? headers.Date,
    time: headers.UTCTime,
    result: headers.Result,
    initial: moves[0]?.fenBefore,
    moves: moves.map((m) => m.uci),
  });
}
// Original small prefix catalogue. No third-party opening dataset is redistributed.
const openings = [
  { moves: 'e4 e5 Nf3 Nc6 d4 exd4 Nxd4', eco: 'C45', name: 'Scotch Game' },
  {
    moves: 'e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 g6',
    eco: 'B70',
    name: 'Sicilian Defense: Dragon Variation',
  },
  { moves: 'd4 Nf6 c4 g6 Nc3 d5', eco: 'D80', name: 'Grünfeld Defense' },
  { moves: 'e4 e5 Nf3 Nc6 Bb5', eco: 'C60', name: 'Ruy Lopez' },
  { moves: 'e4 e5 Nf3 Nc6 Bc4', eco: 'C50', name: 'Italian Game' },
  { moves: 'e4 c5', eco: 'B20', name: 'Sicilian Defense' },
  { moves: 'd4 d5 c4', eco: 'D06', name: "Queen's Gambit" },
];
export function recognizeOpening(headers: Record<string, string>, moves: MoveFact[]) {
  const line = moves.map((m) => m.san).join(' ');
  const match = openings
    .filter((o) => line === o.moves || line.startsWith(o.moves + ' '))
    .sort((a, b) => b.moves.length - a.moves.length)[0];
  return {
    eco: headers.ECO ?? match?.eco ?? null,
    opening: headers.Opening ?? match?.name ?? null,
    variation: headers.Variation ?? null,
    theoryExitPly: null,
    openingSource: headers.ECO || headers.Opening ? 'pgn' : match ? 'builtin-prefix-v1' : null,
  };
}
