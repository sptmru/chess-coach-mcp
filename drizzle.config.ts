import { defineConfig } from 'drizzle-kit';
import { readConfig } from './src/config.js';
export default defineConfig({
  schema: './src/database/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: readConfig().DATABASE_URL },
});
