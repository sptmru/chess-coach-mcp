import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { database } from './client.js';
import { readConfig } from '../config.js';
const { db, pool } = database(readConfig().DATABASE_URL);
try {
  await migrate(db, { migrationsFolder: './drizzle' });
} finally {
  await pool.end();
}
