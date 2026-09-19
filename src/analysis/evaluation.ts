import type { Evaluation, Color, AnalyzedMove, CriticalGroup } from '../domain/types.js';
export const ALGORITHM_VERSION = 'objective-v1';
export function perspective(score: Evaluation, color: Color): Evaluation {
  return {
    ...score,
    value: score.value * (color === 'w' ? 1 : -1),
    ...(score.type === 'mate'
      ? {
          winning:
            color === 'w'
              ? (score.winning ?? score.value > 0)
              : !(score.winning ?? score.value > 0),
        }
      : {}),
  };
}
export function canonical(score: Evaluation, sideToMove: Color): Evaluation {
  return perspective(score, sideToMove);
}
export function centipawnLoss(before: Evaluation, after: Evaluation, color: Color): number | null {
  if (before.type !== 'cp' || after.type !== 'cp') return null;
  return Math.max(0, perspective(before, color).value - perspective(after, color).value);
}
export function state(score: Evaluation) {
  if (score.type === 'mate') return (score.winning ?? score.value > 0) ? 'winning' : 'losing';
  return score.value > 150 ? 'winning' : score.value < -150 ? 'losing' : 'equal';
}
export function transitions(
  before: Evaluation,
  after: Evaluation,
  color: Color,
  cpl: number | null,
) {
  const a = perspective(before, color),
    b = perspective(after, color),
    from = state(a),
    to = state(b);
  const result: string[] = [];
  if (from !== to) result.push(`${from}_to_${to}`);
  if (from === 'winning' && to !== 'winning') result.push('missed_winning_opportunity');
  if (from === 'losing' && to === 'losing' && (cpl ?? 0) >= 200)
    result.push('losing_to_much_worse');
  if (a.type === 'mate' && b.type !== 'mate' && (a.winning ?? a.value > 0))
    result.push('lost_forced_mate');
  if (
    b.type === 'mate' &&
    !(b.winning ?? b.value > 0) &&
    (a.type !== 'mate' || (a.winning ?? a.value > 0))
  )
    result.push('allowed_forced_mate');
  return result;
}
export function severity(before: Evaluation, after: Evaluation, color: Color, cpl: number | null) {
  const t = transitions(before, after, color, cpl);
  if (t.includes('allowed_forced_mate') || t.includes('lost_forced_mate')) return 1000;
  return Math.min(1000, cpl ?? 0);
}
export function groupCritical(moves: AnalyzedMove[], threshold = 100): CriticalGroup[] {
  const result: CriticalGroup[] = [];
  for (const color of ['w', 'b'] as const) {
    let group: CriticalGroup | undefined;
    for (const m of moves.filter(
      (m) => m.color === color && (m.severity >= threshold || m.transitions.length),
    )) {
      if (!group || m.ply - group.plies[group.plies.length - 1] > 4) {
        group = { color, representativePly: m.ply, plies: [m.ply], severity: m.severity };
        result.push(group);
      } else {
        group.plies.push(m.ply);
        if (m.severity > group.severity) {
          group.severity = m.severity;
          group.representativePly = m.ply;
        }
      }
    }
  }
  return result.sort((a, b) => a.representativePly - b.representativePly);
}
