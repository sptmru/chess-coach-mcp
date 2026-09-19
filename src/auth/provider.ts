import { randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Response, Express } from 'express';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  InvalidGrantError,
  InvalidTokenError,
  InvalidClientMetadataError,
  InvalidTargetError,
  InvalidScopeError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  mcpAuthRouter,
  createOAuthMetadata,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { DB } from '../database/client.js';
import { users, oauthClients, oauthCodes, oauthRequests, oauthTokens } from '../database/schema.js';
import type { Config } from '../config.js';
import { hash, secret } from '../utils/core.js';
const scrypt = promisify(scryptCallback);
export async function passwordHash(password: string) {
  const salt = secret();
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [salt, value] = stored.split(':');
  if (!salt || !value) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(value, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export class AuthProvider implements OAuthServerProvider {
  readonly resource: string;
  readonly issuer: string;
  private dummyHashPromise = passwordHash(secret());
  constructor(
    readonly db: DB,
    readonly config: Config,
  ) {
    this.resource = config.PUBLIC_URL + '/mcp';
    this.issuer = config.PUBLIC_URL;
  }
  clientsStore = {
    getClient: async (clientId: string): Promise<OAuthClientInformationFull | undefined> => {
      const [client] = await this.db
        .select()
        .from(oauthClients)
        .where(eq(oauthClients.clientId, clientId));
      return client?.metadata as OAuthClientInformationFull | undefined;
    },
    registerClient: async (
      client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
    ): Promise<OAuthClientInformationFull> => {
      const allowed = this.config.OAUTH_REDIRECT_URIS.split(',').map((x) => x.trim());
      if (
        client.redirect_uris.length > 5 ||
        client.redirect_uris.some((uri) => !allowed.includes(uri))
      )
        throw new InvalidClientMetadataError('Redirect URI must match the operator allowlist');
      if (client.token_endpoint_auth_method && client.token_endpoint_auth_method !== 'none')
        throw new InvalidClientMetadataError('Only public PKCE clients are supported');
      const registered = {
        ...client,
        client_id: randomUUID(),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: 'none' as const,
        client_secret: undefined,
        client_secret_expires_at: undefined,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      };
      await this.db
        .insert(oauthClients)
        .values({ clientId: registered.client_id, metadata: registered });
      return registered;
    },
  };
  private checkResource(resource?: URL) {
    if (resource?.href !== this.resource)
      throw new InvalidTargetError('Resource must match the advertised MCP resource');
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.checkResource(params.resource);
    const scopes = params.scopes ?? ['chess:coach'];
    if (scopes.some((s) => s !== 'chess:coach')) throw new InvalidScopeError('Unsupported scope');
    const id = secret(),
      csrf = secret();
    await this.db.delete(oauthRequests).where(lt(oauthRequests.expiresAt, new Date()));
    await this.db.insert(oauthRequests).values({
      id,
      csrfHash: hash(csrf),
      params: {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        challenge: params.codeChallenge,
        resource: this.resource,
        state: params.state,
        scopes,
      },
      expiresAt: new Date(Date.now() + 600000),
    });
    res.cookie('chess_oauth', csrf, {
      httpOnly: true,
      secure: this.config.PUBLIC_URL.startsWith('https:'),
      sameSite: 'lax',
      maxAge: 600000,
      path: '/consent',
    });
    res.setHeader('Cache-Control', 'no-store');
    // no-referrer makes browser form POSTs send Origin: null and fail our origin check.
    // Keep the origin for /consent without sending the authorization URL to the client.
    res.setHeader('Referrer-Policy', 'same-origin');
    // Browsers also apply form-action to the redirect from /consent to the client.
    // authorize() only receives a redirect URI already validated by the OAuth router.
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; base-uri 'none'; form-action 'self' ${new URL(params.redirectUri).origin}; frame-ancestors 'none'`,
    );
    res
      .type('html')
      .send(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Chess Coach — authorize</title><body><main><h1>Connect Chess Coach</h1><p>Client: ${escapeHtml(client.client_name ?? client.client_id)}</p><p>This client will be able to read your chess analysis and manage your coaching notes and training. Chess.com usernames are public, unverified associations.</p><form method="post" action="/consent"><input type="hidden" name="requestId" value="${id}"><input type="hidden" name="csrf" value="${csrf}"><p><label>Email <input name="email" type="email" required autocomplete="username" maxlength="254"></label></p><p><label>Password <input name="password" type="password" required autocomplete="current-password" maxlength="256"></label></p><button name="decision" value="allow">Sign in and authorize</button> <button name="decision" value="deny" formnovalidate>Cancel</button></form><p>Accounts are created by the service operator.</p></main></body></html>`,
      );
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    const [c] = await this.db
      .select()
      .from(oauthCodes)
      .where(
        and(
          eq(oauthCodes.hash, hash(code)),
          eq(oauthCodes.clientId, client.client_id),
          gt(oauthCodes.expiresAt, new Date()),
        ),
      );
    if (!c) throw new InvalidGrantError('Invalid or expired code');
    return c.challenge;
  }
  private async issue(
    tx: Pick<DB, 'insert'>,
    userId: string,
    clientId: string,
    scopes: string[],
    family: string = randomUUID(),
  ) {
    const access = secret(),
      refresh = secret();
    await tx.insert(oauthTokens).values([
      {
        hash: hash(access),
        family,
        userId,
        clientId,
        resource: this.resource,
        scopes,
        kind: 'access',
        expiresAt: new Date(Date.now() + 3600000),
      },
      {
        hash: hash(refresh),
        family,
        userId,
        clientId,
        resource: this.resource,
        scopes,
        kind: 'refresh',
        expiresAt: new Date(Date.now() + 30 * 86400000),
      },
    ]);
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: 3600,
      token_type: 'Bearer',
      scope: scopes.join(' '),
    };
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ) {
    this.checkResource(resource);
    return this.db.transaction(async (tx) => {
      const [c] = await tx
        .delete(oauthCodes)
        .where(
          and(
            eq(oauthCodes.hash, hash(code)),
            eq(oauthCodes.clientId, client.client_id),
            eq(oauthCodes.redirectUri, redirectUri ?? ''),
            gt(oauthCodes.expiresAt, new Date()),
          ),
        )
        .returning();
      if (!c || c.resource !== this.resource)
        throw new InvalidGrantError('Invalid, consumed or expired code');
      return this.issue(tx, c.userId, client.client_id, c.scopes);
    });
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ) {
    this.checkResource(resource);
    const result = await this.db.transaction(async (tx) => {
      const [t] = await tx
        .select()
        .from(oauthTokens)
        .where(
          and(
            eq(oauthTokens.hash, hash(refreshToken)),
            eq(oauthTokens.clientId, client.client_id),
            eq(oauthTokens.kind, 'refresh'),
          ),
        )
        .for('update');
      if (!t) return null;
      if (t.used) {
        await tx.delete(oauthTokens).where(eq(oauthTokens.family, t.family));
        return null;
      }
      if (
        t.expiresAt < new Date() ||
        t.resource !== this.resource ||
        scopes?.some((s) => !t.scopes.includes(s))
      )
        return null;
      await tx.update(oauthTokens).set({ used: true }).where(eq(oauthTokens.hash, t.hash));
      return this.issue(tx, t.userId, t.clientId, scopes ?? t.scopes, t.family);
    });
    if (!result) throw new InvalidGrantError('Invalid, expired or reused refresh token');
    return result;
  }
  async verifyAccessToken(token: string) {
    const [t] = await this.db
      .select()
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.hash, hash(token)),
          eq(oauthTokens.kind, 'access'),
          gt(oauthTokens.expiresAt, new Date()),
        ),
      );
    if (!t || t.resource !== this.resource || !t.scopes.includes('chess:coach'))
      throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: t.clientId,
      scopes: t.scopes,
      expiresAt: Math.floor(t.expiresAt.getTime() / 1000),
      resource: new URL(t.resource),
      extra: { userId: t.userId },
    };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    const [t] = await this.db
      .select()
      .from(oauthTokens)
      .where(
        and(eq(oauthTokens.hash, hash(request.token)), eq(oauthTokens.clientId, client.client_id)),
      );
    if (t) await this.db.delete(oauthTokens).where(eq(oauthTokens.family, t.family));
  }
  install(app: Express) {
    // Add issuer identification to all SDK authorization redirects, including errors.
    app.use('/authorize', (_req, res, next) => {
      const redirect = res.redirect.bind(res);
      res.redirect = ((arg: number | string, url?: string) => {
        const target = new URL(typeof arg === 'string' ? arg : url!);
        target.searchParams.set('iss', this.issuer);
        return typeof arg === 'number' ? redirect(arg, target.href) : redirect(target.href);
      }) as Response['redirect'];
      next();
    });
    app.get('/.well-known/oauth-authorization-server', (_req, res) =>
      res.set('Access-Control-Allow-Origin', '*').json({
        ...createOAuthMetadata({
          provider: this,
          issuerUrl: new URL(this.issuer),
          scopesSupported: ['chess:coach'],
        }),
        issuer: this.issuer,
        authorization_response_iss_parameter_supported: true,
        token_endpoint_auth_methods_supported: ['none'],
        revocation_endpoint_auth_methods_supported: ['none'],
      }),
    );
    const metadata = {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: ['chess:coach'],
      resource_name: 'Chess Coach MCP',
    };
    app.get(
      ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'],
      (_req, res) => res.set('Access-Control-Allow-Origin', '*').json(metadata),
    );
    app.post(
      '/consent',
      rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: true, legacyHeaders: false }),
      express.urlencoded({ extended: false, limit: '8kb' }),
      async (req, res) => {
        const input = z
          .object({
            requestId: z.string().max(100),
            csrf: z.string().max(100),
            email: z.string().max(254).optional(),
            password: z.string().max(256).optional(),
            decision: z.enum(['allow', 'deny']),
          })
          .safeParse(req.body);
        if (!input.success) {
          res.status(400).send('Invalid authorization request');
          return;
        }
        const b = input.data;
        const cookie = req.headers.cookie
          ?.split(';')
          .map((s) => s.trim())
          .find((s) => s.startsWith('chess_oauth='))
          ?.slice(12);
        const [request] = await this.db
          .select()
          .from(oauthRequests)
          .where(and(eq(oauthRequests.id, b.requestId), gt(oauthRequests.expiresAt, new Date())));
        if (
          !request ||
          !cookie ||
          hash(cookie) !== request.csrfHash ||
          hash(b.csrf) !== request.csrfHash ||
          (req.headers.origin && req.headers.origin !== this.issuer)
        ) {
          res.status(400).send('Invalid or expired authorization request');
          return;
        }
        const p = request.params as {
          clientId: string;
          redirectUri: string;
          challenge: string;
          resource: string;
          state?: string;
          scopes: string[];
        };
        const redirect = new URL(p.redirectUri);
        redirect.searchParams.set('iss', this.issuer);
        if (p.state) redirect.searchParams.set('state', p.state);
        if (b.decision === 'deny') {
          await this.db.delete(oauthRequests).where(eq(oauthRequests.id, b.requestId));
          redirect.searchParams.set('error', 'access_denied');
          res.redirect(redirect.href);
          return;
        }
        const [user] = await this.db
          .select()
          .from(users)
          .where(eq(users.email, b.email?.toLowerCase() ?? ''));
        const valid = await verifyPassword(
          b.password ?? '',
          user?.passwordHash ?? (await this.dummyHashPromise),
        );
        if (!valid || !user) {
          res.status(401).send('Invalid credentials. Return to your client and try again.');
          return;
        }
        const code = secret();
        const consumed = await this.db.transaction(async (tx) => {
          const removed = await tx
            .delete(oauthRequests)
            .where(and(eq(oauthRequests.id, b.requestId), gt(oauthRequests.expiresAt, new Date())))
            .returning();
          if (!removed.length) return false;
          await tx.insert(oauthCodes).values({
            hash: hash(code),
            userId: user.id,
            clientId: p.clientId,
            challenge: p.challenge,
            redirectUri: p.redirectUri,
            resource: p.resource,
            scopes: p.scopes,
            expiresAt: new Date(Date.now() + 60000),
          });
          return true;
        });
        if (!consumed) {
          res.status(400).send('Authorization request already consumed');
          return;
        }
        res.clearCookie('chess_oauth', { path: '/consent' });
        redirect.searchParams.set('code', code);
        res.redirect(redirect.href);
      },
    );
    app.use(
      mcpAuthRouter({
        provider: this,
        issuerUrl: new URL(this.issuer),
        resourceServerUrl: new URL(this.resource),
        scopesSupported: ['chess:coach'],
        clientRegistrationOptions: { rateLimit: { windowMs: 3600000, max: 30 } },
      }),
    );
  }
}
