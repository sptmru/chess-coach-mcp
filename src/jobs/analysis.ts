import type { AnalysisService } from '../services/analysis.js';
import type { SemanticService } from '../services/semantics.js';
import { DomainError, safeError } from '../utils/core.js';
import type { JobHandler } from './queue.js';

type GameResult = {
  gameId: string;
  runId?: string;
  reused?: boolean;
  classified?: number;
  failedPositions?: number;
  nextOffset?: number | null;
  skipped?: 'no_critical_positions';
  error?: string;
  stage?: 'analysis' | 'classification';
};

export function analysisHandler(analysis: AnalysisService, semantics: SemanticService): JobHandler {
  return async (job, control) => {
    const ids = job.payload.gameIds as string[];
    const options = analysis.config(job.payload.options as { depth: number; multiPv: number });
    const pipeline = job.type === 'analysis_classification';
    // Validate the persisted provider before expensive analysis, including after a restart.
    const reasoner = pipeline
      ? semantics.resolveReasoner(job.payload.provider as string, job.payload.model as string)
      : undefined;
    const runs: { gameId: string; runId: string; reused: boolean }[] = [];
    const results: GameResult[] = [];
    let failed = 0;
    const summary = () => ({
      runs,
      results,
      analyzed: runs.length,
      classified: results.reduce((sum, r) => sum + (r.classified ?? 0), 0),
      failedPositions: results.reduce((sum, r) => sum + (r.failedPositions ?? 0), 0),
      failed,
      partial: failed > 0,
    });
    await control.progress(0, ids.length, 0, summary());
    for (const gameId of ids) {
      await control.checkCancelled();
      const result: GameResult = { gameId };
      let stage: 'analysis' | 'classification' = 'analysis';
      try {
        const run = await analysis.analyze(
          job.userId,
          job.identityId,
          gameId,
          options,
          control.checkCancelled,
        );
        runs.push({ gameId, ...run });
        Object.assign(result, run);
        if (reasoner) {
          stage = 'classification';
          await control.checkCancelled();
          // Pin classification to this run, never to another job's newer analysis.
          const positions = await analysis.critical(
            job.userId,
            job.identityId,
            gameId,
            run.runId,
            job.payload.positionsPerGame as number,
          );
          if (!positions.runId)
            throw new DomainError('no_compatible_analysis', 'Analysis run is no longer available');
          result.classified = 0;
          result.failedPositions = 0;
          result.nextOffset = positions.nextOffset ?? null;
          if (!positions.items.length) result.skipped = 'no_critical_positions';
          for (const position of positions.items) {
            await control.checkCancelled();
            try {
              await semantics.classify(
                job.userId,
                job.identityId,
                position.id,
                reasoner.provider,
                reasoner.model,
              );
              result.classified++;
            } catch (e) {
              rethrowControlError(e);
              result.failedPositions++;
            }
          }
          if (result.failedPositions) {
            failed++;
            result.stage = stage;
            result.error = 'Some positions failed classification; retry to reuse completed work';
          }
        }
      } catch (e) {
        rethrowControlError(e);
        failed++;
        result.stage = stage;
        result.error = safeError(e);
      }
      results.push(result);
      await control.progress(results.length - failed, ids.length, failed, summary());
    }
    if (ids.length && failed === ids.length)
      throw new DomainError(
        'analysis_failed',
        'All selected games failed to complete; inspect result.results',
      );
    return summary();
  };
}

function rethrowControlError(error: unknown) {
  if (error instanceof DomainError && ['cancelled', 'interrupted'].includes(error.code))
    throw error;
}
