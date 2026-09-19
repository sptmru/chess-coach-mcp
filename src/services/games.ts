import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../database/client.js';
import { games, moves, playerGames, archives } from '../database/schema.js';
import { type UpstreamGame, upstreamGame, ChessComClient } from '../chesscom/client.js';
import { gameFingerprint, parsePgn, recognizeOpening } from '../chess/normalize.js';
import { DomainError, hash, metric, missing } from '../utils/core.js';
import type { IdentityService } from './identity.js';
export type GameFilters = {
  since?: string;
  until?: string;
  timeControl?: string;
  limit?: number;
  cursor?: string;
};
export class GameService {
  constructor(
    readonly db: DB,
    readonly identity: IdentityService,
    readonly upstream: ChessComClient,
  ) {}
  async ingest(playerId: string, username: string, input: UpstreamGame) {
    if (input.rules !== 'chess') return null;
    const parsed = parsePgn(input.pgn, input.time_control),
      opening = recognizeOpening(parsed.headers, parsed.moves);
    const name = username.toLowerCase();
    const color =
      input.white.username.toLowerCase() === name
        ? 'w'
        : input.black.username.toLowerCase() === name
          ? 'b'
          : null;
    if (!color)
      throw new DomainError(
        'player_mismatch',
        'Archive game does not contain the associated player',
      );
    const fingerprint = gameFingerprint(input, parsed.headers, parsed.moves);
    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(games)
        .values({
          fingerprint,
          upstreamId: input.uuid,
          url: input.url,
          white: input.white.username.toLowerCase(),
          black: input.black.username.toLowerCase(),
          whiteRating: input.white.rating,
          blackRating: input.black.rating,
          result: parsed.headers.Result ?? '*',
          endedAt: new Date(input.end_time * 1000),
          timeControl: input.time_control,
          timeClass: input.time_class,
          rated: input.rated,
          termination: parsed.headers.Termination,
          ...opening,
          pgn: input.pgn,
          contentHash: hash(input.pgn),
        })
        .onConflictDoNothing()
        .returning();
      const game =
        created ?? (await tx.select().from(games).where(eq(games.fingerprint, fingerprint)))[0];
      if (created)
        await tx.insert(moves).values(parsed.moves.map((m) => ({ ...m, gameId: game.id })));
      await tx
        .insert(playerGames)
        .values({ playerId, gameId: game.id, color })
        .onConflictDoNothing();
      metric(created ? 'games_imported' : 'games_deduplicated');
      return { gameId: game.id, imported: !!created };
    });
  }
  async sync(
    userId: string,
    identityId: string,
    months: number,
    progress: (done: number, total: number, failed: number) => Promise<void>,
    cancelled: () => Promise<void>,
    period?: { since: string; until: string },
  ) {
    const identity = await this.identity.require(userId, identityId);
    const list = await this.upstream.request(`/pub/player/${identity.username}/games/archives`);
    const urls = z.object({ archives: z.array(z.string()) }).parse(list.data).archives;
    const cutoff = new Date();
    cutoff.setUTCDate(1);
    cutoff.setUTCMonth(cutoff.getUTCMonth() - months + 1);
    cutoff.setUTCHours(0, 0, 0, 0);
    const selected = urls
      .filter((u) => {
        const m =
          /^https:\/\/api\.chess\.com\/pub\/player\/[a-z0-9_-]+\/games\/(\d{4})\/(\d{2})$/i.exec(u);
        if (!m) return false;
        const start = new Date(`${m[1]}-${m[2]}-01T00:00:00Z`);
        const end = new Date(start);
        end.setUTCMonth(end.getUTCMonth() + 1);
        return period
          ? start <= new Date(period.until) && end > new Date(period.since)
          : start >= cutoff;
      })
      .slice(period ? 0 : -months);
    let imported = 0,
      deduplicated = 0,
      failed = 0,
      done = 0;
    const warnings: string[] = [];
    for (const url of selected) {
      await cancelled();
      const [cache] = await this.db
        .select()
        .from(archives)
        .where(and(eq(archives.playerId, identity.playerId), eq(archives.url, url)));
      try {
        const response = await this.upstream.request(new URL(url).pathname.toLowerCase(), cache);
        let archiveErrors = 0;
        if (!response.notModified) {
          const payload = z.object({ games: z.array(z.unknown()).max(10000) }).parse(response.data);
          for (const raw of payload.games) {
            await cancelled();
            try {
              const game = upstreamGame.parse(raw);
              if (game.time_class !== 'rapid' || game.rules !== 'chess') continue;
              const result = await this.ingest(identity.playerId, identity.username, game);
              if (result?.imported) imported++;
              else deduplicated++;
            } catch (e) {
              if (e instanceof DomainError && ['cancelled', 'interrupted'].includes(e.code))
                throw e;
              archiveErrors++;
            }
          }
          // Never advance conditional cache after partial parsing failure; retry on next sync.
          if (archiveErrors === 0)
            await this.db
              .insert(archives)
              .values({
                playerId: identity.playerId,
                url,
                etag: response.etag,
                lastModified: response.lastModified,
              })
              .onConflictDoUpdate({
                target: [archives.playerId, archives.url],
                set: {
                  etag: response.etag,
                  lastModified: response.lastModified,
                  checkedAt: new Date(),
                },
              });
          else {
            failed += archiveErrors;
            warnings.push(
              `${url.split('/').slice(-2).join('/')}: ${archiveErrors} games could not be imported`,
            );
          }
        }
      } catch (e) {
        if (e instanceof DomainError && ['cancelled', 'interrupted'].includes(e.code)) throw e;
        failed++;
        warnings.push(`${url.split('/').slice(-2).join('/')}: archive unavailable`);
      }
      done++;
      await progress(done, selected.length, failed);
    }
    return { imported, deduplicated, failed, warnings };
  }
  async list(userId: string, identityId: string | undefined, filters: GameFilters = {}) {
    const i = await this.identity.require(userId, identityId);
    const where = [eq(playerGames.playerId, i.playerId)];
    if (filters.since) where.push(gte(games.endedAt, new Date(filters.since)));
    if (filters.until) where.push(lte(games.endedAt, new Date(filters.until)));
    if (filters.timeControl) where.push(eq(games.timeClass, filters.timeControl));
    if (filters.cursor) {
      const cursor = z
        .object({ date: z.string().datetime(), id: z.string().uuid() })
        .parse(JSON.parse(Buffer.from(filters.cursor, 'base64url').toString()));
      where.push(
        sql`(${games.endedAt}, ${games.id}) < (${new Date(cursor.date)}, ${cursor.id}::uuid)`,
      );
    }
    const limit = Math.min(filters.limit ?? 20, 100);
    const rows = await this.db
      .select({
        id: games.id,
        date: games.endedAt,
        white: games.white,
        black: games.black,
        whiteRating: games.whiteRating,
        blackRating: games.blackRating,
        result: games.result,
        timeControl: games.timeControl,
        timeClass: games.timeClass,
        opening: games.opening,
        eco: games.eco,
        color: playerGames.color,
      })
      .from(games)
      .innerJoin(playerGames, eq(games.id, playerGames.gameId))
      .where(and(...where))
      .orderBy(desc(games.endedAt), desc(games.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit),
      last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ date: last.date.toISOString(), id: last.id })).toString(
              'base64url',
            )
          : null,
    };
  }
  async require(userId: string, identityId: string | undefined, gameId: string) {
    const i = await this.identity.require(userId, identityId);
    const [row] = await this.db
      .select({ game: games, color: playerGames.color })
      .from(games)
      .innerJoin(
        playerGames,
        and(eq(playerGames.gameId, games.id), eq(playerGames.playerId, i.playerId)),
      )
      .where(eq(games.id, gameId));
    if (!row) throw missing();
    return { ...row, identity: i };
  }
  async selectBatch(
    userId: string,
    identityId: string,
    filters: Pick<GameFilters, 'since' | 'until' | 'timeControl'>,
    maxGames: number,
  ) {
    if (filters.since && filters.until && new Date(filters.since) > new Date(filters.until))
      throw new DomainError('invalid_period', 'since must be before until');
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.list(userId, identityId, {
        ...filters,
        cursor,
        limit: Math.min(100, maxGames - ids.length + 1),
      });
      ids.push(...page.items.map((g) => g.id));
      if (ids.length > maxGames || (ids.length === maxGames && page.nextCursor))
        throw new DomainError(
          'limits',
          `More than ${maxGames} games match; narrow since/until or increase maxGames within the server limit`,
        );
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return ids;
  }
  async get(
    userId: string,
    identityId: string | undefined,
    gameId: string,
    includePgn = false,
    includeMoves = false,
  ) {
    const { game, color } = await this.require(userId, identityId, gameId);
    const { pgn, ...rest } = game;
    return {
      ...rest,
      color,
      ...(includePgn ? { pgn } : {}),
      ...(includeMoves
        ? {
            moves: await this.db
              .select()
              .from(moves)
              .where(eq(moves.gameId, gameId))
              .orderBy(moves.ply),
          }
        : {}),
    };
  }
}
