import { randomUUID } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AuthProvider } from './auth/provider.js';
import { createMcpServer } from './mcp/tools.js';
import type { Services } from './services/container.js';
import { Gate, log } from './utils/core.js';
export function createApp(s: Services) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"], formAction: ["'self'"], frameAncestors: ["'none'"] },
      },
    }),
  );
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (
      req.headers.origin &&
      req.headers.origin !== s.config.PUBLIC_URL &&
      !req.path.startsWith('/.well-known') &&
      !['/token', '/register', '/revoke'].includes(req.path)
    ) {
      res.status(403).json({ error: 'untrusted_origin' });
      return;
    }
    next();
  });
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', async (_req, res) => {
    try {
      await s.pool.query('select 1');
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  // Global ingress limiter is intentionally conservative. Never trust client-supplied forwarding headers.
  app.use(rateLimit({ windowMs: 60000, limit: 300, standardHeaders: true, legacyHeaders: false }));
  const auth = new AuthProvider(s.db, s.config);
  auth.install(app);
  const protectedRoute = requireBearerAuth({
    verifier: auth,
    requiredScopes: ['chess:coach'],
    resourceMetadataUrl: s.config.PUBLIC_URL + '/.well-known/oauth-protected-resource/mcp',
  });
  const gate = new Gate(8, 16);
  app.all(
    ['/mcp', '/'],
    protectedRoute,
    rateLimit({
      windowMs: 60000,
      limit: 60,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => String(req.auth?.extra?.userId ?? 'anonymous'),
    }),
    express.json({ limit: '64kb' }),
    async (req, res) => {
      const userId = req.auth?.extra?.userId;
      if (typeof userId !== 'string') {
        res.sendStatus(401);
        return;
      }
      if (req.method !== 'POST') {
        res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' });
        return;
      }
      try {
        await gate.run(async () => {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          const server = createMcpServer(s, { userId, correlationId: randomUUID() });
          try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
          } finally {
            await transport.close();
            await server.close();
          }
        });
      } catch {
        if (!res.headersSent) res.status(503).json({ error: 'temporarily_unavailable' });
      }
    },
  );
  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    log.warn({ kind: err?.type ?? 'internal' }, 'HTTP request failed');
    if (!res.headersSent)
      res.status(err?.status === 413 ? 413 : 400).json({ error: 'invalid_request' });
  };
  app.use(errorHandler);
  return app;
}
