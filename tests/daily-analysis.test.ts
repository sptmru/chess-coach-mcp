import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import {
  DAILY_JOB_TYPE,
  dailyAnalysisHandler,
  dailyPeriod,
  DailyAnalysisScheduler,
} from '../src/jobs/daily.js';
import type { Job, JobControl } from '../src/jobs/queue.js';
import { createServices, type Services } from '../src/services/container.js';
import { DomainError } from '../src/utils/core.js';

let s: Services;
const userId = randomUUID(),
  identityId = randomUUID();
beforeEach(() => {
  s = createServices(
    readConfig({ DATABASE_URL: 'postgresql://unused:unused@localhost/chess_test' }),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await s.daily.close();
  vi.useRealTimers();
  await s.pool.end();
});

describe('Yerevan daily schedule', () => {
  it.each([
    ['2026-09-19T22:59:59.999Z', null],
    ['2026-09-19T23:00:00.000Z', '2026-09-19'],
    ['2026-09-20T19:59:59.999Z', '2026-09-19'],
    ['2026-09-20T20:00:00.000Z', null],
    ['2026-09-30T23:00:00.000Z', '2026-09-30'],
    ['2026-12-31T23:00:00.000Z', '2026-12-31'],
    ['2028-02-29T23:00:00.000Z', '2028-02-29'],
  ])('selects the previous calendar day at %s', (now, date) => {
    const period = dailyPeriod(new Date(now));
    expect(period?.date ?? null).toBe(date);
    if (period) {
      expect(new Date(period.until).getTime() - new Date(period.since).getTime()).toBe(
        86_400_000 - 1,
      );
      expect(period.since).toMatch(/T20:00:00.000Z$/);
      expect(period.until).toMatch(/T19:59:59.999Z$/);
    }
  });

  function schedulerMocks() {
    const second = { userId: randomUUID(), id: randomUUID() };
    const where = vi.fn().mockResolvedValue([{ userId, id: identityId }, second]);
    vi.spyOn(s.db, 'select').mockReturnValue({ from: () => ({ where }) } as never);
    vi.spyOn(s.jobs, 'isRunning', 'get').mockReturnValue(true);
    const enqueue = vi
      .spyOn(s.jobs, 'enqueue')
      .mockResolvedValue({ id: randomUUID(), state: 'queued' } as never);
    return { where, enqueue, second };
  }

  it('queues each identity once per day, catches up late, and uses stable keys across restart', async () => {
    const { enqueue, second } = schedulerMocks();
    await s.daily.tick(new Date('2026-09-19T22:59:59Z'));
    expect(enqueue).not.toHaveBeenCalled();
    await s.daily.tick(new Date('2026-09-20T08:00:00Z'));
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[0].slice(0, 5)).toEqual([
      userId,
      identityId,
      DAILY_JOB_TYPE,
      {
        date: '2026-09-19',
        since: '2026-09-18T20:00:00.000Z',
        until: '2026-09-19T19:59:59.999Z',
        options: { depth: 12, multiPv: 3 },
        provider: 'mock',
        model: 'deterministic-v1',
        positionsPerGame: 10,
        maxGames: 500,
      },
      '2026-09-19',
    ]);
    expect(enqueue.mock.calls[1].slice(0, 2)).toEqual([second.userId, second.id]);
    await s.daily.tick(new Date('2026-09-20T09:00:00Z'));
    expect(enqueue).toHaveBeenCalledTimes(2);
    const restarted = new DailyAnalysisScheduler(s.db, s.jobs, s.config, s.analysis, s.semantics);
    await restarted.tick(new Date('2026-09-20T09:00:00Z'));
    expect(enqueue.mock.calls[2].slice(0, 5)).toEqual(enqueue.mock.calls[0].slice(0, 5));
    await s.daily.tick(new Date('2026-09-20T23:00:00Z'));
    expect(enqueue.mock.calls[4][4]).toBe('2026-09-20');
  });

  it('retries capacity failures without blocking other users', async () => {
    const { enqueue } = schedulerMocks();
    enqueue.mockRejectedValueOnce(new DomainError('limits', 'queue full'));
    const now = new Date('2026-09-19T23:00:00Z');
    await s.daily.tick(now);
    expect(enqueue).toHaveBeenCalledTimes(2);
    await s.daily.tick(now);
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(enqueue.mock.calls[2][1]).toBe(identityId);
  });

  it('polls across 03:00 and stops its timer cleanly', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T22:59:50Z'));
    const { enqueue } = schedulerMocks();
    s.daily.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(enqueue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(enqueue).toHaveBeenCalledTimes(2);
    await s.daily.close();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it('does not schedule when disabled, stopped, or without the worker lease', async () => {
    const { enqueue } = schedulerMocks();
    const now = new Date('2026-09-19T23:00:00Z');
    s.config.DAILY_ANALYSIS_ENABLED = false;
    await s.daily.tick(now);
    s.config.DAILY_ANALYSIS_ENABLED = true;
    vi.spyOn(s.jobs, 'isRunning', 'get').mockReturnValue(false);
    await s.daily.tick(now);
    vi.spyOn(s.jobs, 'isRunning', 'get').mockReturnValue(true);
    await s.daily.close();
    await s.daily.tick(now);
    expect(enqueue).not.toHaveBeenCalled();
    expect(() => readConfig({ DATABASE_URL: 'unused', DAILY_ANALYSIS_ENABLED: '0' })).toThrow();
  });
});

describe('daily sync and analysis pipeline', () => {
  it('fetches both UTC archive months for a local day crossing the month boundary', async () => {
    vi.spyOn(s.identity, 'require').mockResolvedValue({
      username: 'fixture',
      playerId: randomUUID(),
    } as never);
    vi.spyOn(s.db, 'select').mockReturnValue({ from: () => ({ where: async () => [] }) } as never);
    const urls = ['2026/08', '2026/09', '2026/10', '2026/11'].map(
      (month) => `https://api.chess.com/pub/player/fixture/games/${month}`,
    );
    const request = vi
      .spyOn(s.upstream, 'request')
      .mockResolvedValue({ notModified: true, data: null, etag: null, lastModified: null });
    request.mockResolvedValueOnce({
      notModified: false,
      data: { archives: urls },
      etag: null,
      lastModified: null,
    });
    await s.games.sync(
      userId,
      identityId,
      2,
      async () => {},
      async () => {},
      {
        since: '2026-09-30T20:00:00.000Z',
        until: '2026-10-01T19:59:59.999Z',
      },
    );
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      '/pub/player/fixture/games/archives',
      '/pub/player/fixture/games/2026/09',
      '/pub/player/fixture/games/2026/10',
    ]);
  });
  const makeJob = (): Job =>
    ({
      id: randomUUID(),
      userId,
      identityId,
      type: DAILY_JOB_TYPE,
      state: 'queued',
      createdAt: new Date(),
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
      error: null,
      result: null,
      total: 0,
      completed: 0,
      failed: 0,
      retries: 0,
      cancelRequested: false,
      startedAt: null,
      finishedAt: null,
      payload: {
        ...dailyPeriod(new Date('2026-10-01T23:00:00Z')),
        options: { depth: 8, multiPv: 2 },
        provider: 'mock',
        model: 'deterministic-v1',
        positionsPerGame: 10,
        maxGames: 500,
      },
    }) as Job;
  const control = (): JobControl => ({
    progress: vi.fn(async () => {}),
    checkCancelled: vi.fn(async () => {}),
  });
  function mocks(ids: string[] = []) {
    const sync = vi
      .spyOn(s.games, 'sync')
      .mockResolvedValue({ imported: 1, deduplicated: 0, failed: 0, warnings: [] });
    const select = vi.spyOn(s.games, 'selectBatch').mockResolvedValue(ids);
    const where = vi.fn().mockResolvedValue(undefined),
      set = vi.fn(() => ({ where }));
    vi.spyOn(s.db, 'update').mockReturnValue({ set } as never);
    const runId = randomUUID();
    const analyze = vi.spyOn(s.analysis, 'analyze').mockResolvedValue({ runId, reused: true });
    vi.spyOn(s.analysis, 'critical').mockResolvedValue({
      runId,
      items: [{ id: randomUUID() }],
      nextOffset: null,
    } as never);
    const classify = vi.spyOn(s.semantics, 'classify').mockResolvedValue({ status: 'succeeded' });
    return { sync, select, set, where, analyze, classify };
  }

  it('syncs before selecting and persists games before analyzing and classifying', async () => {
    const ids = [randomUUID()];
    const m = mocks(ids),
      j = makeJob();
    const result = await dailyAnalysisHandler(s.db, s.games, s.analysis, s.semantics)(j, control());
    expect(m.sync.mock.calls[0][5]).toEqual({
      since: '2026-09-30T20:00:00.000Z',
      until: '2026-10-01T19:59:59.999Z',
    });
    expect(m.select).toHaveBeenCalledWith(
      userId,
      identityId,
      { since: j.payload.since, until: j.payload.until, timeControl: 'rapid' },
      500,
    );
    expect(m.sync.mock.invocationCallOrder[0]).toBeLessThan(m.select.mock.invocationCallOrder[0]);
    expect(m.where.mock.invocationCallOrder[0]).toBeLessThan(m.analyze.mock.invocationCallOrder[0]);
    expect(m.set).toHaveBeenCalledWith({ payload: { ...j.payload, gameIds: ids } });
    expect(result).toMatchObject({ date: '2026-10-01', analyzed: 1, classified: 1, failed: 0 });
    expect(m.classify).toHaveBeenCalledTimes(1);
    j.payload.gameIds = ids;
    await dailyAnalysisHandler(s.db, s.games, s.analysis, s.semantics)(j, control());
    expect(m.sync).toHaveBeenCalledTimes(1);
    expect(m.select).toHaveBeenCalledTimes(1);
  });

  it('finishes empty days without engine/provider work', async () => {
    const m = mocks();
    expect(
      await dailyAnalysisHandler(s.db, s.games, s.analysis, s.semantics)(makeJob(), control()),
    ).toMatchObject({ skipped: 'no_matching_games', analyzed: 0, classified: 0 });
    expect(m.analyze).not.toHaveBeenCalled();
    expect(m.classify).not.toHaveBeenCalled();
  });

  it('stops on incomplete sync and propagates cancellation', async () => {
    const m = mocks();
    m.sync.mockResolvedValueOnce({ imported: 1, deduplicated: 0, failed: 1, warnings: [] });
    const handler = dailyAnalysisHandler(s.db, s.games, s.analysis, s.semantics);
    await expect(handler(makeJob(), control())).rejects.toMatchObject({ code: 'sync_failed' });
    expect(m.select).not.toHaveBeenCalled();
    const c = control();
    vi.mocked(c.checkCancelled).mockRejectedValue(new DomainError('cancelled', 'cancelled'));
    await expect(handler(makeJob(), c)).rejects.toMatchObject({ code: 'cancelled' });
    expect(m.sync).toHaveBeenCalledTimes(1);
    expect(m.analyze).not.toHaveBeenCalled();
  });
});
