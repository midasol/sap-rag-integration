import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
  }),
}));

const {
  dbInsertValuesMock,
  dbInsertMock,
  dbUpdateMock,
  dbSelectMock,
  adkCreateSessionMock,
  adkRunSseMock,
  requireSessionMock,
} = vi.hoisted(() => {
  const dbInsertValuesMock = vi.fn().mockResolvedValue(undefined);
  const dbInsertMock = vi.fn(() => ({ values: dbInsertValuesMock }));
  const dbUpdateMock = vi.fn(() => ({
    set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
  }));
  const dbSelectMock = vi.fn();
  const adkCreateSessionMock = vi.fn(async () => {});
  const adkRunSseMock = vi.fn();
  const requireSessionMock = vi.fn();
  return {
    dbInsertValuesMock,
    dbInsertMock,
    dbUpdateMock,
    dbSelectMock,
    adkCreateSessionMock,
    adkRunSseMock,
    requireSessionMock,
  };
});

vi.mock('@/lib/db', () => ({
  db: {
    insert: dbInsertMock,
    update: dbUpdateMock,
    select: dbSelectMock,
  },
}));

vi.mock('@/lib/adk-client', () => ({
  adk: {
    createSession: adkCreateSessionMock,
    runSse: adkRunSseMock,
  },
}));

vi.mock('@/lib/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/session')>('@/lib/session');
  return {
    ...actual,
    requireSession: requireSessionMock,
  };
});

import { POST } from '../route';
import { NotAuthenticatedError } from '@/lib/session';

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

/**
 * Default dbSelectMock setup used across describe blocks.
 *
 * The route issues two db.select() calls in the happy path:
 *   1. Owner check  → .select({sapUserId}).from(conversations).where(...).limit(1)
 *                     — result shape: [{ sapUserId: 'alice' }]
 *   2. Message count → .select({ value: count() }).from(messages).where(...)
 *                     — result shape: [{ value: 0 }]
 *
 * We use mockImplementationOnce so that the first call returns the owner chain
 * and the second call returns the count chain.
 */
function setupDefaultDbSelect(sapUserId = 'alice') {
  dbSelectMock.mockReset();
  // First call: owner lookup — chain ends with .limit()
  dbSelectMock.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({
        limit: async () => [{ sapUserId }],
      }),
    }),
  }));
  // Second call: message count — chain ends with awaitable .where()
  dbSelectMock.mockImplementationOnce(() => ({
    from: () => ({
      where: async () => [{ value: 0 }],
    }),
  }));
}

describe('POST /api/chat — validation', () => {
  beforeEach(() => {
    adkCreateSessionMock.mockReset();
    adkRunSseMock.mockReset();
    dbInsertMock.mockClear();
    dbInsertValuesMock.mockClear();
    requireSessionMock.mockReset();
    requireSessionMock.mockResolvedValue({ sapUserId: 'alice', loggedInAt: 1 });
    setupDefaultDbSelect();
  });

  it('400 on invalid JSON body', async () => {
    const req = new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /invalid JSON/ });
  });

  it('400 when message is missing', async () => {
    const res = await POST(jsonRequest({ conversationId: VALID_UUID }) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /message is required/ });
  });

  it('400 when conversationId is not a UUID', async () => {
    const res = await POST(
      jsonRequest({ message: 'hi', conversationId: 'not-a-uuid' }) as never,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /Valid conversationId/ });
  });

  it('400 when message exceeds 10000 chars', async () => {
    const res = await POST(
      jsonRequest({ message: 'x'.repeat(10001), conversationId: VALID_UUID }) as never,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /maximum length/ });
  });
});

describe('POST /api/chat — happy path', () => {
  beforeEach(() => {
    adkCreateSessionMock.mockReset();
    adkRunSseMock.mockReset();
    dbInsertMock.mockClear();
    dbInsertValuesMock.mockClear();
    requireSessionMock.mockReset();
    requireSessionMock.mockResolvedValue({ sapUserId: 'alice', loggedInAt: 1 });
    setupDefaultDbSelect();

    // Default ADK run: yield one text_delta then done
    adkRunSseMock.mockImplementation(async function* () {
      yield { type: 'text_delta', data: 'hello world' };
      yield { type: 'done' };
    });
  });

  it('streams adk events and writes assistant message on close', async () => {
    const req = jsonRequest({ message: 'hi', conversationId: VALID_UUID });
    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');

    // Drain the SSE body so the route's `finally` block runs (DB inserts happen there)
    const body = await res.text();
    expect(body).toContain('"text_delta"');
    expect(body).toContain('"done"');

    expect(dbInsertValuesMock).toHaveBeenCalled();
    const insertCalls = dbInsertValuesMock.mock.calls.map((c) => c[0]);
    const userInsert = insertCalls.find((c: Record<string, unknown>) => c.role === 'user');
    const assistantInsert = insertCalls.find((c: Record<string, unknown>) => c.role === 'assistant');
    expect(userInsert?.content).toBe('hi');
    expect(assistantInsert?.content).toBe('hello world');
  });

  it('emits SSE error event (HTTP 200) when adkRunSse throws inside the stream', async () => {
    setupDefaultDbSelect();
    adkRunSseMock.mockImplementation(async function* () {
      throw new Error('boom');
      // Satisfy TypeScript: unreachable but needed for generator typing
      yield { type: 'done' as const };
    });

    const res = await POST(
      jsonRequest({ message: 'hi', conversationId: VALID_UUID }) as never,
    );
    // The outer try/catch is only for errors before the stream begins.
    // Errors inside the generator are caught by the stream's try/catch and
    // emitted as an SSE `error` event — HTTP status remains 200.
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"error"');
    expect(body).toContain('agent unavailable');
  });

  it('forwards X-Request-ID response header', async () => {
    setupDefaultDbSelect();
    adkRunSseMock.mockImplementation(async function* () {
      yield { type: 'done' as const };
    });

    const res = await POST(
      jsonRequest({ message: 'hi', conversationId: VALID_UUID }) as never,
    );
    // Drain body so stream completes cleanly
    await res.text();
    expect(res.headers.get('X-Request-ID')).toMatch(/^req_/);
  });
});

describe('POST /api/chat — auth gate', () => {
  beforeEach(() => {
    adkCreateSessionMock.mockReset();
    adkRunSseMock.mockReset();
    dbInsertMock.mockClear();
    dbInsertValuesMock.mockClear();
    requireSessionMock.mockReset();
  });

  it('401 when no session', async () => {
    requireSessionMock.mockRejectedValue(new NotAuthenticatedError());
    const res = await POST(
      jsonRequest({ message: 'hi', conversationId: VALID_UUID }) as never,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'NOT_AUTHENTICATED' });
  });

  it('403 when conversation belongs to another user', async () => {
    requireSessionMock.mockResolvedValue({ sapUserId: 'alice', loggedInAt: 1 });
    // Owner check returns bob — alice should be denied
    dbSelectMock.mockImplementationOnce(() => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ sapUserId: 'bob' }],
        }),
      }),
    }));
    const res = await POST(
      jsonRequest({ message: 'hi', conversationId: VALID_UUID }) as never,
    );
    expect(res.status).toBe(403);
  });
});
