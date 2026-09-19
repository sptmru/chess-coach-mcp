import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readConfig } from '../src/config.js';
import { toolDefinitions } from '../src/mcp/tools.js';
import { createServices, type Services } from '../src/services/container.js';

const gameId = '5ef1d4a8-aec7-445d-995f-df6afc35222a';
const positionId = 'b8bf8626-aa6d-4ae0-959f-879611914d1a';
const ctx = { userId: 'fixture-user', correlationId: 'fixture-correlation' };
let services: Services;
function setup(provider = 'jev') {
  services = createServices(
    readConfig({
      DATABASE_URL: 'postgresql://unused:unused@localhost/chess_test',
      REASONER_PROVIDER: provider,
      JEV_API_KEY: 'synthetic-test-key',
    }),
  );
  return toolDefinitions(services);
}
afterEach(async () => {
  vi.restoreAllMocks();
  await services?.pool.end();
});

describe('classification provider selection', () => {
  it.each(['jev', 'disabled'])(
    'advertises the server default for %s in both MCP schemas',
    (provider) => {
      const tools = setup(provider);
      for (const name of [
        'classify_critical_position',
        'classify_game_positions',
        'analyze_and_classify_games',
      ]) {
        const schema = z.toJSONSchema(tools.find((t) => t.name === name)!.schema, { io: 'input' });
        expect(schema.properties?.provider).toMatchObject({
          enum: provider === 'jev' ? ['mock', 'jev'] : ['mock'],
          default: provider === 'jev' ? 'jev' : 'mock',
        });
        expect(schema.required ?? []).not.toContain('provider');
        expect(schema.required ?? []).not.toContain('model');
      }
    },
  );

  it('uses the configured provider when a single-position call omits provider and model', async () => {
    const tool = setup().find((t) => t.name === 'classify_critical_position')!;
    const classify = vi
      .spyOn(services.semantics, 'classify')
      .mockResolvedValue({ status: 'succeeded' });
    await tool.execute({ positionId }, ctx);
    expect(classify).toHaveBeenCalledWith(ctx.userId, undefined, positionId, 'jev', undefined);
    expect(services.semantics.resolveReasoner()).toMatchObject({
      provider: 'jev',
      model: 'jev-latest',
    });
  });

  it.each([
    { configured: 'jev', override: undefined, provider: 'jev', model: 'jev-latest' },
    { configured: 'disabled', override: undefined, provider: 'mock', model: 'deterministic-v1' },
    { configured: 'jev', override: 'mock', provider: 'mock', model: 'deterministic-v1' },
  ])(
    'pins the resolved pair in jobs: $configured / $override',
    async ({ configured, override, provider, model }) => {
      const tool = setup(configured).find((t) => t.name === 'classify_game_positions')!;
      vi.spyOn(services.identity, 'require').mockResolvedValue({
        id: 'fixture-identity',
      } as Awaited<ReturnType<Services['identity']['require']>>);
      vi.spyOn(services.analysis, 'critical').mockResolvedValue({
        runId: gameId,
        items: [{ id: positionId }],
      } as Awaited<ReturnType<Services['analysis']['critical']>>);
      const enqueue = vi
        .spyOn(services.jobs, 'enqueue')
        .mockResolvedValue({} as Awaited<ReturnType<Services['jobs']['enqueue']>>);
      await tool.execute({ gameId, ...(override ? { provider: override } : {}) }, ctx);
      expect(enqueue).toHaveBeenCalledWith(
        ctx.userId,
        'fixture-identity',
        'classification',
        { positionIds: [positionId], provider, model },
        expect.any(String),
        ctx.correlationId,
      );
      const implicitKey = enqueue.mock.calls[0][4];
      await tool.execute({ gameId, provider, model }, ctx);
      expect(enqueue.mock.calls[1][4]).toBe(implicitKey);
    },
  );

  it.each([
    {
      critical: { items: [], warning: 'Game has not been analyzed' },
      skipped: 'no_compatible_analysis',
      requiresAnalysis: true,
    },
    {
      critical: { items: [], runId: gameId, nextOffset: null },
      skipped: 'no_critical_positions',
      requiresAnalysis: false,
    },
  ])(
    'returns $skipped without queueing an empty job',
    async ({ critical, skipped, requiresAnalysis }) => {
      const tool = setup().find((t) => t.name === 'classify_game_positions')!;
      vi.spyOn(services.identity, 'require').mockResolvedValue({
        id: 'fixture-identity',
      } as Awaited<ReturnType<Services['identity']['require']>>);
      const positions = vi
        .spyOn(services.analysis, 'critical')
        .mockResolvedValue(critical as Awaited<ReturnType<Services['analysis']['critical']>>);
      const enqueue = vi.spyOn(services.jobs, 'enqueue');
      expect(await tool.execute({ gameId }, ctx)).toMatchObject({
        gameId,
        skipped,
        requiresAnalysis,
      });
      expect(positions).toHaveBeenCalledWith(
        ctx.userId,
        'fixture-identity',
        gameId,
        undefined,
        10,
        0,
        'summary',
        true,
      );
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it('rejects unavailable providers and wrong models before queueing or looking up positions', async () => {
    const tools = setup();
    const enqueue = vi.spyOn(services.jobs, 'enqueue');
    const critical = vi.spyOn(services.analysis, 'critical');
    const classify = vi.spyOn(services.semantics, 'classify');
    const batch = tools.find((t) => t.name === 'classify_game_positions')!;
    await expect(batch.execute({ gameId, provider: 'openai' }, ctx)).rejects.toThrow();
    await expect(batch.execute({ gameId, model: 'unconfigured-model' }, ctx)).rejects.toMatchObject(
      { code: 'provider_not_allowed' },
    );
    await expect(
      tools
        .find((t) => t.name === 'classify_critical_position')!
        .execute({ positionId, provider: 'openai' }, ctx),
    ).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
    expect(critical).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });
});
