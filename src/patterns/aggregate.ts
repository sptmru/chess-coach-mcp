export type PatternEvidence = {
  id: string;
  gameId: string;
  date: string;
  type: string;
  severity: number;
  confidence: number;
  phase: string;
  clock: number | null;
};
export function detectPatterns(
  evidence: PatternEvidence[],
  gameDates: { id: string; date: string }[],
  minimum = 3,
) {
  const unique = [...new Map(evidence.map((e) => [`${e.id}/${e.type}`, e])).values()];
  const ordered = [...gameDates].sort((a, b) => a.date.localeCompare(b.date));
  const half = Math.floor(ordered.length / 2);
  const earlier = new Set(ordered.slice(0, half).map((g) => g.id)),
    later = new Set(ordered.slice(half).map((g) => g.id));
  return [...new Set(unique.map((e) => e.type))].map((type) => {
    const items = unique.filter((e) => e.type === type);
    const games = new Set(items.map((e) => e.gameId)).size;
    const before = half ? items.filter((e) => earlier.has(e.gameId)).length / half : null;
    const after = later.size ? items.filter((e) => later.has(e.gameId)).length / later.size : null;
    const trend =
      half < 3 || later.size < 3 || before === null || after === null
        ? 'insufficient_data'
        : after < before * 0.8
          ? 'improving'
          : after > before * 1.2
            ? 'worsening'
            : 'stable';
    const dates = items.map((e) => e.date).sort();
    return {
      type,
      frequency: items.length,
      games,
      sampleGames: ordered.length,
      detected: items.length >= minimum && games >= 2,
      severity: items.reduce((s, e) => s + e.severity, 0) / items.length,
      confidence: items.reduce((s, e) => s + e.confidence, 0) / items.length,
      firstSeen: dates[0],
      lastSeen: dates.at(-1),
      trend,
      earlierPerGame: before,
      laterPerGame: after,
      representativePositions: items
        .sort((a, b) => b.severity - a.severity)
        .slice(0, 3)
        .map((e) => e.id),
      phases: [...new Set(items.map((e) => e.phase))],
      clockCorrelation: {
        known: items.filter((e) => e.clock !== null).length,
        belowTwoMinutes: items.filter((e) => e.clock !== null && e.clock < 120).length,
      },
      minimumEvidence: minimum,
    };
  });
}
