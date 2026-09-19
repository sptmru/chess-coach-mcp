import { createHash, randomBytes } from 'node:crypto';
import pino from 'pino';
export const log = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['authorization', 'password', 'token', 'apiKey'],
  },
  pino.destination(2),
);
export const hash = (v: unknown) =>
  createHash('sha256')
    .update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v))
    .digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const missing = () => new DomainError('not_found', 'Resource not found or not accessible');
export const safeError = (e: unknown) =>
  e instanceof DomainError ? e.message : 'Operation failed; retry or contact the operator';
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export class Gate {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(
    private limit: number,
    private maxWaiting = 64,
  ) {}
  get queued() {
    return this.waiters.length;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiters.length >= this.maxWaiting)
        throw new DomainError('busy', 'Server is busy; retry later');
      await new Promise<void>((r) => this.waiters.push(r));
    } else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}
export const metrics = new Map<string, { count: number; total: number }>();
export function metric(name: string, value = 1) {
  const m = metrics.get(name) ?? { count: 0, total: 0 };
  m.count++;
  m.total += value;
  metrics.set(name, m);
}
