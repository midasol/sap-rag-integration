import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Writable } from 'node:stream';

interface CapturedLine {
  level: number;
  msg?: string;
  event?: string;
  Authorization?: string;
  password?: string;
  api_key?: string;
  access_token?: string;
  username?: string;
  [k: string]: unknown;
}

function makeBufferStream(): { stream: Writable; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString('utf-8').trim();
      for (const raw of text.split('\n')) {
        if (!raw) continue;
        try {
          lines.push(JSON.parse(raw));
        } catch {
          // ignore non-JSON (pretty-printed) lines
        }
      }
      cb();
    },
  });
  return { stream, lines };
}

describe('logger', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.LOG_FORMAT = 'json';
    process.env.LOG_LEVEL = 'info';
  });

  it('redacts sensitive fields by exact key', async () => {
    const { stream, lines } = makeBufferStream();
    const { createLogger } = await import('../logger');

    const log = createLogger({ destination: stream });
    log.info(
      {
        event: 'auth.attempt',
        username: 'alice',
        password: 'hunter2',
        Authorization: 'Basic xxx',
        api_key: 'sk_xxx',
        access_token: 't_xxx',
      },
      'auth.attempt',
    );

    await new Promise((r) => setImmediate(r));
    expect(lines.length).toBe(1);
    expect(lines[0].password).toBe('[REDACTED]');
    expect(lines[0].Authorization).toBe('[REDACTED]');
    expect(lines[0].api_key).toBe('[REDACTED]');
    expect(lines[0].access_token).toBe('[REDACTED]');
    expect(lines[0].username).toBe('alice');
  });

  it('emits event field as a top-level key', async () => {
    const { stream, lines } = makeBufferStream();
    const { createLogger } = await import('../logger');

    const log = createLogger({ destination: stream });
    log.info({ event: 'chat.start', requestId: 'req_1' }, 'chat.start');

    await new Promise((r) => setImmediate(r));
    expect(lines[0].event).toBe('chat.start');
    expect(lines[0].requestId).toBe('req_1');
  });

  it('respects LOG_LEVEL=warn (info messages dropped)', async () => {
    process.env.LOG_LEVEL = 'warn';
    const { stream, lines } = makeBufferStream();
    const { createLogger } = await import('../logger');

    const log = createLogger({ destination: stream });
    log.info({ event: 'x.skip' }, 'x');
    log.warn({ event: 'x.kept' }, 'x');

    await new Promise((r) => setImmediate(r));
    const events = lines.map((l) => l.event);
    expect(events).not.toContain('x.skip');
    expect(events).toContain('x.kept');
  });
});
