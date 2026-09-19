import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  real,
  uniqueIndex,
  index,
  primaryKey,
  check,
  foreignKey,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { AnalyzedMove, EngineConfig, MoveFact, CriticalGroup } from '../domain/types.js';
const id = () => uuid('id').primaryKey().defaultRandom();
const created = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const utc = (name: string) => timestamp(name, { withTimezone: true });
export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: created(),
});
export const players = pgTable('chess_players', {
  id: id(),
  upstreamId: text('upstream_id').notNull().unique(),
  username: text('username').notNull().unique(),
  profile: jsonb('profile').$type<Record<string, unknown>>().notNull(),
  updatedAt: created(),
});
export const identities = pgTable(
  'user_chess_players',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    playerId: uuid('chess_player_id')
      .notNull()
      .references(() => players.id),
    provider: text('provider').notNull().default('chesscom'),
    isPrimary: boolean('is_primary').notNull().default(false),
    verified: boolean('verified').notNull().default(false),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex('identity_owner_pair').on(t.id, t.userId),
    uniqueIndex('identity_user_player').on(t.userId, t.playerId),
    uniqueIndex('identity_one_primary')
      .on(t.userId)
      .where(sql`${t.isPrimary}`),
    check('identity_unverified', sql`${t.verified} = false`),
  ],
);
export const games = pgTable(
  'games',
  {
    id: id(),
    fingerprint: text('fingerprint').notNull().unique(),
    upstreamId: text('upstream_id'),
    url: text('url'),
    white: text('white').notNull(),
    black: text('black').notNull(),
    whiteRating: integer('white_rating'),
    blackRating: integer('black_rating'),
    result: text('result').notNull(),
    endedAt: utc('ended_at').notNull(),
    timeControl: text('time_control').notNull(),
    timeClass: text('time_class').notNull(),
    rated: boolean('rated').notNull(),
    termination: text('termination'),
    eco: text('eco'),
    opening: text('opening'),
    variation: text('variation'),
    theoryExitPly: integer('theory_exit_ply'),
    openingSource: text('opening_source'),
    pgn: text('pgn').notNull(),
    contentHash: text('content_hash').notNull(),
    createdAt: created(),
  },
  (t) => [index('games_date').on(t.endedAt, t.id)],
);
export const playerGames = pgTable(
  'player_games',
  {
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    color: text('color').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.playerId, t.gameId] }),
    check('player_game_color', sql`${t.color} in ('w','b')`),
  ],
);
export const moves = pgTable(
  'moves',
  {
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    ply: integer('ply').notNull(),
    color: text('color').notNull(),
    san: text('san').notNull(),
    uci: text('uci').notNull(),
    fenBefore: text('fen_before').notNull(),
    fenAfter: text('fen_after').notNull(),
    clockBefore: real('clock_before'),
    clockAfter: real('clock_after'),
    thinkTime: real('think_time'),
    phase: text('phase').notNull(),
    moveNumber: integer('move_number').notNull(),
  },
  (t) => [primaryKey({ columns: [t.gameId, t.ply] })],
);
export const archives = pgTable(
  'sync_archives',
  {
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    etag: text('etag'),
    lastModified: text('last_modified'),
    checkedAt: created(),
  },
  (t) => [primaryKey({ columns: [t.playerId, t.url] })],
);
export const analysisRuns = pgTable(
  'analysis_runs',
  {
    id: id(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull().unique(),
    engineVersion: text('engine_version').notNull(),
    algorithmVersion: text('algorithm_version').notNull(),
    config: jsonb('config')
      .$type<
        EngineConfig & { threads: number; hashMb: number; platform: string; binaryHash: string }
      >()
      .notNull(),
    status: text('status').notNull(),
    createdAt: created(),
    completedAt: utc('completed_at'),
  },
  (t) => [index('analysis_game_status').on(t.gameId, t.status)],
);
export const moveAnalyses = pgTable(
  'move_analyses',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => analysisRuns.id, { onDelete: 'cascade' }),
    ply: integer('ply').notNull(),
    color: text('color').notNull(),
    cpl: real('cpl'),
    phase: text('phase').notNull(),
    severity: real('severity').notNull(),
    facts: jsonb('facts').$type<AnalyzedMove>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.ply] })],
);
export const criticalPositions = pgTable(
  'critical_positions',
  {
    id: id(),
    runId: uuid('run_id')
      .notNull()
      .references(() => analysisRuns.id, { onDelete: 'cascade' }),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    color: text('color').notNull(),
    ply: integer('ply').notNull(),
    severity: real('severity').notNull(),
    group: jsonb('group').$type<CriticalGroup>().notNull(),
  },
  (t) => [uniqueIndex('critical_run_ply').on(t.runId, t.ply)],
);
// Interpretations are scoped to an association; deleting it cascades personal state, never public games.
const owner = () => ({
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  identityId: uuid('identity_id')
    .notNull()
    .references(() => identities.id, { onDelete: 'cascade' }),
});
const ownerConstraints = (t: { userId: AnyPgColumn; identityId: AnyPgColumn }) => [
  foreignKey({
    columns: [t.identityId, t.userId],
    foreignColumns: [identities.id, identities.userId],
  }).onDelete('cascade'),
  index().on(t.userId, t.identityId),
];
export const classifications = pgTable(
  'semantic_classifications',
  {
    id: id(),
    ...owner(),
    positionId: uuid('position_id')
      .notNull()
      .references(() => criticalPositions.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    taxonomyVersion: text('taxonomy_version').notNull(),
    schemaVersion: text('schema_version').notNull(),
    primary: text('primary_label'),
    secondary: jsonb('secondary_labels').$type<string[]>(),
    confidence: real('confidence'),
    normalized: jsonb('normalized').$type<Record<string, unknown>>(),
    raw: jsonb('raw'),
    latencyMs: integer('latency_ms'),
    usage: jsonb('usage'),
    cost: real('cost'),
    status: text('status').notNull(),
    error: text('error'),
    createdAt: created(),
  },
  (t) => [
    ...ownerConstraints(t),
    uniqueIndex('classification_cache').on(t.userId, t.identityId, t.fingerprint),
    index('classification_owner').on(t.userId, t.identityId, t.primary),
  ],
);
export const profiles = pgTable(
  'coaching_profiles',
  {
    id: id(),
    ...owner(),
    repertoire: jsonb('repertoire').$type<Record<string, string[]>>().notNull().default({}),
    createdAt: created(),
  },
  (t) => [...ownerConstraints(t), uniqueIndex('profile_owner').on(t.userId, t.identityId)],
);
export const notes = pgTable(
  'coaching_notes',
  {
    id: id(),
    ...owner(),
    note: text('note').notNull(),
    category: text('category'),
    relatedPattern: text('related_pattern'),
    reviewAfterGames: integer('review_after_games'),
    baselineGames: integer('baseline_games').notNull(),
    reviewAfterDate: utc('review_after_date'),
    source: text('source').notNull().default('mcp_client'),
    archivedAt: utc('archived_at'),
    createdAt: created(),
  },
  ownerConstraints,
);
export const focuses = pgTable(
  'training_focuses',
  {
    id: id(),
    ...owner(),
    focus: text('focus').notNull(),
    reason: text('reason').notNull(),
    targetPattern: text('target_pattern'),
    durationGames: integer('duration_games'),
    reviewDate: utc('review_date'),
    state: text('state').notNull().default('started'),
    baseline: jsonb('baseline').notNull(),
    endMetrics: jsonb('end_metrics'),
    changes: jsonb('changes'),
    createdAt: created(),
    completedAt: utc('completed_at'),
  },
  ownerConstraints,
);
export const goals = pgTable(
  'goals',
  {
    id: id(),
    ...owner(),
    goal: text('goal').notNull(),
    targetRating: integer('target_rating'),
    targetDate: utc('target_date'),
    state: text('state').notNull().default('active'),
    createdAt: created(),
  },
  ownerConstraints,
);
export const exercises = pgTable(
  'training_exercises',
  {
    id: id(),
    ...owner(),
    positionId: uuid('position_id')
      .notNull()
      .references(() => criticalPositions.id),
    version: text('version').notNull(),
    fen: text('fen').notNull(),
    sideToMove: text('side_to_move').notNull(),
    difficulty: text('difficulty').notNull(),
    solution: jsonb('solution').$type<Record<string, unknown>>().notNull(),
    createdAt: created(),
  },
  (t) => [
    ...ownerConstraints(t),
    uniqueIndex('exercise_owner_version').on(t.userId, t.identityId, t.positionId, t.version),
  ],
);
export const trainingSets = pgTable(
  'training_sets',
  {
    id: id(),
    ...owner(),
    theme: text('theme'),
    criteria: jsonb('criteria').notNull(),
    createdAt: created(),
  },
  ownerConstraints,
);
export const setExercises = pgTable(
  'training_set_exercises',
  {
    setId: uuid('set_id')
      .notNull()
      .references(() => trainingSets.id, { onDelete: 'cascade' }),
    exerciseId: uuid('exercise_id')
      .notNull()
      .references(() => exercises.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.setId, t.exerciseId] }),
    uniqueIndex('set_ordinal').on(t.setId, t.ordinal),
  ],
);
export const attempts = pgTable(
  'training_attempts',
  {
    id: id(),
    ...owner(),
    exerciseId: uuid('exercise_id')
      .notNull()
      .references(() => exercises.id, { onDelete: 'cascade' }),
    exerciseVersion: text('exercise_version').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    result: text('result').notNull(),
    timeSpent: real('time_spent'),
    attemptedMove: text('attempted_move'),
    notes: text('notes'),
    createdAt: created(),
  },
  (t) => [
    ...ownerConstraints(t),
    uniqueIndex('attempt_idempotency').on(t.userId, t.idempotencyKey),
    check('attempt_result', sql`${t.result} in ('solved','failed','partial')`),
  ],
);
export const patterns = pgTable(
  'mistake_patterns',
  {
    id: id(),
    ...owner(),
    type: text('type').notNull(),
    analysisKey: text('analysis_key').notNull(),
    evidence: jsonb('evidence').notNull(),
    computedAt: created(),
  },
  (t) => [
    ...ownerConstraints(t),
    uniqueIndex('pattern_owner_type').on(t.userId, t.identityId, t.type, t.analysisKey),
  ],
);
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    ...owner(),
    type: text('type').notNull(),
    state: text('state').notNull().default('queued'),
    idempotencyKey: text('idempotency_key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    result: jsonb('result'),
    total: integer('total').notNull().default(0),
    completed: integer('completed').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    retries: integer('retries').notNull().default(0),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    error: text('error'),
    correlationId: text('correlation_id').notNull(),
    createdAt: created(),
    startedAt: utc('started_at'),
    finishedAt: utc('finished_at'),
  },
  (t) => [
    ...ownerConstraints(t),
    uniqueIndex('job_idempotency').on(t.userId, t.idempotencyKey),
    index('job_state_created').on(t.state, t.createdAt),
  ],
);
export const oauthClients = pgTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  metadata: jsonb('metadata').notNull(),
  createdAt: created(),
});
export const oauthRequests = pgTable('oauth_requests', {
  id: text('id').primaryKey(),
  csrfHash: text('csrf_hash').notNull(),
  params: jsonb('params').$type<Record<string, unknown>>().notNull(),
  expiresAt: utc('expires_at').notNull(),
});
export const oauthCodes = pgTable('oauth_codes', {
  hash: text('hash').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull(),
  challenge: text('challenge').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  resource: text('resource').notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull(),
  expiresAt: utc('expires_at').notNull(),
});
export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    hash: text('hash').primaryKey(),
    family: uuid('family').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    resource: text('resource').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    kind: text('kind').notNull(),
    used: boolean('used').notNull().default(false),
    expiresAt: utc('expires_at').notNull(),
    createdAt: created(),
  },
  (t) => [index('token_family').on(t.family)],
);
export type StoredMove = MoveFact;
