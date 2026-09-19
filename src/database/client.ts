import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
export function database(url: string) {
  const pool = new pg.Pool({
    connectionString: url,
    max: 12,
    connectionTimeoutMillis: 5000,
    statement_timeout: 30000,
  });
  return { db: drizzle(pool, { schema }), pool };
}
export type DB = ReturnType<typeof database>['db'];
