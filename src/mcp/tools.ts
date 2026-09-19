import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestContext } from '../domain/types.js';
import type { Services } from '../services/container.js';
import { DomainError, hash, log, metric, safeError } from '../utils/core.js';
import { validFen } from '../chess/normalize.js';
import { labels } from '../semantics/reasoner.js';
export const uuid = z.string().uuid();
export const date = z.string().datetime({ offset: true });
export const fen = z.string().min(15).max(200).refine(validFen, 'Invalid FEN');
export const move = z
  .string()
  .min(2)
  .max(12)
  .regex(/^[a-hqrbnKQRBNO0-8x=+#-]+$/, 'Invalid SAN or UCI notation');
const identity = { identityId: uuid.optional() };
const page = {
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(10000).default(0),
};
const filters = {
  ...identity,
  since: date.optional(),
  until: date.optional(),
  timeControl: z.enum(['rapid', 'blitz', 'bullet', 'daily']).optional(),
  analysisKey: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
};
const period = z
  .object({ since: date, until: date })
  .refine((p) => new Date(p.since) <= new Date(p.until), 'since must be before until');
const training = {
  ...identity,
  count: z.number().int().min(1).max(20).default(5),
  theme: z.enum(labels).optional(),
  since: date.optional(),
  timeControl: z.enum(['rapid', 'blitz', 'bullet', 'daily']).optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  pattern: z.enum(labels).optional(),
};
export type ToolDefinition = {
  name: string;
  description: string;
  schema: z.ZodObject;
  readOnly: boolean;
  destructive: boolean;
  execute: (input: unknown, ctx: RequestContext) => Promise<unknown>;
};
export function toolDefinitions(s: Services) {
  const tools: ToolDefinition[] = [];
  function add<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    fn: (args: z.output<z.ZodObject<S>>, ctx: RequestContext) => Promise<unknown>,
    readOnly = true,
    destructive = false,
  ) {
    const schema = z.object(shape).strict();
    tools.push({
      name,
      description,
      schema,
      readOnly,
      destructive,
      execute: async (args, ctx) => fn(schema.parse(args), ctx),
    });
  }
  const options = {
    depth: z.number().int().min(1).max(s.config.MAX_DEPTH).default(s.config.ANALYSIS_DEPTH),
    multiPv: z
      .number()
      .int()
      .min(1)
      .max(s.config.MAX_MULTIPV)
      .default(Math.min(3, s.config.MAX_MULTIPV)),
  };
  const provider = {
    provider: z
      .enum(s.semantics.approved().map((r) => r.provider))
      .default(s.semantics.configured.provider)
      .describe(
        'Omit to use REASONER_PROVIDER from the server environment. Use mock only for an explicit deterministic comparison.',
      ),
    model: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Omit to use the server-configured model for the selected provider.'),
  };
  const enqueueAnalysis = async (
    ctx: RequestContext,
    identityId: string | undefined,
    gameIds: string[],
    o: { depth: number; multiPv: number },
    retry: boolean,
  ) => {
    const i = await s.identity.require(ctx.userId, identityId);
    for (const id of gameIds) await s.games.require(ctx.userId, i.id, id);
    return s.jobs.enqueue(
      ctx.userId,
      i.id,
      'analysis',
      { gameIds, options: { depth: o.depth, multiPv: o.multiPv } },
      hash({
        gameIds: [...gameIds].sort(),
        compatibility: s.analysis.compatibility(o),
        retry: retry ? randomUUID() : undefined,
      }),
      ctx.correlationId,
    );
  };
  add('get_me', 'Authenticated account and unverified public chess identities.', {}, (_, c) =>
    s.identity.me(c.userId),
  );
  add(
    'associate_chesscom_username',
    'Link an existing public Chess.com player; does not verify account ownership.',
    {
      username: z
        .string()
        .min(3)
        .max(25)
        .regex(/^[a-zA-Z0-9_-]+$/),
    },
    (a, c) => s.identity.associate(c.userId, a.username),
    false,
  );
  add('list_chess_identities', 'List your linked Chess.com identities.', {}, async (_, c) => ({
    items: await s.identity.list(c.userId),
  }));
  add(
    'set_primary_chess_identity',
    'Choose your default analyzed player.',
    { identityId: uuid },
    (a, c) => s.identity.primary(c.userId, a.identityId),
    false,
  );
  add(
    'remove_chess_identity',
    'Delete this association and its personal coaching/training history. Shared public games remain.',
    { identityId: uuid },
    (a, c) => s.identity.remove(c.userId, a.identityId),
    false,
    true,
  );
  add(
    'get_player_profile',
    'Public Chess.com profile and rating statistics for your associated player.',
    identity,
    async (a, c) => {
      const i = await s.identity.require(c.userId, a.identityId);
      return {
        identity: i,
        profile: await s.upstream.profile(i.username),
        stats: await s.upstream.stats(i.username),
      };
    },
  );
  add(
    'sync_games',
    'Queue incremental import of standard Rapid games from recent monthly archives. Poll job ID.',
    { ...identity, months: z.number().int().min(1).max(12).default(2) },
    async (a, c) => {
      const i = await s.identity.require(c.userId, a.identityId);
      return s.jobs.enqueue(
        c.userId,
        i.id,
        'sync',
        { months: a.months },
        `sync:${a.months}:${Math.floor(Date.now() / 60000)}`,
        c.correlationId,
      );
    },
    false,
  );
  for (const name of ['get_sync_status', 'get_analysis_status', 'get_job'])
    add(name, 'Get progress of a job owned by your account.', { jobId: uuid }, (a, c) =>
      s.jobs.get(c.userId, a.jobId),
    );
  add(
    'cancel_job',
    'Request cancellation at the next safe boundary.',
    { jobId: uuid },
    (a, c) => s.jobs.cancel(c.userId, a.jobId),
    false,
  );
  for (const name of ['get_games', 'get_recent_games'])
    add(
      name,
      'Compact games, newest first; use cursor for more.',
      { ...filters, limit: page.limit, cursor: z.string().max(500).optional() },
      (a, c) => s.games.list(c.userId, a.identityId, a),
    );
  add(
    'get_game',
    'Get a linked player game. PGN and full moves are opt-in.',
    {
      ...identity,
      gameId: uuid,
      includePgn: z.boolean().default(false),
      includeMoves: z.boolean().default(false),
    },
    (a, c) => s.games.get(c.userId, a.identityId, a.gameId, a.includePgn, a.includeMoves),
  );
  add(
    'analyze_game',
    'Queue versioned Stockfish analysis. Compatible completed runs are reused. retry creates a new job, not duplicate analysis.',
    { ...identity, gameId: uuid, ...options, retry: z.boolean().default(false) },
    (a, c) => enqueueAnalysis(c, a.identityId, [a.gameId], a, a.retry),
    false,
  );
  add(
    'analyze_recent_games',
    'Queue bounded Stockfish analysis of your recent games.',
    {
      ...identity,
      count: z
        .number()
        .int()
        .min(1)
        .max(s.config.MAX_ANALYSIS_GAMES)
        .default(Math.min(10, s.config.MAX_ANALYSIS_GAMES)),
      ...options,
      retry: z.boolean().default(false),
    },
    async (a, c) => {
      const games = await s.games.list(c.userId, a.identityId, {
        limit: a.count,
        timeControl: 'rapid',
      });
      return enqueueAnalysis(
        c,
        a.identityId,
        games.items.map((g) => g.id),
        a,
        a.retry,
      );
    },
    false,
  );
  add(
    'get_critical_positions',
    'Grouped critical positions for your side of one game.',
    {
      ...identity,
      gameId: uuid,
      runId: uuid.optional(),
      detail: z.enum(['summary', 'standard', 'full']).default('summary'),
      ...page,
    },
    (a, c) =>
      s.analysis.critical(c.userId, a.identityId, a.gameId, a.runId, a.limit, a.offset, a.detail),
  );
  const batch = {
    ...identity,
    since: date.optional(),
    until: date.optional(),
    timeControl: z.enum(['rapid', 'blitz', 'bullet', 'daily']).default('rapid'),
    maxGames: z
      .number()
      .int()
      .min(1)
      .max(s.config.MAX_BATCH_ANALYSIS_GAMES)
      .default(s.config.MAX_BATCH_ANALYSIS_GAMES)
      .describe('Safety cap, not a page size. If more games match, narrow the date range.'),
    ...options,
    retry: z.boolean().default(false),
  };
  const enqueueBatch = async (
    a: z.output<z.ZodObject<typeof batch>>,
    c: RequestContext,
    classification?: { provider: string; model: string; positionsPerGame: number },
  ) => {
    const i = await s.identity.require(c.userId, a.identityId);
    const gameIds = await s.games.selectBatch(
      c.userId,
      i.id,
      {
        since: a.since,
        until: a.until,
        timeControl: a.timeControl,
      },
      a.maxGames,
    );
    if (!gameIds.length) return { skipped: 'no_matching_games', selected: 0 };
    const o = { depth: a.depth, multiPv: a.multiPv };
    const job = await s.jobs.enqueue(
      c.userId,
      i.id,
      classification ? 'analysis_classification' : 'analysis',
      { gameIds, options: o, ...classification },
      hash({
        gameIds: [...gameIds].sort(),
        compatibility: s.analysis.compatibility(o),
        ...(classification ? { classification } : {}),
        retry: a.retry ? randomUUID() : undefined,
      }),
      c.correlationId,
    );
    return { ...job, selected: gameIds.length };
  };
  add(
    'analyze_games',
    'Analyze all imported games matching since/until (inclusive) and timeControl in one background job. Default cap 500, configurable by operator; overflow is rejected, never truncated. Poll get_job. Compatible analyses are reused; retry creates a new job.',
    batch,
    (a, c) => enqueueBatch(a, c),
    false,
  );
  add(
    'analyze_and_classify_games',
    'Analyze matching imported games, then classify your grouped positions from each exact run in one background job. Explicit opt-in to the configured reasoner. Poll get_job for per-game progress/results; cancel_job stops at safe boundaries. Reuses completed work.',
    { ...batch, ...provider, positionsPerGame: z.number().int().min(1).max(20).default(10) },
    (a, c) => {
      const selected = s.semantics.resolveReasoner(a.provider, a.model);
      return enqueueBatch(a, c, {
        provider: selected.provider,
        model: selected.model,
        positionsPerGame: a.positionsPerGame,
      });
    },
    false,
  );
  add(
    'analyze_position',
    'Analyze arbitrary valid FEN with bounded MultiPV. Evaluations are canonical White perspective.',
    { fen, ...options },
    async (a) => ({
      fen: a.fen,
      perspective: 'white',
      ...(await s.engine.analyze(a.fen, a)),
      engine: s.engine.version,
      config: s.analysis.metadata(a),
    }),
  );
  add(
    'compare_move',
    'Compare a legal proposed SAN/UCI move with the engine best move at equal search depth.',
    { fen, move, ...options },
    (a) => s.analysis.compare(a.fen, a.move, a),
  );
  add(
    'get_player_report',
    'Structured compatible-analysis metrics, sample sizes and limitations.',
    filters,
    (a, c) => s.reports.report(c.userId, a.identityId, a),
  );
  add(
    'get_mistake_patterns',
    'Repeated classified evidence, requiring multiple positions and games; returns insufficient-data status.',
    { ...filters, minimumEvidence: z.number().int().min(3).max(20).default(3) },
    (a, c) => s.reports.mistakePatterns(c.userId, a.identityId, a, a.minimumEvidence),
  );
  add(
    'find_similar_mistakes',
    'Find your own grouped positions by semantic label.',
    {
      ...filters,
      ...page,
      type: z.enum(labels).optional(),
      pattern: z.enum(labels).optional(),
      minimumSeverity: z.number().min(0).max(1000).default(0),
    },
    (a, c) => s.reports.similar(c.userId, a.identityId, a),
  );
  add(
    'compare_periods',
    'Compare two date ranges using the same engine/algorithm/settings; includes sample sizes.',
    { ...identity, first: period, second: period },
    (a, c) => s.reports.compare(c.userId, a.identityId, a.first, a.second),
  );
  add(
    'get_opening_report',
    'Opening frequency, results and ACPL. Theory exit is explicitly unavailable without a full theory database.',
    filters,
    (a, c) => s.reports.openings(c.userId, a.identityId, a),
  );
  add(
    'get_time_management_report',
    'Clock-bucket metrics with missing-clock counts and correlation caveat.',
    filters,
    (a, c) => s.reports.time(c.userId, a.identityId, a),
  );
  add(
    'classify_critical_position',
    'Classify one owned critical position using the server-configured provider and model. Omit provider and model for normal use. Explicit opt-in to configured remote reasoner; defaults to deterministic when disabled.',
    { ...identity, positionId: uuid, ...provider },
    (a, c) => s.semantics.classify(c.userId, a.identityId, a.positionId, a.provider, a.model),
    false,
  );
  add(
    'classify_game_positions',
    'Queue bounded classification of a game’s grouped positions using the server-configured provider and model. Returns skipped=no_compatible_analysis and requiresAnalysis=true if analysis is missing or incompatible; use analyze_and_classify_games. Omit provider and model for normal use.',
    {
      ...identity,
      gameId: uuid,
      runId: uuid.optional(),
      ...provider,
      count: z.number().int().min(1).max(20).default(10),
      retry: z.boolean().default(false),
    },
    async (a, c) => {
      const selected = s.semantics.resolveReasoner(a.provider, a.model);
      const i = await s.identity.require(c.userId, a.identityId);
      const critical = await s.analysis.critical(
        c.userId,
        i.id,
        a.gameId,
        a.runId,
        a.count,
        0,
        'summary',
        true,
      );
      if (!critical.runId)
        return { gameId: a.gameId, skipped: 'no_compatible_analysis', requiresAnalysis: true };
      if (!critical.items.length)
        return {
          gameId: a.gameId,
          runId: critical.runId,
          skipped: 'no_critical_positions',
          requiresAnalysis: false,
          classified: 0,
        };
      const positionIds = critical.items.map((p) => p.id);
      const job = await s.jobs.enqueue(
        c.userId,
        i.id,
        'classification',
        { positionIds, provider: selected.provider, model: selected.model },
        hash({
          positionIds,
          provider: selected.provider,
          model: selected.model,
          retry: a.retry ? randomUUID() : undefined,
        }),
        c.correlationId,
      );
      return {
        ...job,
        gameId: a.gameId,
        runId: critical.runId,
        selected: positionIds.length,
        nextOffset: critical.nextOffset ?? null,
      };
    },
    false,
  );
  for (const name of ['get_position_classifications', 'compare_reasoner_outputs'])
    add(
      name,
      'Stored fallible classifications from different reasoners; does not call providers.',
      { ...identity, positionId: uuid },
      (a, c) => s.semantics.list(c.userId, a.identityId, a.positionId),
    );
  add(
    'get_coaching_context',
    'Compact computed facts and separately labeled coach-authored state.',
    identity,
    (a, c) => s.coaching.context(c.userId, a.identityId),
  );
  add(
    'add_coaching_note',
    'Append a user-scoped coaching note and optional review trigger.',
    {
      ...identity,
      note: z.string().min(1).max(2000),
      category: z.string().max(80).optional(),
      relatedPattern: z.enum(labels).optional(),
      reviewAfterGames: z.number().int().min(1).max(1000).optional(),
      reviewAfterDate: date.optional(),
    },
    (a, c) => s.coaching.addNote(c.userId, a.identityId, a),
    false,
  );
  add(
    'get_coaching_notes',
    'Your coaching notes, paginated.',
    { ...identity, ...page, includeArchived: z.boolean().default(false) },
    (a, c) => s.coaching.notes(c.userId, a.identityId, a.limit, a.offset, a.includeArchived),
  );
  add(
    'archive_coaching_note',
    'Archive one of your notes without deleting history.',
    { noteId: uuid },
    (a, c) => s.coaching.archiveNote(c.userId, a.noteId),
    false,
  );
  add(
    'set_training_focus',
    'Start focus with a saved baseline of compatible metrics.',
    {
      ...identity,
      focus: z.string().min(1).max(200),
      reason: z.string().min(1).max(1000),
      targetPattern: z.enum(labels).optional(),
      durationGames: z.number().int().min(1).max(1000).optional(),
      reviewDate: date.optional(),
    },
    (a, c) => s.coaching.setFocus(c.userId, a.identityId, a),
    false,
  );
  add(
    'get_training_focuses',
    'Active and historical training focuses with baseline/end metrics.',
    { ...identity, ...page },
    (a, c) => s.coaching.focuses(c.userId, a.identityId, a.limit, a.offset),
  );
  add(
    'complete_training_focus',
    'Complete or abandon focus and persist end metrics and observed changes.',
    { focusId: uuid, state: z.enum(['completed', 'abandoned']).default('completed') },
    (a, c) => s.coaching.completeFocus(c.userId, a.focusId, a.state),
    false,
  );
  add(
    'set_goal',
    'Append a coaching goal.',
    {
      ...identity,
      goal: z.string().min(1).max(1000),
      targetRating: z.number().int().min(100).max(4000).optional(),
      targetDate: date.optional(),
    },
    (a, c) => s.coaching.goal(c.userId, a.identityId, a),
    false,
  );
  add('get_goals', 'Your saved coaching goals.', { ...identity, ...page }, (a, c) =>
    s.coaching.goals(c.userId, a.identityId, a.limit, a.offset),
  );
  add(
    'get_training_positions',
    'Create exercises from your games WITHOUT solutions. Retrieve solutions separately.',
    training,
    (a, c) => s.training.generate(c.userId, a.identityId, a),
    false,
  );
  add(
    'get_training_position_solution',
    'Reveal the separately authorized solution to your exercise.',
    { exerciseId: uuid },
    (a, c) => s.training.solution(c.userId, a.exerciseId),
  );
  add(
    'create_training_set',
    'Persist a set of exercises from your own games. No solutions in response.',
    { ...training, sourcePeriod: period.optional(), targetPattern: z.enum(labels).optional() },
    (a, c) => s.training.createSet(c.userId, a.identityId, a),
    false,
  );
  add(
    'get_training_set',
    'Retrieve your saved set without solutions.',
    { trainingSetId: uuid },
    (a, c) => s.training.set(c.userId, a.trainingSetId),
  );
  add(
    'record_training_result',
    'Append self-reported attempt. Reuse idempotencyKey only when retrying the same attempt.',
    {
      exerciseId: uuid,
      idempotencyKey: uuid,
      result: z.enum(['solved', 'failed', 'partial']),
      timeSpent: z.number().min(0).max(86400).optional(),
      attemptedMove: move.optional(),
      notes: z.string().max(1000).optional(),
    },
    (a, c) => s.training.record(c.userId, a),
    false,
  );
  add(
    'get_training_progress',
    'Attempt counts and paginated recent attempts.',
    { ...identity, ...page },
    (a, c) => s.training.progress(c.userId, a.identityId, a.limit, a.offset),
  );
  return tools;
}
export function createMcpServer(services: Services, context: RequestContext) {
  const server = new McpServer(
    { name: 'chess-coach-mcp', version: '0.1.0' },
    {
      instructions:
        'Associate a public Chess.com username, sync games, then analyze. Use analyze_games for a date range, or analyze_and_classify_games to run both stages in one job. Poll job IDs. If classify_game_positions requiresAnalysis, analyze first. Reports are compact and include partial-data warnings. Semantic labels are hypotheses. Never reveal an exercise solution until requested.',
    },
  );
  for (const t of toolDefinitions(services))
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.schema,
        annotations: {
          readOnlyHint: t.readOnly,
          destructiveHint: t.destructive,
          idempotentHint: t.readOnly,
          openWorldHint: [
            'associate_chesscom_username',
            'sync_games',
            'get_player_profile',
            'classify_critical_position',
            'classify_game_positions',
            'analyze_and_classify_games',
          ].includes(t.name),
        },
        _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['chess:coach'] }] },
      },
      async (args) => {
        const start = Date.now();
        try {
          const result = await t.execute(args, context);
          const text = JSON.stringify(result);
          if (Buffer.byteLength(text) > 250000)
            throw new DomainError(
              'response_limit',
              'Response too large; narrow filters or disable verbose fields',
            );
          metric('mcp_response_bytes', Buffer.byteLength(text));
          return { content: [{ type: 'text', text }] };
        } catch (e) {
          log.warn(
            {
              tool: t.name,
              correlationId: context.correlationId,
              code: e instanceof DomainError ? e.code : 'internal',
            },
            'Tool failed',
          );
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: e instanceof DomainError ? e.code : 'operation_failed',
                  message: e instanceof z.ZodError ? 'Invalid input' : safeError(e),
                }),
              },
            ],
          };
        } finally {
          metric('mcp_latency_ms', Date.now() - start);
        }
      },
    );
  return server;
}
