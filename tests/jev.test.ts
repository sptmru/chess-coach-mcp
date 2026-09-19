import { afterEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { parsePgn } from '../src/chess/normalize.js';
import { features, labels, reasoner } from '../src/semantics/reasoner.js';
import type { AnalyzedMove } from '../src/domain/types.js';

const env = {
  DATABASE_URL: 'postgresql://unused:unused@localhost/chess_test',
  REASONER_PROVIDER: 'jev',
  JEV_API_KEY: 'synthetic-test-key',
};
const move: AnalyzedMove = {
  ...parsePgn('1. f3 e5 2. g4 Qh4# 0-1', '600').moves[2],
  before: { type: 'cp', value: 0 },
  after: { type: 'mate', value: -1, winning: false },
  cpl: null,
  bestMove: 'e2e4',
  alternatives: [],
  transitions: ['allowed_forced_mate'],
  severity: 1000,
};
const context = { move, features: features(move), surrounding: [], opening: null };
function response(choice = 'missed_tactical_defense', confidence = 0.72) {
  return {
    model: 'jev-latest',
    answers: {
      primary: {
        type: 'choice',
        choice,
        confidence,
        probabilities: Object.fromEntries(labels.map((label) => [label, label === choice ? 1 : 0])),
      },
    },
    usage: { input_tokens: 200, output_tokens: 60 },
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('native Jev configuration', () => {
  it('defaults blank model and omitted URL while still requiring a key', () => {
    expect(readConfig({ ...env, REASONER_MODEL: '' })).toMatchObject({
      REASONER_MODEL: 'jev-latest',
      JEV_API_URL: 'https://api.typesafe.ai/v1/systemone',
    });
    expect(() => readConfig({ ...env, JEV_API_KEY: '' })).toThrow('Reasoner API key is missing');
    expect(() =>
      readConfig({ ...env, JEV_API_URL: 'http://api.typesafe.ai/v1/systemone' }),
    ).toThrow('HTTPS');
    expect(() =>
      readConfig({ ...env, REASONER_PROVIDER: 'openai', OPENAI_API_KEY: 'fake' }),
    ).toThrow('Set REASONER_MODEL');
  });
});

describe('native Jev adapter', () => {
  it('sends typed questions and preserves confidence, raw probabilities and usage', async () => {
    const raw = response();
    const fetchMock = vi.fn().mockResolvedValue(Response.json(raw));
    vi.stubGlobal('fetch', fetchMock);
    const result = await reasoner(readConfig(env)).classify(context);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(request.headers.Authorization).toBe('Bearer synthetic-test-key');
    expect(request.redirect).toBe('error');
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({
      model: 'jev-latest',
      state: { move: { uci: 'g2g4' } },
      questions: { primary: { type: 'choice' } },
    });
    expect(Object.keys(body.questions.primary.criteria).sort()).toEqual([...labels].sort());
    expect(body).not.toHaveProperty('messages');
    expect(body).not.toHaveProperty('response_format');
    expect(result.classification).toMatchObject({
      primary: 'missed_tactical_defense',
      confidence: 0.72,
      secondary: [],
    });
    expect(result.classification.explanation).toContain('assembled locally');
    expect(result.classification.evidence).toContain(
      'Engine evaluation entered forced mate against the mover',
    );
    expect(result.raw).toEqual(raw);
    expect(result.usage).toEqual(raw.usage);
  });

  it('preserves unknown labels and low confidence without inventing certainty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(response('engine_only', 0.05))));
    const result = await reasoner(readConfig(env)).classify(context);
    expect(result.classification).toMatchObject({ primary: 'engine_only', confidence: 0.05 });
  });

  it('accepts rounded probabilities without changing provider confidence or raw values', async () => {
    const raw = response('engine_only', 0.61);
    raw.answers.primary.probabilities.engine_only = 0.71;
    raw.answers.primary.probabilities.unclear = 0.27;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(raw)));
    const result = await reasoner(readConfig(env)).classify(context);
    expect(result.classification.confidence).toBe(0.61);
    expect(result.raw).toEqual(raw);
  });

  it.each([
    'invented_label',
    'bad_confidence',
    'missing_probabilities',
    'invalid_sum',
    'wrong_winner',
    'chat_response',
  ])('rejects invalid native response: %s', async (failure) => {
    const raw = response();
    if (failure === 'invented_label') raw.answers.primary.choice = 'invented';
    if (failure === 'bad_confidence') raw.answers.primary.confidence = 1.5;
    if (failure === 'missing_probabilities') delete raw.answers.primary.probabilities.engine_only;
    if (failure === 'invalid_sum') raw.answers.primary.probabilities.engine_only = 0.5;
    if (failure === 'wrong_winner') raw.answers.primary.choice = 'engine_only';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            failure === 'chat_response' ? { choices: [{ message: { content: '{}' } }] } : raw,
          ),
        ),
    );
    await expect(reasoner(readConfig(env)).classify(context)).rejects.toThrow(
      'Jev returned an invalid typed response',
    );
  });

  it('retries overload once and does not retry invalid credentials or disclose response bodies', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('overloaded', { status: 529 }))
      .mockResolvedValueOnce(Response.json(response()));
    vi.stubGlobal('fetch', fetchMock);
    const pending = reasoner(readConfig(env)).classify(context);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toHaveProperty('classification');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock
      .mockReset()
      .mockResolvedValue(new Response('sensitive upstream diagnostic', { status: 401 }));
    await expect(reasoner(readConfig(env)).classify(context)).rejects.toThrow(
      'Reasoner returned HTTP 401',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
