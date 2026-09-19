import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { readConfig } from './config.js';
import { database } from './database/client.js';
import { passwordHash } from './auth/provider.js';
import { users, profiles } from './database/schema.js';
import { createServices } from './services/container.js';
const command = process.argv[2];
if (command === 'create-user') {
  const email = z.string().email().parse(process.argv[3]).toLowerCase();
  // Password from stdin, not a command argument, process listing or shell history.
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (input.length > 1024) throw new Error('Password too long');
  }
  const password = z.string().min(12).max(256).parse(input.trimEnd());
  const { db, pool } = database(readConfig().DATABASE_URL);
  try {
    const [user] = await db
      .insert(users)
      .values({ email, passwordHash: await passwordHash(password) })
      .returning({ id: users.id, email: users.email });
    process.stdout.write(JSON.stringify(user) + '\n');
  } finally {
    await pool.end();
  }
} else if (command === 'delete-user') {
  const email = z.string().email().parse(process.argv[3]).toLowerCase();
  if (process.argv[4] !== '--confirm')
    throw new Error('Pass --confirm to permanently delete this user and personal state');
  const { db, pool } = database(readConfig().DATABASE_URL);
  try {
    const result = await db.delete(users).where(eq(users.email, email)).returning({ id: users.id });
    process.stdout.write(JSON.stringify({ deleted: result.length }) + '\n');
  } finally {
    await pool.end();
  }
} else if (command === 'seed') {
  const userId = z
    .string()
    .uuid()
    .parse(process.argv[3] ?? process.env.STDIO_USER_ID);
  const s = createServices(readConfig());
  try {
    await s.identity.me(userId);
    const i = await s.identity.associate(userId, 'sptm1');
    await s.db
      .insert(profiles)
      .values({
        userId,
        identityId: i.id,
        repertoire: {
          white: ['Scotch Game'],
          blackVsE4: ['Sicilian Dragon'],
          blackVsD4: ['Grünfeld Defense'],
        },
      })
      .onConflictDoNothing();
    await s.coaching.goal(userId, i.id, { goal: 'Reach 1200 Chess.com Rapid', targetRating: 1200 });
    process.stdout.write(JSON.stringify({ identityId: i.id, verified: false }) + '\n');
  } finally {
    await s.close();
  }
} else {
  process.stderr.write(
    'Usage: create-user EMAIL < password | delete-user EMAIL --confirm | seed USER_UUID\n',
  );
  process.exitCode = 1;
}
