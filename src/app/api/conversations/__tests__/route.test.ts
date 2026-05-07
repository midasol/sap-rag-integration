import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
  }),
}));

const {
  dbInsertValuesReturningMock,
  dbInsertValuesMock,
  dbInsertMock,
  dbDeleteWhereMock,
  dbDeleteMock,
  dbSelectOrderByMock,
  dbSelectFromMock,
  dbSelectMock,
  getSessionMock,
  requireSessionMock,
} = vi.hoisted(() => {
  const dbInsertValuesReturningMock = vi.fn(async () => [{ id: 'new-uuid', title: 'New Chat', sapUserId: 'alice' }]);
  const dbInsertValuesMock = vi.fn(() => ({ returning: dbInsertValuesReturningMock }));
  const dbInsertMock = vi.fn(() => ({ values: dbInsertValuesMock }));
  const dbDeleteWhereMock = vi.fn(async () => undefined);
  const dbDeleteMock = vi.fn(() => ({ where: dbDeleteWhereMock }));
  const dbSelectOrderByMock = vi.fn(async (): Promise<unknown[]> => []);
  const dbSelectFromMock = vi.fn(() => ({ where: vi.fn(() => ({ orderBy: dbSelectOrderByMock })) }));
  const dbSelectMock = vi.fn(() => ({ from: dbSelectFromMock }));
  const getSessionMock = vi.fn();
  const requireSessionMock = vi.fn();
  return {
    dbInsertValuesReturningMock,
    dbInsertValuesMock,
    dbInsertMock,
    dbDeleteWhereMock,
    dbDeleteMock,
    dbSelectOrderByMock,
    dbSelectFromMock,
    dbSelectMock,
    getSessionMock,
    requireSessionMock,
  };
});

vi.mock('@/lib/db', () => ({
  db: {
    insert: dbInsertMock,
    delete: dbDeleteMock,
    select: dbSelectMock,
  },
}));

vi.mock('@/lib/session', async () => {
  const actual = await vi.importActual<typeof import('@/lib/session')>('@/lib/session');
  return {
    ...actual,
    getSession: getSessionMock,
    requireSession: requireSessionMock,
  };
});

import { GET, POST, DELETE } from '../route';
import { NotAuthenticatedError } from '@/lib/session';

const VALID_UUID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  getSessionMock.mockReset();
  requireSessionMock.mockReset();
  dbInsertMock.mockClear();
  dbInsertValuesMock.mockClear();
  dbInsertValuesReturningMock.mockClear();
  dbDeleteMock.mockClear();
  dbDeleteWhereMock.mockClear();
  dbSelectMock.mockClear();
  dbSelectFromMock.mockClear();
  dbSelectOrderByMock.mockClear();
});

describe('GET /api/conversations', () => {
  it('returns 401 when no session', async () => {
    requireSessionMock.mockRejectedValue(new NotAuthenticatedError());
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'NOT_AUTHENTICATED' });
  });

  it('queries scoped by sap_user_id when session present', async () => {
    requireSessionMock.mockResolvedValue({ sapUserId: 'alice', loggedInAt: 1 });
    dbSelectOrderByMock.mockResolvedValue([{ id: 'c1', title: 't', sapUserId: 'alice' }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: 'c1', title: 't', sapUserId: 'alice' }]);
    expect(dbSelectFromMock).toHaveBeenCalled();
  });
});

describe('POST /api/conversations', () => {
  it('returns 401 when no session', async () => {
    requireSessionMock.mockRejectedValue(new NotAuthenticatedError());
    const req = new Request('http://localhost/api/conversations', {
      method: 'POST',
      body: JSON.stringify({}),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
  });

  it('inserts with sapUserId from session', async () => {
    requireSessionMock.mockResolvedValue({ sapUserId: 'alice', loggedInAt: 1 });
    const req = new Request('http://localhost/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ title: 'My new chat' }),
      headers: { 'Content-Type': 'application/json' },
    });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(dbInsertValuesMock).toHaveBeenCalledWith({ title: 'My new chat', sapUserId: 'alice' });
  });
});

describe('DELETE /api/conversations', () => {
  it('returns 401 when no session', async () => {
    requireSessionMock.mockRejectedValue(new NotAuthenticatedError());
    const req = new Request(`http://localhost/api/conversations?id=${VALID_UUID}`, {
      method: 'DELETE',
    });
    const res = await DELETE(req as never);
    expect(res.status).toBe(401);
  });

  it('returns 400 when id is not a UUID', async () => {
    requireSessionMock.mockResolvedValue({ sapUserId: 'alice', loggedInAt: 1 });
    const req = new Request('http://localhost/api/conversations?id=not-uuid', {
      method: 'DELETE',
    });
    const res = await DELETE(req as never);
    expect(res.status).toBe(400);
  });

  it('deletes scoped by sap_user_id', async () => {
    requireSessionMock.mockResolvedValue({ sapUserId: 'alice', loggedInAt: 1 });
    const req = new Request(`http://localhost/api/conversations?id=${VALID_UUID}`, {
      method: 'DELETE',
    });
    const res = await DELETE(req as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(dbDeleteWhereMock).toHaveBeenCalled();
  });
});
