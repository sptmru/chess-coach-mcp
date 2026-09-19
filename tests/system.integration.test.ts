import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Chess } from 'chess.js';
import { readConfig } from '../src/config.js';
import { createServices, type Services } from '../src/services/container.js';
import { ChessComClient, type UpstreamGame } from '../src/chesscom/client.js';
import { createApp } from '../src/http.js';
import { users, games, analysisRuns, jobs, identities, notes } from '../src/database/schema.js';
import { passwordHash } from '../src/auth/provider.js';
import { toolDefinitions } from '../src/mcp/tools.js';
import { secret, sleep } from '../src/utils/core.js';
let s: Services,
  server: Server,
  base: string,
  pgn: string,
  u1: string,
  u2: string,
  i1: string,
  i2: string,
  g1: string,
  exerciseId: string,
  setId: string;
let archiveRequests = 0;
const fixtures: UpstreamGame[] = [];
const password = 'fixture-password-with-entropy';
const callback = 'http://localhost:9876/callback';
const now = new Date();
const archivePath = `/pub/player/fixture-white/games/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
const mockFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  let body: unknown;
  if (url.pathname === archivePath) {
    archiveRequests++;
    if (new Headers(init?.headers).get('if-none-match') === 'fixture-v1')
      return new Response(null, { status: 304 });
    body = { games: fixtures };
  } else if (url.pathname.endsWith('/games/archives'))
    body = { archives: ['https://api.chess.com' + archivePath] };
  else {
    const name = url.pathname.split('/').at(-1)!;
    body = { player_id: name === 'fixture-white' ? 123 : 456, username: name };
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', etag: 'fixture-v1' },
  });
};
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !new URL(url).pathname.endsWith('_test'))
    throw new Error('TEST_DATABASE_URL must point to a dedicated database ending in _test');
  pgn = await readFile(new URL('./fixtures/fools-mate.pgn', import.meta.url), 'utf8');
  s = createServices(
    readConfig({
      DATABASE_URL: url,
      NODE_ENV: 'test',
      STOCKFISH_PATH: process.env.STOCKFISH_PATH ?? '/usr/games/stockfish',
      ANALYSIS_DEPTH: '8',
      MAX_DEPTH: '12',
      OAUTH_REDIRECT_URIS: callback,
      LOG_LEVEL: 'silent',
    }),
    new ChessComClient('FixtureTests', mockFetch),
  );
  await migrate(s.db, { migrationsFolder: './drizzle' });
  // This is a dedicated, disposable fixture DB; never a developer or production DB.
  await s.db.execute(
    sql`truncate table users, chess_players, games, oauth_clients, oauth_requests restart identity cascade`,
  );
  const hash = await passwordHash(password);
  [u1, u2] = (
    await s.db
      .insert(users)
      .values([
        { email: 'one@example.test', passwordHash: hash },
        { email: 'two@example.test', passwordHash: hash },
      ])
      .returning()
  ).map((u) => u.id);
  i1 = (await s.identity.associate(u1, 'FIXTURE-WHITE')).id;
  i2 = (await s.identity.associate(u2, 'fixture-opponent')).id;
  for (let n = 0; n < 3; n++)
    fixtures.push({
      uuid: `fixture-game-${n}`,
      pgn,
      url: `https://www.chess.com/game/live/${90000 + n}`,
      end_time: Date.parse(`2026-09-0${n + 1}T12:10:00Z`) / 1000,
      time_control: '600+5',
      time_class: 'rapid',
      rated: true,
      rules: 'chess',
      white: { username: 'fixture-white', rating: 1050 + n, result: 'checkmated' },
      black: { username: 'fixture-opponent', rating: 1080, result: 'win' },
    });
  await s.engine.start();
});
afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (s) await s.close();
});
describe.sequential('PostgreSQL + Stockfish acceptance', () => {
  it('migrates, links unverified players, syncs incrementally and deduplicates shared games', async () => {
    expect((await s.identity.list(u1))[0].verified).toBe(false);
    const result = await s.games.sync(
      u1,
      i1,
      12,
      async () => {},
      async () => {},
    );
    expect(result.imported).toBe(3);
    const next = await s.games.sync(
      u1,
      i1,
      12,
      async () => {},
      async () => {},
    );
    expect(next.imported).toBe(0);
    expect(archiveRequests).toBe(2);
    const two = await s.identity.require(u2, i2);
    await s.games.ingest(two.playerId, two.username, fixtures[0]);
    expect(await s.db.select().from(games)).toHaveLength(3);
    g1 = (await s.games.list(u1, i1)).items.at(-1)!.id;
    expect((await s.games.get(u2, i2, g1)).color).toBe('b');
    expect(await s.games.get(u1, i1, g1)).not.toHaveProperty('pgn');
    const other = (await s.games.list(u1, i1)).items[0].id;
    await expect(s.games.get(u2, i2, other)).rejects.toThrow('not accessible');
  });
  it('reports missing analysis without creating an empty classification job', async () => {
    const tool = toolDefinitions(s).find((t) => t.name === 'classify_game_positions')!;
    expect(await tool.execute({ gameId: g1 }, { userId: u1, correlationId: randomUUID() })).toEqual(
      {
        gameId: g1,
        skipped: 'no_compatible_analysis',
        requiresAnalysis: true,
      },
    );
    expect(await s.db.select().from(jobs)).toHaveLength(0);
  });
  it('analyzes actual Stockfish, reuses compatible runs globally and keeps versions separate', async () => {
    const options = { depth: 8, multiPv: 2 };
    const [a, b] = await Promise.all([
      s.analysis.analyze(u1, i1, g1, options),
      s.analysis.analyze(u2, i2, g1, options),
    ]);
    expect(a.runId).toBe(b.runId);
    expect(await s.db.select().from(analysisRuns)).toHaveLength(1);
    expect((await s.analysis.analyze(u2, i2, g1, options)).reused).toBe(true);
    const c = await s.analysis.analyze(u1, i1, g1, { depth: 9, multiPv: 2 });
    expect(c.runId).not.toBe(a.runId);
    const critical = await s.analysis.critical(u1, i1, g1, c.runId);
    expect(critical.items.length).toBeGreaterThan(0);
    expect(critical.items[0].contributingPlies.length).toBeGreaterThan(0);
    const second = await s.analysis.critical(u2, i2, g1, c.runId);
    expect(second.items.every((p) => p.perspective === 'b')).toBe(true);
    const position = await s.analysis.position(u1, i1, critical.items[0].id);
    expect(position.move.cpl === null || position.move.cpl >= 0).toBe(true);
    await expect(s.analysis.position(u2, i2, critical.items[0].id)).rejects.toThrow();
  });
  it('rejects obsolete runs while finding an older compatible run and preserving its depth', async () => {
    const { game } = await s.games.require(u1, i1, g1);
    const compatible = await s.analysis.latestCompatible(game);
    expect(compatible?.config.depth).toBe(9);
    const [obsolete] = await s.db
      .insert(analysisRuns)
      .values({
        gameId: g1,
        fingerprint: randomUUID(),
        engineVersion: s.engine.version,
        algorithmVersion: 'obsolete-fixture',
        config: s.analysis.metadata({ depth: 12, multiPv: 3 }),
        status: 'completed',
        completedAt: new Date(),
      })
      .returning();
    try {
      expect((await s.analysis.latestCompatible(game))?.id).toBe(compatible?.id);
      const tool = toolDefinitions(s).find((t) => t.name === 'classify_game_positions')!;
      expect(
        await tool.execute(
          { gameId: g1, runId: obsolete.id },
          { userId: u1, correlationId: randomUUID() },
        ),
      ).toMatchObject({ skipped: 'no_compatible_analysis', requiresAnalysis: true });
      expect(
        await s.analysis.latestCompatible({ ...game, contentHash: 'changed-fixture' }),
      ).toBeUndefined();
      // Runtime-setting changes are incompatible even if engine and algorithm names match.
      const previousHash = s.engine.binaryHash;
      s.engine.binaryHash = 'changed-binary-fixture';
      try {
        expect(await s.analysis.latestCompatible(game)).toBeUndefined();
      } finally {
        s.engine.binaryHash = previousHash;
      }
    } finally {
      await s.db.delete(analysisRuns).where(eq(analysisRuns.id, obsolete.id));
    }
  });
  it('compares arbitrary moves and returns bounded MultiPV without corrupting perspective', async () => {
    const result = await s.engine.analyze(new Chess().fen(), { depth: 8, multiPv: 2 });
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].score.type).toBe('cp');
    const compare = await s.analysis.compare(new Chess().fen(), 'e4', { depth: 8, multiPv: 2 });
    expect(compare.playedMove).toBe('e2e4');
    expect(compare.perspective).toBe('w');
    await expect(s.engine.analyze(new Chess().fen(), { depth: 999, multiPv: 1 })).rejects.toThrow();
  });
  it('classifies own positions idempotently, detects repeated evidence and builds compatible reports', async () => {
    for (const game of (await s.games.list(u1, i1)).items) {
      await s.analysis.analyze(u1, i1, game.id, { depth: 9, multiPv: 2 });
      for (const p of (await s.analysis.critical(u1, i1, game.id)).items) {
        const a = await s.semantics.classify(u1, i1, p.id, 'mock');
        expect(await s.semantics.classify(u1, i1, p.id, 'mock')).toEqual(a);
      }
    }
    const report = await s.reports.report(u1, i1);
    expect(report.gamesAnalyzed).toBe(3);
    expect(report.mateTransitionsExcludedFromCpl).toBeGreaterThan(0);
    const patterns = await s.reports.mistakePatterns(u1, i1);
    expect(patterns.items.some((p) => p.detected)).toBe(true);
    const periods = await s.reports.compare(
      u1,
      i1,
      { since: '2026-09-01T00:00:00Z', until: '2026-09-01T23:59:59Z' },
      { since: '2026-09-02T00:00:00Z', until: '2026-09-03T23:59:59Z' },
    );
    expect(periods.compatible).toBe(true);
    expect(periods.first.gamesAnalyzed).toBe(1);
    expect(periods.second.gamesAnalyzed).toBe(2);
  });
  it('creates answer-free training sets, independently authorizes solutions, preserves append-only attempts', async () => {
    const set = await s.training.createSet(u1, i1, { count: 3 });
    setId = set.trainingSetId;
    expect(set.items).toHaveLength(3);
    exerciseId = set.items[0].exerciseId;
    expect(JSON.stringify(set)).not.toContain('bestMove');
    expect(await s.training.set(u1, setId)).not.toHaveProperty('solution');
    expect(await s.training.solution(u1, exerciseId)).toHaveProperty('bestMove');
    await expect(s.training.set(u2, setId)).rejects.toThrow();
    await expect(s.training.solution(u2, exerciseId)).rejects.toThrow();
    await expect(
      s.training.record(u2, { exerciseId, idempotencyKey: randomUUID(), result: 'solved' }),
    ).rejects.toThrow();
    const key = randomUUID();
    const attempt = await s.training.record(u1, {
      exerciseId,
      idempotencyKey: key,
      result: 'partial',
    });
    expect(
      await s.training.record(u1, { exerciseId, idempotencyKey: key, result: 'partial' }),
    ).toEqual(attempt);
    await expect(
      s.training.record(u1, { exerciseId, idempotencyKey: key, result: 'solved' }),
    ).rejects.toThrow('already used');
    await s.training.record(u1, { exerciseId, idempotencyKey: randomUUID(), result: 'solved' });
    expect((await s.training.progress(u1, i1)).items).toHaveLength(2);
  });
  it('isolates coaching notes, focuses, profiles and job IDs between users', async () => {
    const note = await s.coaching.addNote(u1, i1, {
      note: 'Private defensive scan',
      reviewAfterGames: 10,
    });
    const focus = await s.coaching.setFocus(u1, i1, {
      focus: 'defensive scan',
      reason: 'Repeated forced mate',
      durationGames: 10,
    });
    await expect(
      s.db
        .insert(notes)
        .values({ userId: u2, identityId: i1, note: 'cross-owner', baselineGames: 0 }),
    ).rejects.toThrow();
    expect((await s.coaching.notes(u2, i2)).items).toHaveLength(0);
    await expect(s.coaching.notes(u2, i1)).rejects.toThrow();
    await expect(s.coaching.archiveNote(u2, note.id)).rejects.toThrow();
    await expect(s.coaching.completeFocus(u2, focus.id, 'completed')).rejects.toThrow();
    expect(JSON.stringify(await s.coaching.context(u2, i2))).not.toContain(
      'Private defensive scan',
    );
    const job = await s.jobs.enqueue(
      u1,
      i1,
      'analysis',
      { gameIds: [g1], options: { depth: 9, multiPv: 2 } },
      'job-fixture',
      randomUUID(),
    );
    await expect(s.jobs.get(u2, job.id)).rejects.toThrow();
    await expect(s.jobs.cancel(u2, job.id)).rejects.toThrow();
    await s.db.update(jobs).set({ state: 'running' }).where(eq(jobs.id, job.id));
    await s.jobs.recover();
    expect(await s.jobs.get(u1, job.id)).toMatchObject({ state: 'queued', retries: 1 });
    await s.jobs.start();
    for (let n = 0; n < 100; n++) {
      const state = await s.jobs.get(u1, job.id);
      if (state.state === 'succeeded') break;
      await sleep(100);
    }
    expect(await s.jobs.get(u1, job.id)).toMatchObject({ state: 'succeeded', completed: 1 });
  });
  it('runs and retries a date-filtered pipeline through the persistent queue, and cancels a queued batch', async () => {
    const tool = toolDefinitions(s).find((t) => t.name === 'analyze_and_classify_games')!;
    const ctx = { userId: u1, correlationId: randomUUID() };
    const args = {
      since: '2026-09-02T00:00:00Z',
      until: '2026-09-03T23:59:59Z',
      depth: 9,
      multiPv: 2,
    };
    const queued = (await tool.execute(args, ctx)) as { id: string; selected: number };
    expect(queued.selected).toBe(2);
    await expect(s.jobs.get(u2, queued.id)).rejects.toThrow();
    const wait = async (id: string) => {
      for (let n = 0; n < 100; n++) {
        const job = await s.jobs.get(u1, id);
        if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job;
        await sleep(100);
      }
      throw new Error('Fixture batch did not finish');
    };
    const completed = await wait(queued.id);
    expect(completed).toMatchObject({
      state: 'succeeded',
      total: 2,
      completed: 2,
      failed: 0,
      result: { analyzed: 2, partial: false },
    });
    expect((completed.result as { classified: number }).classified).toBeGreaterThan(0);
    expect((completed.result as { runs: { reused: boolean }[] }).runs.every((r) => r.reused)).toBe(
      true,
    );
    expect(await tool.execute(args, ctx)).toMatchObject({ id: queued.id });
    const retry = (await tool.execute({ ...args, retry: true }, ctx)) as { id: string };
    expect(retry.id).not.toBe(queued.id);
    expect(await wait(retry.id)).toMatchObject({ state: 'succeeded', result: completed.result });
    const cancel = (await tool.execute({ ...args, retry: true }, ctx)) as { id: string };
    await s.jobs.cancel(u1, cancel.id);
    expect(await wait(cancel.id)).toMatchObject({ state: 'cancelled' });
  });
  it('deleting an association cascades personal state without deleting shared games or analysis', async () => {
    const disposable = await s.identity.associate(u2, 'fixture-white');
    const note = await s.coaching.addNote(u2, disposable.id, { note: 'will be deleted' });
    expect(note).toBeTruthy();
    await s.identity.remove(u2, disposable.id);
    expect(
      await s.db.select().from(identities).where(eq(identities.id, disposable.id)),
    ).toHaveLength(0);
    expect(await s.db.select().from(games)).toHaveLength(3);
    expect((await s.db.select().from(analysisRuns)).length).toBeGreaterThan(0);
    expect(await s.training.solution(u1, exerciseId)).toHaveProperty('bestMove');
  });
});
async function oauth(email: string) {
  const reg = await fetch(base + '/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Fixture Client',
      redirect_uris: [callback],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(reg.status).toBe(201);
  const client = (await reg.json()) as { client_id: string };
  const verifier = secret();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: callback,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: s.config.PUBLIC_URL + '/mcp',
    scope: 'chess:coach',
    state: 'fixture-state',
  });
  const auth = await fetch(base + '/authorize?' + params);
  expect(auth.status).toBe(200);
  expect(auth.headers.get('referrer-policy')).toBe('same-origin');
  expect(auth.headers.get('content-security-policy')).toContain(
    `form-action 'self' ${new URL(callback).origin}`,
  );
  const html = await auth.text();
  const requestId = /name="requestId" value="([^"]+)"/.exec(html)![1],
    csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
  const cookie = auth.headers.get('set-cookie')!.split(';')[0];
  const consent = await fetch(base + '/consent', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie,
      origin: s.config.PUBLIC_URL,
    },
    body: new URLSearchParams({ requestId, csrf, email, password, decision: 'allow' }),
  });
  expect(consent.status).toBe(302);
  const redirect = new URL(consent.headers.get('location')!);
  expect(redirect.searchParams.get('iss')).toBe(s.config.PUBLIC_URL);
  expect(redirect.searchParams.get('state')).toBe('fixture-state');
  const code = redirect.searchParams.get('code')!;
  const body = {
    client_id: client.client_id,
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: callback,
    resource: s.config.PUBLIC_URL + '/mcp',
  };
  const wrong = await fetch(base + '/token', {
    method: 'POST',
    body: new URLSearchParams({ ...body, code_verifier: secret() }),
  });
  expect(wrong.status).toBe(400);
  const token = await fetch(base + '/token', { method: 'POST', body: new URLSearchParams(body) });
  expect(token.status).toBe(200);
  const tokens = (await token.json()) as { access_token: string; refresh_token: string };
  const reused = await fetch(base + '/token', { method: 'POST', body: new URLSearchParams(body) });
  expect(reused.status).toBe(400);
  return { ...tokens, clientId: client.client_id };
}
describe.sequential('Remote MCP OAuth and tenant authorization', () => {
  beforeAll(async () => {
    server = createApp(s).listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('missing address');
    base = `http://127.0.0.1:${addr.port}`;
  });
  it('advertises protected resource, PKCE S256 and issuer; challenges unauthenticated access', async () => {
    const unauth = await fetch(base + '/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toContain('resource_metadata');
    const meta = await (await fetch(base + '/.well-known/oauth-authorization-server')).json();
    expect(meta.code_challenge_methods_supported).toContain('S256');
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    const resource = await (await fetch(base + '/.well-known/oauth-protected-resource/mcp')).json();
    expect(resource.resource).toBe(s.config.PUBLIC_URL + '/mcp');
  });
  it('authenticates two users over real HTTP, rejects cross-user tool access and refresh replay', async () => {
    const one = await oauth('one@example.test'),
      two = await oauth('two@example.test');
    const client = new Client({ name: 'integration', version: '1' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${two.access_token}` } },
      }),
    );
    const list = await client.listTools();
    expect(list.tools.length).toBe(toolDefinitions(s).length);
    expect(
      list.tools.find((t) => t.name === 'analyze_and_classify_games')?.annotations,
    ).toMatchObject({ readOnlyHint: false, openWorldHint: true });
    expect(list.tools.find((t) => t.name === 'analyze_games')?.annotations).toMatchObject({
      readOnlyHint: false,
      openWorldHint: false,
    });
    const me = await client.callTool({ name: 'get_me', arguments: {} });
    expect(JSON.stringify(me)).toContain(u2);
    expect(JSON.stringify(me)).not.toContain(u1);
    const denied = await client.callTool({
      name: 'get_training_position_solution',
      arguments: { exerciseId },
    });
    expect(denied.isError).toBe(true);
    const deniedSet = await client.callTool({
      name: 'get_training_set',
      arguments: { trainingSetId: setId },
    });
    expect(deniedSet.isError).toBe(true);
    await client.close();
    const refreshBody = {
      grant_type: 'refresh_token',
      client_id: one.clientId,
      refresh_token: one.refresh_token,
      resource: s.config.PUBLIC_URL + '/mcp',
    };
    const wrongAudience = await fetch(base + '/token', {
      method: 'POST',
      body: new URLSearchParams({ ...refreshBody, resource: 'https://wrong.example/mcp' }),
    });
    expect(wrongAudience.status).toBe(400);
    const refreshed = await fetch(base + '/token', {
      method: 'POST',
      body: new URLSearchParams(refreshBody),
    });
    expect(refreshed.status).toBe(200);
    const newTokens = await refreshed.json();
    const replay = await fetch(base + '/token', {
      method: 'POST',
      body: new URLSearchParams(refreshBody),
    });
    expect(replay.status).toBe(400);
    const revoked = await fetch(base + '/mcp', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${newTokens.access_token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(revoked.status).toBe(401);
  });
  it('rejects unregistered redirect URIs and untrusted origins', async () => {
    const reg = await fetch(base + '/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: ['https://attacker.test/cb'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(reg.status).toBe(400);
    for (const path of ['/mcp', '/', '/consent']) {
      for (const origin of ['https://attacker.test', 'null']) {
        const response = await fetch(base + path, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: '{}',
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: 'untrusted_origin' });
      }
    }
  });
});

it('serves clean stdio protocol and exits on client EOF', async () => {
  await s.jobs.close();
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--stdio'], {
    env: {
      ...process.env,
      DATABASE_URL: s.config.DATABASE_URL,
      STDIO_USER_ID: u1,
      STOCKFISH_PATH: s.config.STOCKFISH_PATH,
      LOG_LEVEL: 'silent',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const input = createInterface({ input: child.stdout });
  const received: Record<string, unknown>[] = [];
  input.on('line', (line) => received.push(JSON.parse(line)));
  const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'stdio-fixture', version: '1' },
        },
      }) + '\n',
    );
    for (let n = 0; n < 100 && !received.some((r) => r.id === 1); n++) await sleep(50);
    expect(received.find((r) => r.id === 1)).toHaveProperty('result');
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_me', arguments: {} },
      }) + '\n',
    );
    for (let n = 0; n < 100 && !received.some((r) => r.id === 2); n++) await sleep(50);
    expect(JSON.stringify(received.find((r) => r.id === 2))).toContain(u1);
    child.stdin.end();
    expect(await Promise.race([exit, sleep(5000).then(() => 'timeout')])).toBe(0);
  } finally {
    child.kill('SIGKILL');
    input.close();
  }
});
