import { config as loadEnv } from 'dotenv';
loadEnv({ quiet: true });
import { z } from 'zod';
const positive = (fallback: number, max: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback);
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: positive(8080, 65535),
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  DATABASE_URL: z.string().optional(),
  POSTGRES_USER: z.string().default('chess'),
  POSTGRES_PASSWORD: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16).optional()),
  POSTGRES_DB: z.string().default('chess'),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: positive(5432, 65535),
  STOCKFISH_PATH: z.string().default('/usr/games/stockfish'),
  ENGINE_POOL_SIZE: positive(1, 4),
  ENGINE_THREADS: positive(1, 8),
  ENGINE_HASH_MB: positive(64, 1024),
  ENGINE_TIMEOUT_MS: positive(20000, 120000),
  ANALYSIS_DEPTH: positive(12, 20),
  MAX_DEPTH: positive(16, 24),
  MAX_MULTIPV: positive(3, 5),
  JOB_CONCURRENCY: positive(1, 4),
  MAX_ANALYSIS_GAMES: positive(10, 50),
  CHESSCOM_USER_AGENT: z.string().default('ChessCoachMCP/0.1 (self-hosted personal analytics)'),
  REASONER_PROVIDER: z.enum(['disabled', 'mock', 'openai', 'gemini', 'jev']).default('disabled'),
  REASONER_MODEL: z.string().default(''),
  OPENAI_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  JEV_API_KEY: z.string().optional(),
  JEV_API_URL: z.string().url().default('https://api.typesafe.ai/v1/systemone'),
  OAUTH_REDIRECT_URIS: z.string().default('https://chatgpt.com/connector_platform_oauth_redirect'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  STDIO_USER_ID: z.string().uuid().optional(),
});
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const c = schema.parse(env);
  const url = new URL(c.PUBLIC_URL);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('PUBLIC_URL must be an origin');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('PUBLIC_URL must use HTTPS outside localhost');
  if (c.ANALYSIS_DEPTH > c.MAX_DEPTH) throw new Error('ANALYSIS_DEPTH exceeds MAX_DEPTH');
  if (!c.DATABASE_URL && !c.POSTGRES_PASSWORD)
    throw new Error('Set DATABASE_URL or POSTGRES_PASSWORD');
  if (c.REASONER_PROVIDER === 'jev' && !c.REASONER_MODEL) c.REASONER_MODEL = 'jev-latest';
  if (c.REASONER_PROVIDER !== 'disabled' && c.REASONER_PROVIDER !== 'mock' && !c.REASONER_MODEL)
    throw new Error('Set REASONER_MODEL');
  for (const provider of ['openai', 'gemini', 'jev'] as const) {
    if (
      c.REASONER_PROVIDER === provider &&
      !c[`${provider.toUpperCase()}_API_KEY` as 'OPENAI_API_KEY']
    )
      throw new Error('Reasoner API key is missing');
  }
  if (c.REASONER_PROVIDER === 'jev') {
    const endpoint = new URL(c.JEV_API_URL);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash)
      throw new Error('JEV_API_URL must be an HTTPS endpoint without credentials or fragment');
  }
  return {
    ...c,
    PUBLIC_URL: url.origin,
    DATABASE_URL:
      c.DATABASE_URL ??
      `postgresql://${encodeURIComponent(c.POSTGRES_USER)}:${encodeURIComponent(c.POSTGRES_PASSWORD!)}@${c.DB_HOST}:${c.DB_PORT}/${encodeURIComponent(c.POSTGRES_DB)}`,
  };
}
export type Config = ReturnType<typeof readConfig>;
