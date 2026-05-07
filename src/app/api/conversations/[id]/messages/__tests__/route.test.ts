import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
  }),
}));

const {
  dbSelectFromConvOwnerMock,
  dbSelectFromMessagesMock,
  dbSelectMock,
  requireSessionMock,
} = vi.hoisted(() => {
  const dbSelectFromConvOwnerMock = vi.fn();
  const dbSelectFromMessagesMock = vi.fn();
  const dbSelectMock = vi.fn();
  const requireSessionMock = vi.fn();
  return {
    dbSelectFromConvOwnerMock,
    dbSelectFromMessagesMock,
    dbSelectMock,
    requireSessionMock,
  };
});

vi.mock('@/lib/db', () => ({
  db: {
    select: dbSelectMock,
  },
}));

vi.mock('@/lib/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/session')>('@/lib/session');
  return {
    ...actual,
    requireSession: requireSessionMock,
  };
});

import { GET } from '../route';
import { NotAuthenticatedError } from '@/lib/session';

const CONV_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  requireSessionMock.mockReset();
  dbSelectMock.mockReset();
  dbSelectFromConvOwnerMock.mockReset();
  dbSelectFromMessagesMock.mockReset();
});

function fakeReq() {
  return new Request(`http://localhost/api/conversations/${CONV_ID}/messages`);
}

function arrangeOwnerLookup(rows: Array<{ sapUserId: string }>) {
  // First db.select() → conversations owner lookup
  dbSelectMock.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({
        limit: async () => rows,
      }),
    }),
  }));
}

function arrangeMessagesQuery(rows: unknown[]) {
  dbSelectMock.mockImplementationOnce(() => ({
    from: () => ({
      where: () => ({
        orderBy: async () => rows,
      }),
    }),
  }));
}

describe('GET /api/conversations/[id]/messages', () => {
  it('returns 401 when no session', async () => {
    requireSessionMock.mockRejectedValue(new NotAuthenticatedError());
    const res = await GET(fakeReq() as never, { params: Promise.resolve({ id: CONV_ID }) });
    expect(res.status).toBe(401);
  });

  it('returns 400 when id is not a UUID', async () => {
    requireSessionMock.mockResolvedValue({ sapUserId: 'alice', loggedInAt: 1 });
    const res = await GET(fakeReq() as never, { params: Promise.resolve({ id: 'bad' }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 when conversation does not exist', async () => {
    requireSessionMock.mockResolvedValue({ sapUserId: 'alice', loggedInAt: 1 });
    arrangeOwnerLookup([]);
    const res = await GET(fakeReq() as never, { params: Promise.resolve({ id: CONV_ID }) });
    expect(res.status).toBe(404);
  });

  it('returns 403 when conversation belongs to another user', async () => {
    requireSessionMock.mockResolvedValue({ sapUserId: 'alice', loggedInAt: 1 });
    arrangeOwnerLookup([{ sapUserId: 'bob' }]);
    const res = await GET(fakeReq() as never, { params: Promise.resolve({ id: CONV_ID }) });
    expect(res.status).toBe(403);
  });

  it('returns the ordered messages when caller owns the conversation', async () => {
    requireSessionMock.mockResolvedValue({ sapUserId: 'alice', loggedInAt: 1 });
    arrangeOwnerLookup([{ sapUserId: 'alice' }]);
    const messages = [
      { id: 'm1', role: 'user', content: 'hi', attachments: [], createdAt: '2026-04-29T00:00:00Z' },
      { id: 'm2', role: 'assistant', content: 'hello', attachments: [], createdAt: '2026-04-29T00:00:01Z' },
    ];
    arrangeMessagesQuery(messages);
    const res = await GET(fakeReq() as never, { params: Promise.resolve({ id: CONV_ID }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(messages);
  });
});
