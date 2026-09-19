import { z } from 'zod';
import { DomainError, Gate, metric, sleep } from '../utils/core.js';
export const upstreamGame = z.object({
  uuid: z.string().optional(),
  url: z.string().url().optional(),
  pgn: z.string(),
  end_time: z.number().int(),
  time_control: z.string(),
  time_class: z.string(),
  rated: z.boolean().default(false),
  rules: z.string().default('chess'),
  white: z.object({
    username: z.string(),
    rating: z.number().int().optional(),
    result: z.string(),
  }),
  black: z.object({
    username: z.string(),
    rating: z.number().int().optional(),
    result: z.string(),
  }),
});
export type UpstreamGame = z.infer<typeof upstreamGame>;
export class ChessComClient {
  private gate = new Gate(1, 32);
  constructor(
    private userAgent: string,
    private fetcher: typeof fetch = fetch,
  ) {}
  async request(
    path: string,
    conditional?: { etag?: string | null; lastModified?: string | null },
  ) {
    // Only paths on this fixed host; never follow upstream-provided arbitrary URLs.
    if (
      !/^\/pub\/player\/[a-z0-9_-]+(?:\/stats|\/games\/archives|\/games\/\d{4}\/\d{2})?$/.test(path)
    )
      throw new DomainError('invalid_upstream', 'Invalid Chess.com resource');
    return this.gate.run(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const start = Date.now();
        try {
          const response = await this.fetcher('https://api.chess.com' + path, {
            headers: {
              'User-Agent': this.userAgent,
              ...(conditional?.etag ? { 'If-None-Match': conditional.etag } : {}),
              ...(conditional?.lastModified
                ? { 'If-Modified-Since': conditional.lastModified }
                : {}),
            },
            signal: AbortSignal.timeout(15000),
            redirect: 'error',
          });
          metric('chesscom_latency_ms', Date.now() - start);
          if (response.status === 304)
            return {
              notModified: true as const,
              data: null,
              etag: conditional?.etag ?? null,
              lastModified: conditional?.lastModified ?? null,
            };
          if (response.status === 404)
            throw new DomainError('player_not_found', 'Chess.com player or archive not found');
          if (response.status === 429 || response.status >= 500) {
            const retry = response.headers.get('retry-after');
            const wait = retry ? Number(retry) * 1000 : 500 * 2 ** attempt;
            if (attempt < 2) {
              await response.body?.cancel();
              await sleep(
                Math.min(10000, Number.isFinite(wait) ? wait : 1000) + Math.random() * 200,
              );
              continue;
            }
          }
          if (!response.ok)
            throw new DomainError('chesscom_failure', `Chess.com returned HTTP ${response.status}`);
          const reader = response.body?.getReader();
          if (!reader) throw new Error('empty response');
          const chunks: Uint8Array[] = [];
          let length = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.length;
            if (length > 20000000) {
              await reader.cancel();
              throw new DomainError('archive_too_large', 'Chess.com response exceeded size limit');
            }
            chunks.push(value);
          }
          return {
            notModified: false as const,
            data: JSON.parse(Buffer.concat(chunks).toString()) as unknown,
            etag: response.headers.get('etag'),
            lastModified: response.headers.get('last-modified'),
          };
        } catch (e) {
          metric('chesscom_errors');
          if (e instanceof DomainError || attempt === 2) throw e;
          await sleep(500 * 2 ** attempt + Math.random() * 200);
        }
      }
      throw new DomainError('chesscom_failure', 'Chess.com is unavailable');
    });
  }
  async profile(username: string) {
    const result = await this.request(`/pub/player/${username.toLowerCase()}`);
    return z
      .object({
        player_id: z.number().int(),
        username: z.string(),
        name: z.string().optional(),
        url: z.string().optional(),
      })
      .passthrough()
      .parse(result.data);
  }
  async stats(username: string) {
    return (await this.request(`/pub/player/${username.toLowerCase()}/stats`)).data;
  }
}
