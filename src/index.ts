import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readConfig } from './config.js';
import { createServices } from './services/container.js';
import { createMcpServer } from './mcp/tools.js';
import { createApp } from './http.js';
import { log, metrics } from './utils/core.js';
import { randomUUID } from 'node:crypto';
const config = readConfig();
const services = createServices(config);
const stdio = process.argv.includes('--stdio');
if (stdio) {
  if (!config.STDIO_USER_ID) throw new Error('STDIO_USER_ID required for local trusted stdio mode');
  await services.identity.me(config.STDIO_USER_ID);
}
await services.start();
const metricsTimer = setInterval(
  () =>
    log.info(
      { metrics: Object.fromEntries(metrics), engineQueue: services.engine.queueDepth },
      'Service metrics',
    ),
  60000,
);
metricsTimer.unref();
let shutdown = false;
let closeTransport: () => Promise<void>;
if (stdio) {
  if (!config.STDIO_USER_ID) throw new Error('STDIO_USER_ID required for local trusted stdio mode');
  await services.identity.me(config.STDIO_USER_ID);
  const server = createMcpServer(services, {
    userId: config.STDIO_USER_ID,
    correlationId: randomUUID(),
  });
  await server.connect(new StdioServerTransport());
  closeTransport = () => server.close();
  process.stdin.once('end', () => void stop());
} else {
  const server = createApp(services).listen(config.PORT, '0.0.0.0', () =>
    log.info({ port: config.PORT }, 'Chess Coach MCP ready'),
  );
  server.requestTimeout = 90000;
  server.headersTimeout = 10000;
  closeTransport = () => new Promise<void>((resolve) => server.close(() => resolve()));
}
async function stop() {
  if (shutdown) return;
  shutdown = true;
  clearInterval(metricsTimer);
  log.info('Shutting down');
  const deadline = setTimeout(() => process.exit(1), 30000);
  deadline.unref();
  await closeTransport();
  await services.close();
  clearTimeout(deadline);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
