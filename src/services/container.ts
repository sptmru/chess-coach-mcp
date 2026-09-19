import { database } from '../database/client.js';
import type { Config } from '../config.js';
import { ChessComClient } from '../chesscom/client.js';
import { EnginePool } from '../stockfish/engine.js';
import { JobQueue } from '../jobs/queue.js';
import { IdentityService } from './identity.js';
import { GameService } from './games.js';
import { AnalysisService } from './analysis.js';
import { SemanticService } from './semantics.js';
import { ReportService } from './reports.js';
import { CoachingService } from '../coaching/service.js';
import { TrainingService } from '../training/service.js';
import { reasoner } from '../semantics/reasoner.js';
import { DomainError } from '../utils/core.js';
export function createServices(
  config: Config,
  upstream = new ChessComClient(config.CHESSCOM_USER_AGENT),
) {
  const { db, pool } = database(config.DATABASE_URL);
  const engine = new EnginePool(config);
  const identity = new IdentityService(db, upstream),
    games = new GameService(db, identity, upstream),
    analysis = new AnalysisService(db, games, engine),
    semantics = new SemanticService(db, analysis, reasoner(config)),
    reports = new ReportService(db, games, analysis),
    coaching = new CoachingService(db, identity, reports),
    training = new TrainingService(db, reports, semantics),
    jobs = new JobQueue(db, pool, config.JOB_CONCURRENCY);
  jobs.register('sync', async (j, c) =>
    games.sync(
      j.userId,
      j.identityId,
      j.payload.months as number,
      (d, t, f) => c.progress(d, t, f),
      c.checkCancelled,
    ),
  );
  jobs.register('analysis', async (j, c) => {
    const ids = j.payload.gameIds as string[],
      options = analysis.config(j.payload.options as { depth: number; multiPv: number });
    const runs = [];
    let failed = 0;
    for (const id of ids) {
      await c.checkCancelled();
      try {
        runs.push(await analysis.analyze(j.userId, j.identityId, id, options, c.checkCancelled));
      } catch (e) {
        if (e instanceof DomainError && ['cancelled', 'interrupted'].includes(e.code)) throw e;
        failed++;
      }
      await c.progress(runs.length, ids.length, failed);
    }
    if (!runs.length && failed)
      throw new DomainError('analysis_failed', 'All selected games failed analysis');
    return { runs, failed, partial: failed > 0 };
  });
  jobs.register('classification', async (j, c) => {
    const ids = j.payload.positionIds as string[];
    const results = [];
    let failed = 0;
    for (const id of ids) {
      await c.checkCancelled();
      try {
        results.push(
          await semantics.classify(
            j.userId,
            j.identityId,
            id,
            j.payload.provider as string | undefined,
            j.payload.model as string | undefined,
          ),
        );
      } catch {
        failed++;
      }
      await c.progress(results.length, ids.length, failed);
    }
    if (!results.length && failed)
      throw new DomainError('classification_failed', 'All positions failed classification');
    return { classified: results.length, failed };
  });
  return {
    config,
    db,
    pool,
    engine,
    upstream,
    identity,
    games,
    analysis,
    semantics,
    reports,
    coaching,
    training,
    jobs,
    async start() {
      await engine.start();
      await jobs.start();
    },
    async close() {
      await jobs.close();
      await engine.close();
      await pool.end();
    },
  };
}
export type Services = ReturnType<typeof createServices>;
