import { and, eq, sql } from 'drizzle-orm';
import type { DB } from '../database/client.js';
import { identities, players, users } from '../database/schema.js';
import type { ChessComClient } from '../chesscom/client.js';
import { DomainError, missing } from '../utils/core.js';
export class IdentityService {
  constructor(
    readonly db: DB,
    readonly upstream: ChessComClient,
  ) {}
  async list(userId: string) {
    return this.db
      .select({
        id: identities.id,
        username: players.username,
        playerId: players.id,
        isPrimary: identities.isPrimary,
        verified: identities.verified,
        provider: identities.provider,
      })
      .from(identities)
      .innerJoin(players, eq(players.id, identities.playerId))
      .where(eq(identities.userId, userId));
  }
  async require(userId: string, identityId?: string) {
    const result = (await this.list(userId)).find((i) =>
      identityId ? i.id === identityId : i.isPrimary,
    );
    if (!result) throw missing();
    return result;
  }
  async associate(userId: string, username: string) {
    const profile = await this.upstream.profile(username);
    return this.db.transaction(async (tx) => {
      await tx.select().from(users).where(eq(users.id, userId)).for('update');
      const existing = await tx.select().from(identities).where(eq(identities.userId, userId));
      const [player] = await tx
        .insert(players)
        .values({
          upstreamId: String(profile.player_id),
          username: profile.username.toLowerCase(),
          profile,
        })
        .onConflictDoUpdate({
          target: players.upstreamId,
          set: { username: profile.username.toLowerCase(), profile, updatedAt: new Date() },
        })
        .returning();
      const already = existing.find((i) => i.playerId === player.id);
      if (already) return already;
      if (existing.length >= 3)
        throw new DomainError('limits', 'At most 3 Chess.com identities per user');
      const [identity] = await tx
        .insert(identities)
        .values({ userId, playerId: player.id, isPrimary: existing.length === 0, verified: false })
        .returning();
      return identity;
    });
  }
  async primary(userId: string, id: string) {
    await this.require(userId, id);
    await this.db.transaction(async (tx) => {
      await tx.select().from(users).where(eq(users.id, userId)).for('update');
      await tx.update(identities).set({ isPrimary: false }).where(eq(identities.userId, userId));
      await tx
        .update(identities)
        .set({ isPrimary: true })
        .where(and(eq(identities.userId, userId), eq(identities.id, id)));
    });
    return { id, isPrimary: true };
  }
  async remove(userId: string, id: string) {
    await this.require(userId, id);
    await this.db.transaction(async (tx) => {
      await tx.select().from(users).where(eq(users.id, userId)).for('update');
      await tx.delete(identities).where(and(eq(identities.userId, userId), eq(identities.id, id)));
      const remaining = await tx.select().from(identities).where(eq(identities.userId, userId));
      if (remaining.length && !remaining.some((i) => i.isPrimary))
        await tx
          .update(identities)
          .set({ isPrimary: true })
          .where(eq(identities.id, remaining[0].id));
    });
    return { removed: true };
  }
  async me(userId: string) {
    const [user] = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) throw missing();
    return { ...user, identities: await this.list(userId) };
  }
  async lockUser(userId: string) {
    await this.db.execute(sql`select id from users where id = ${userId}`);
  }
}
