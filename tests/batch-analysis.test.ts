import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { analysisHandler } from '../src/jobs/analysis.js';
import type { Job, JobControl } from '../src/jobs/queue.js';
import { toolDefinitions } from '../src/mcp/tools.js';
import { createServices, type Services } from '../src/services/container.js';
import { DomainError } from '../src/utils/core.js';

const ctx = { userId: randomUUID(), correlationId: randomUUID() };
const identityId = randomUUID();
let s: Services;
beforeEach(() => {
  s = createServices(
    readConfig({
      DATABASE_URL: 'postgresql://unused:unused@localhost/chess_test',
      REASONER_PROVIDER: 'jev',
      JEV_API_KEY: 'synthetic-test-key',
    }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await s.pool.end();
});
const page = (ids: string[], nextCursor: string | null = null) =>
  ({
    items: ids.map((id) => ({ id })),
    nextCursor,
  }) as Awaited<ReturnType<Services['games']['list']>>;
const authorize = () =>
  vi
    .spyOn(s.identity, 'require')
    .mockResolvedValue({ id: identityId } as Awaited<ReturnType<Services['identity']['require']>>);

describe('date-filtered analysis tools', () => {
  it.each(['analyze_games', 'analyze_and_classify_games'])(
    'queues 56 games as one %s job with stable deduplication and explicit retry',
    async (name) => {
      authorize();
      const ids = Array.from({ length: 56 }, () => randomUUID());
      const list = vi.spyOn(s.games, 'list').mockResolvedValue(page(ids));
      const enqueue = vi
        .spyOn(s.jobs, 'enqueue')
        .mockResolvedValue({ id: randomUUID(), state: 'queued' } as Awaited<
          ReturnType<Services['jobs']['enqueue']>
        >);
      const tool = toolDefinitions(s).find((t) => t.name === name)!;
      const input = { since: '2026-09-01T00:00:00Z', until: '2026-09-19T23:59:59Z' };
      expect(await tool.execute(input, ctx)).toMatchObject({ selected: 56, state: 'queued' });
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledWith(
        ctx.userId,
        identityId,
        expect.objectContaining({ ...input, timeControl: 'rapid' }),
      );
      expect(enqueue.mock.calls[0].slice(0, 4)).toEqual([
        ctx.userId,
        identityId,
        name === 'analyze_games' ? 'analysis' : 'analysis_classification',
        {
          gameIds: ids,
          options: { depth: 12, multiPv: 3 },
          ...(name === 'analyze_games'
            ? {}
            : { provider: 'jev', model: 'jev-latest', positionsPerGame: 10 }),
        },
      ]);
      const key = enqueue.mock.calls[0][4];
      await tool.execute(input, ctx);
      expect(enqueue.mock.calls[1][4]).toBe(key);
      await tool.execute({ ...input, retry: true }, ctx);
      expect(enqueue.mock.calls[2][4]).not.toBe(key);
    },
  );

  it('selects beyond the game-list page limit without truncation', async () => {
    const ids = Array.from({ length: 125 }, () => randomUUID());
    const list = vi
      .spyOn(s.games, 'list')
      .mockResolvedValueOnce(page(ids.slice(0, 100), 'next'))
      .mockResolvedValueOnce(page(ids.slice(100)));
    expect(await s.games.selectBatch(ctx.userId, identityId, {}, 500)).toEqual(ids);
    expect(list.mock.calls[1][2]).toMatchObject({ cursor: 'next', limit: 100 });
  });

  it('rejects reversed dates and overflow without queueing a partial selection', async () => {
    authorize();
    const enqueue = vi.spyOn(s.jobs, 'enqueue');
    const list = vi.spyOn(s.games, 'list').mockResolvedValue(page([randomUUID(), randomUUID()]));
    const tool = toolDefinitions(s).find((t) => t.name === 'analyze_games')!;
    await expect(
      tool.execute({ since: '2026-09-19T00:00:00Z', until: '2026-09-01T00:00:00Z' }, ctx),
    ).rejects.toMatchObject({ code: 'invalid_period' });
    expect(list).not.toHaveBeenCalled();
    await expect(tool.execute({ maxGames: 1 }, ctx)).rejects.toMatchObject({ code: 'limits' });
    await expect(tool.execute({ maxGames: 501 }, ctx)).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('reports empty selections and rejects foreign identities and unsupported providers', async () => {
    const auth = authorize();
    const list = vi.spyOn(s.games, 'list').mockResolvedValue(page([]));
    const enqueue = vi.spyOn(s.jobs, 'enqueue');
    const tool = toolDefinitions(s).find((t) => t.name === 'analyze_and_classify_games')!;
    expect(await tool.execute({}, ctx)).toEqual({ skipped: 'no_matching_games', selected: 0 });
    await expect(tool.execute({ model: 'wrong' }, ctx)).rejects.toMatchObject({
      code: 'provider_not_allowed',
    });
    expect(list).toHaveBeenCalledTimes(1);
    auth.mockRejectedValue(new DomainError('not_found', 'Resource not found or not accessible'));
    await expect(tool.execute({ identityId: randomUUID() }, ctx)).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('analysis pipeline worker', () => {
  const makeJob = (ids: string[], pipeline = true): Job => ({
    id: randomUUID(),
    createdAt: new Date(),
    state: 'queued',
    idempotencyKey: randomUUID(),
    correlationId: ctx.correlationId,
    result: null,
    error: null,
    total: 0,
    completed: 0,
    failed: 0,
    retries: 0,
    cancelRequested: false,
    startedAt: null,
    finishedAt: null,
    userId: ctx.userId,
    identityId,
    type: pipeline ? 'analysis_classification' : 'analysis',
    payload: {
      gameIds: ids,
      options: { depth: 8, multiPv: 2 },
      provider: 'mock',
      model: 'deterministic-v1',
      positionsPerGame: 10,
    },
  });
  const control = (): JobControl => ({
    progress: vi.fn(async () => {}),
    checkCancelled: vi.fn(async () => {}),
  });

  it('pins each classification to its returned run and persists per-game progress', async () => {
    const ids = [randomUUID(), randomUUID()];
    const runId = randomUUID(),
      positionId = randomUUID();
    vi.spyOn(s.analysis, 'analyze').mockResolvedValue({ runId, reused: true });
    const critical = vi
      .spyOn(s.analysis, 'critical')
      .mockResolvedValue({ runId, items: [{ id: positionId }], nextOffset: 10 } as Awaited<
        ReturnType<Services['analysis']['critical']>
      >);
    const classify = vi.spyOn(s.semantics, 'classify').mockResolvedValue({ status: 'succeeded' });
    const c = control();
    const result = await analysisHandler(s.analysis, s.semantics)(makeJob(ids), c);
    expect(critical).toHaveBeenCalledWith(ctx.userId, identityId, ids[0], runId, 10);
    expect(classify).toHaveBeenCalledTimes(2);
    expect(classify).toHaveBeenCalledWith(
      ctx.userId,
      identityId,
      positionId,
      'mock',
      'deterministic-v1',
    );
    expect(result).toMatchObject({
      analyzed: 2,
      classified: 2,
      failed: 0,
      partial: false,
      results: ids.map((gameId) => ({ gameId, runId, reused: true, nextOffset: 10 })),
    });
    expect(c.progress).toHaveBeenLastCalledWith(2, 2, 0, result);
  });

  it('continues after analysis and classification errors with separate counts', async () => {
    const ids = Array.from({ length: 3 }, () => randomUUID());
    const runId = randomUUID();
    vi.spyOn(s.analysis, 'analyze')
      .mockRejectedValueOnce(new Error('private detail'))
      .mockResolvedValue({ runId, reused: false });
    vi.spyOn(s.analysis, 'critical').mockResolvedValue({
      runId,
      items: [{ id: randomUUID() }, { id: randomUUID() }],
      nextOffset: null,
    } as Awaited<ReturnType<Services['analysis']['critical']>>);
    vi.spyOn(s.semantics, 'classify')
      .mockRejectedValueOnce(new Error('provider failure'))
      .mockResolvedValue({ status: 'succeeded' });
    const c = control();
    const result = await analysisHandler(s.analysis, s.semantics)(makeJob(ids), c);
    expect(result).toMatchObject({
      analyzed: 2,
      classified: 3,
      failedPositions: 1,
      failed: 2,
      partial: true,
      results: [
        { gameId: ids[0], stage: 'analysis' },
        { gameId: ids[1], stage: 'classification', classified: 1 },
        { gameId: ids[2], classified: 2 },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('private detail');
    expect(c.progress).toHaveBeenLastCalledWith(1, 3, 2, result);
  });

  it.each(['cancelled', 'interrupted'])(
    'propagates %s during classification and stops later games',
    async (code) => {
      const ids = [randomUUID(), randomUUID()],
        runId = randomUUID();
      const analyze = vi.spyOn(s.analysis, 'analyze').mockResolvedValue({ runId, reused: false });
      vi.spyOn(s.analysis, 'critical').mockResolvedValue({
        runId,
        items: [{ id: randomUUID() }],
      } as Awaited<ReturnType<Services['analysis']['critical']>>);
      vi.spyOn(s.semantics, 'classify').mockRejectedValue(new DomainError(code, code));
      await expect(
        analysisHandler(s.analysis, s.semantics)(makeJob(ids), control()),
      ).rejects.toMatchObject({ code });
      expect(analyze).toHaveBeenCalledTimes(1);
    },
  );

  it('checkpoints all failures before failing the job, and never calls a reasoner for analysis-only jobs', async () => {
    vi.spyOn(s.analysis, 'analyze').mockRejectedValue(new Error('engine failed'));
    const classify = vi.spyOn(s.semantics, 'classify');
    const c = control();
    await expect(
      analysisHandler(s.analysis, s.semantics)(makeJob([randomUUID()], false), c),
    ).rejects.toMatchObject({ code: 'analysis_failed' });
    expect(c.progress).toHaveBeenLastCalledWith(
      0,
      1,
      1,
      expect.objectContaining({ failed: 1, partial: true }),
    );
    expect(classify).not.toHaveBeenCalled();
  });

  it('distinguishes analyzed games with no critical positions', async () => {
    const runId = randomUUID();
    vi.spyOn(s.analysis, 'analyze').mockResolvedValue({ runId, reused: true });
    vi.spyOn(s.analysis, 'critical').mockResolvedValue({
      runId,
      items: [],
      nextOffset: null,
      opening: { name: null, eco: null, variation: null },
      analysisVersion: {
        ...s.analysis.metadata({ depth: 8, multiPv: 2 }),
        engine: 'fixture',
        algorithm: 'fixture',
        key: 'fixture',
      },
    });
    const classify = vi.spyOn(s.semantics, 'classify');
    expect(
      await analysisHandler(s.analysis, s.semantics)(makeJob([randomUUID()]), control()),
    ).toMatchObject({ failed: 0, classified: 0, results: [{ skipped: 'no_critical_positions' }] });
    expect(classify).not.toHaveBeenCalled();
  });
});
