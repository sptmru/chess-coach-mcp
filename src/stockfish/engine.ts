import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import type { Config } from '../config.js';
import type { EngineConfig, EngineLine, EngineResult } from '../domain/types.js';
import { canonical } from '../analysis/evaluation.js';
import { Chess } from 'chess.js';
import { DomainError, Gate, hash, metric } from '../utils/core.js';
class EngineProcess {
  private child?: ChildProcessWithoutNullStreams;
  private lineListener?: (line: string) => void;
  private reject?: (e: Error) => void;
  version = 'unknown';
  constructor(private config: Config) {}
  private send(line: string) {
    if (!this.child?.stdin.writable) throw new Error('engine_unavailable');
    this.child.stdin.write(line + '\n');
  }
  private wait(
    command: string,
    finished: (line: string) => boolean,
    onLine?: (line: string) => void,
  ) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        metric('engine_timeouts');
        this.kill();
        finish(new Error('engine_timeout'));
      }, this.config.ENGINE_TIMEOUT_MS);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.lineListener = undefined;
        this.reject = undefined;
        if (error) reject(error);
        else resolve();
      };
      this.reject = (e) => finish(e);
      this.lineListener = (line) => {
        onLine?.(line);
        if (finished(line)) finish();
      };
      try {
        this.send(command);
      } catch {
        finish(new Error('engine_unavailable'));
      }
    });
  }
  async start() {
    if (this.child) return;
    const child = spawn(this.config.STOCKFISH_PATH, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this.lineListener?.(line));
    child.stderr.resume();
    const died = () => {
      if (this.child === child) {
        this.child = undefined;
        metric('engine_crashes');
        this.reject?.(new Error('engine_crashed'));
      }
      rl.close();
    };
    child.stdin.on('error', died);
    child.on('error', died);
    child.on('exit', died);
    try {
      await this.wait(
        'uci',
        (l) => l === 'uciok',
        (l) => {
          if (l.startsWith('id name ')) this.version = l.slice(8);
        },
      );
      this.send(`setoption name Threads value ${this.config.ENGINE_THREADS}`);
      this.send(`setoption name Hash value ${this.config.ENGINE_HASH_MB}`);
      await this.wait('isready', (l) => l === 'readyok');
    } catch (e) {
      this.kill();
      throw e;
    }
  }
  async analyze(fen: string, options: EngineConfig, searchMove?: string): Promise<EngineResult> {
    await this.start();
    const chess = new Chess(fen);
    if (chess.isCheckmate())
      return {
        bestMove: null,
        lines: [
          { rank: 1, depth: 0, score: canonical({ type: 'mate', value: 0 }, chess.turn()), pv: [] },
        ],
      };
    if (chess.isStalemate() || chess.isInsufficientMaterial())
      return {
        bestMove: null,
        lines: [{ rank: 1, depth: 0, score: { type: 'cp', value: 0 }, pv: [] }],
      };
    // Clear hash per position to make compatible runs independent of previous workloads.
    this.send('ucinewgame');
    this.send('setoption name Clear Hash');
    this.send(`setoption name MultiPV value ${searchMove ? 1 : options.multiPv}`);
    await this.wait('isready', (l) => l === 'readyok');
    this.send(`position fen ${fen}`);
    const lines = new Map<number, EngineLine>();
    let bestMove: string | null = null;
    await this.wait(
      `go depth ${options.depth}${searchMove ? ` searchmoves ${searchMove}` : ''}`,
      (l) => l.startsWith('bestmove '),
      (line) => {
        if (line.startsWith('bestmove ')) {
          const m = line.split(' ')[1];
          bestMove = m === '(none)' || m === '0000' ? null : m;
        }
        const score = /\bscore (cp|mate) (-?\d+)\b/.exec(line),
          depth = /\bdepth (\d+)/.exec(line),
          pv = /\bpv (.+)/.exec(line);
        if (!score || !depth || !pv || /\b(lowerbound|upperbound)\b/.test(line)) return;
        const rank = Number(/\bmultipv (\d+)/.exec(line)?.[1] ?? 1);
        lines.set(rank, {
          rank,
          depth: Number(depth[1]),
          score: canonical(
            { type: score[1] as 'cp' | 'mate', value: Number(score[2]) },
            chess.turn(),
          ),
          pv: pv[1].split(' ').slice(0, 24),
        });
      },
    );
    if (!lines.size) throw new Error('engine_no_score');
    return { bestMove, lines: [...lines.values()].sort((a, b) => a.rank - b.rank) };
  }
  kill() {
    const child = this.child;
    this.child = undefined;
    child?.kill('SIGKILL');
    this.reject?.(new Error('engine_closed'));
  }
}
export class EnginePool {
  private engines: EngineProcess[];
  private available: EngineProcess[];
  private gate: Gate;
  private closed = false;
  binaryHash = '';
  constructor(readonly config: Config) {
    this.engines = Array.from({ length: config.ENGINE_POOL_SIZE }, () => new EngineProcess(config));
    this.available = [...this.engines];
    this.gate = new Gate(config.ENGINE_POOL_SIZE, 32);
  }
  get version() {
    return this.engines[0].version;
  }
  get queueDepth() {
    return this.gate.queued;
  }
  async start() {
    this.binaryHash = hash(await readFile(this.config.STOCKFISH_PATH));
    await Promise.all(this.engines.map((e) => e.start()));
  }
  async analyze(fen: string, options: EngineConfig, searchMove?: string) {
    if (this.closed) throw new DomainError('unavailable', 'Engine is shutting down');
    if (
      options.depth < 1 ||
      options.depth > this.config.MAX_DEPTH ||
      options.multiPv < 1 ||
      options.multiPv > this.config.MAX_MULTIPV
    )
      throw new DomainError('limits', 'Engine limits exceeded');
    const chess = new Chess(fen);
    if (
      searchMove &&
      !chess
        .moves({ verbose: true })
        .some((m) => m.from + m.to + (m.promotion ?? '') === searchMove)
    )
      throw new DomainError('invalid_move', 'Move is not legal in this position');
    return this.gate.run(async () => {
      if (this.closed) throw new DomainError('unavailable', 'Engine is shutting down');
      const engine = this.available.pop()!;
      const start = Date.now();
      try {
        return await engine.analyze(fen, options, searchMove);
      } catch {
        engine.kill();
        throw new DomainError(
          'engine_failure',
          'Stockfish failed or timed out; retry the operation',
        );
      } finally {
        this.available.push(engine);
        metric('engine_latency_ms', Date.now() - start);
      }
    });
  }
  async close() {
    this.closed = true;
    this.engines.forEach((e) => e.kill());
  }
}
