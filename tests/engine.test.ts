import { it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Chess } from 'chess.js';
import { EnginePool } from '../src/stockfish/engine.js';
import { readConfig } from '../src/config.js';
async function fake(mode: 'normal' | 'hang' | 'crash') {
  const dir = await mkdtemp(join(tmpdir(), 'chess-engine-'));
  const path = join(dir, 'engine.cjs');
  await writeFile(
    path,
    `#!${process.execPath}
const rl = require('node:readline').createInterface({ input: process.stdin });
let searches = 0;
rl.on('line', line => {
  if (line === 'uci') console.log('id name FixtureEngine\\nuciok');
  if (line === 'isready') console.log('readyok');
  if (line.startsWith('go ')) {
    searches++;
    if ('${mode}' === 'crash') process.exit(1);
    if ('${mode}' === 'normal') {
      console.log('info depth 8 multipv 1 score cp ' + searches + ' pv e2e4 e7e5');
      console.log('bestmove e2e4');
    }
  }
});
`,
    { mode: 0o700 },
  );
  const pool = new EnginePool(
    readConfig({
      DATABASE_URL: 'postgresql://unused:unused@localhost/chess_test',
      STOCKFISH_PATH: path,
      ENGINE_TIMEOUT_MS: '300',
      LOG_LEVEL: 'silent',
    }),
  );
  return {
    pool,
    cleanup: async () => {
      await pool.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
it('reuses an engine process and serializes concurrent searches', async () => {
  const { pool, cleanup } = await fake('normal');
  try {
    await pool.start();
    const results = await Promise.all([
      pool.analyze(new Chess().fen(), { depth: 8, multiPv: 1 }),
      pool.analyze(new Chess().fen(), { depth: 8, multiPv: 1 }),
    ]);
    expect(results.map((r) => r.lines[0].score.value)).toEqual([1, 2]);
  } finally {
    await cleanup();
  }
});
it('times out, kills and restarts a stuck engine for the next request', async () => {
  const { pool, cleanup } = await fake('hang');
  try {
    await pool.start();
    await expect(pool.analyze(new Chess().fen(), { depth: 8, multiPv: 1 })).rejects.toThrow(
      'Stockfish failed',
    );
    await expect(pool.analyze(new Chess().fen(), { depth: 8, multiPv: 1 })).rejects.toThrow(
      'Stockfish failed',
    );
  } finally {
    await cleanup();
  }
});
it('turns engine crashes into bounded safe errors', async () => {
  const { pool, cleanup } = await fake('crash');
  try {
    await pool.start();
    await expect(pool.analyze(new Chess().fen(), { depth: 8, multiPv: 1 })).rejects.toThrow(
      'Stockfish failed',
    );
  } finally {
    await cleanup();
  }
});
