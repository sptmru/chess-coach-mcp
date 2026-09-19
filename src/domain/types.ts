export type Color = 'w' | 'b';
export type Evaluation =
  { type: 'cp'; value: number } | { type: 'mate'; value: number; winning?: boolean };
export type EngineLine = { rank: number; depth: number; score: Evaluation; pv: string[] };
export type EngineResult = { bestMove: string | null; lines: EngineLine[] };
export type EngineConfig = { depth: number; multiPv: number };
export type Phase = 'opening' | 'middlegame' | 'endgame';
export type MoveFact = {
  ply: number;
  moveNumber: number;
  color: Color;
  san: string;
  uci: string;
  fenBefore: string;
  fenAfter: string;
  clockBefore: number | null;
  clockAfter: number | null;
  thinkTime: number | null;
  phase: Phase;
};
export type AnalyzedMove = MoveFact & {
  before: Evaluation;
  after: Evaluation;
  cpl: number | null;
  bestMove: string | null;
  alternatives: EngineLine[];
  transitions: string[];
  severity: number;
};
export type CriticalGroup = {
  color: Color;
  representativePly: number;
  plies: number[];
  severity: number;
};
export type RequestContext = { userId: string; correlationId: string };
