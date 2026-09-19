import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readConfig } from '../src/config.js';
import { createServices } from '../src/services/container.js';
import { users } from '../src/database/schema.js';
import { passwordHash } from '../src/auth/provider.js';
if (process.env.LIVE_SMOKE !== '1')
  throw new Error('Opt in with LIVE_SMOKE=1; this fetches public Chess.com games');
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Use an isolated TEST_DATABASE_URL ending in _test');
const config = readConfig({
  ...process.env,
  DATABASE_URL: url,
  ANALYSIS_DEPTH: process.env.SMOKE_DEPTH ?? '10',
  REASONER_PROVIDER: 'disabled',
});
const s = createServices(config);
let userId: string | undefined;
try {
  await migrate(s.db, { migrationsFolder: './drizzle' });
  await s.engine.start();
  const [u] = await s.db
    .insert(users)
    .values({
      email: `smoke-${randomUUID()}@example.test`,
      passwordHash: await passwordHash(randomUUID()),
    })
    .returning();
  userId = u.id;
  const identity = await s.identity.associate(userId, process.env.SMOKE_USERNAME ?? 'sptm1');
  const sync = await s.games.sync(
    userId,
    identity.id,
    12,
    async (done, total, failed) => {
      process.stderr.write(JSON.stringify({ stage: 'sync', done, total, failed }) + '\n');
    },
    async () => {},
  );
  const recent = await s.games.list(userId, identity.id, { limit: 3, timeControl: 'rapid' });
  if (recent.items.length < 1) throw new Error('No recent Rapid games found in the last 12 months');
  for (const g of recent.items) {
    const run = await s.analysis.analyze(userId, identity.id, g.id, s.analysis.config());
    process.stderr.write(
      JSON.stringify({ stage: 'analysis', gameId: g.id, runId: run.runId }) + '\n',
    );
    for (const p of (await s.analysis.critical(userId, identity.id, g.id, run.runId, 3)).items)
      await s.semantics.classify(userId, identity.id, p.id, 'mock');
  }
  const report = await s.reports.report(userId, identity.id);
  const training = await s.training.createSet(userId, identity.id, { count: 3 });
  if (!training.items.length) throw new Error('No suitable training exercises in sampled games');
  const exercise = training.items[0];
  await s.training.solution(userId, exercise.exerciseId);
  await s.training.record(userId, {
    exerciseId: exercise.exerciseId,
    idempotencyKey: randomUUID(),
    result: 'partial',
  });
  await s.coaching.addNote(userId, identity.id, { note: 'Live smoke fixture' });
  await s.coaching.setFocus(userId, identity.id, {
    focus: 'defensive scan',
    reason: 'Live smoke verification',
  });
  const context = await s.coaching.context(userId, identity.id);
  process.stdout.write(
    JSON.stringify(
      {
        status: 'passed',
        username: process.env.SMOKE_USERNAME ?? 'sptm1',
        verified: false,
        sync,
        gamesAnalyzed: report.gamesAnalyzed,
        engine: s.engine.version,
        analysisDepth: config.ANALYSIS_DEPTH,
        meanCpl: report.meanCpl,
        exercises: training.items.length,
        coachingContextPresent: !!context,
        warnings: report.warnings,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  if (userId) await s.db.delete(users).where(eq(users.id, userId));
  await s.close();
}
