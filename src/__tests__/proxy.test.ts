import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCapturedEvents } from '../lib/__tests__/_support/setup';

const { getSessionMock } = vi.hoisted(() => ({ getSessionMock: vi.fn() }));

vi.mock('@/lib/session', () => ({
  getSession: getSessionMock,
}));

import { proxy, config } from '../proxy';

function makeReq(path = '/api/conversations'): Request {
  const req = new Request(`http://localhost${path}`, { method: 'GET' });
  Object.defineProperty(req, 'nextUrl', {
    value: new URL(`http://localhost${path}`),
    writable: false,
  });
  return req;
}

describe('proxy gate', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    delete process.env.REQUIRE_AUTH;
  });

  it('passes through when REQUIRE_AUTH is unset', async () => {
    const res = await proxy(makeReq() as never);
    expect(res.status).toBe(200);
    expect(getSessionMock).not.toHaveBeenCalled();
  });

  it('passes through when REQUIRE_AUTH is true and the session cookie is present', async () => {
    process.env.REQUIRE_AUTH = 'true';
    getSessionMock.mockResolvedValue({ sapUserId: 'alice', loggedInAt: Date.now() });
    const res = await proxy(makeReq() as never);
    expect(res.status).toBe(200);
  });

  it('returns 401 with the expected error body when not authed', async () => {
    process.env.REQUIRE_AUTH = 'true';
    getSessionMock.mockResolvedValue(null);
    const res = await proxy(makeReq() as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: /Authentication required/,
    });
  });

  it('emits auth.gate_blocked log event on 401 with path + requestId', async () => {
    process.env.REQUIRE_AUTH = 'true';
    getSessionMock.mockResolvedValue(null);
    await proxy(makeReq('/api/chat') as never);
    const events = getCapturedEvents().filter((e) => e.event === 'auth.gate_blocked');
    expect(events).toHaveLength(1);
    expect(events[0].path).toBe('/api/chat');
    expect(events[0].requestId).toMatch(/^req_/);
  });
});

describe('proxy matcher', () => {
  it('protects the expected routes and excludes /api/sap/auth', () => {
    expect(config.matcher).toEqual([
      '/api/chat',
      '/api/embed',
      '/api/conversations',
      '/api/pipeline/start',
      '/api/pipeline/upload',
      '/api/pipeline/status',
      '/api/files/:path*',
      '/api/sap/services',
    ]);
    expect(config.matcher).not.toContain('/api/sap/auth');
  });
});
