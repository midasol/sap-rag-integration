import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
  }),
}));

const {
  adkSetSapCredentialsMock,
  setSessionMock,
  getOAuthPendingMock,
  clearOAuthPendingMock,
} = vi.hoisted(() => {
  const adkSetSapCredentialsMock = vi.fn();
  const setSessionMock = vi.fn(async () => {});
  const getOAuthPendingMock = vi.fn();
  const clearOAuthPendingMock = vi.fn(async () => {});
  return {
    adkSetSapCredentialsMock,
    setSessionMock,
    getOAuthPendingMock,
    clearOAuthPendingMock,
  };
});

vi.mock('@/lib/adk-client', () => ({
  adk: {
    setSapCredentials: adkSetSapCredentialsMock,
  },
}));

vi.mock('@/lib/session', () => ({
  setSession: setSessionMock,
}));

vi.mock('@/lib/oauth-pending', () => ({
  getOAuthPending: getOAuthPendingMock,
  clearOAuthPending: clearOAuthPendingMock,
}));

import { GET } from '../route';

function makeRequest(params: Record<string, string>): Request {
  const url = new URL('http://localhost/api/sap/oauth/callback');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new Request(url.toString());
}

const PENDING = { userId: 'pending-abc', sessionId: 'sess-pending-abc', state: 'state-xyz' };

describe('GET /api/sap/oauth/callback', () => {
  beforeEach(() => {
    adkSetSapCredentialsMock.mockReset();
    setSessionMock.mockReset();
    getOAuthPendingMock.mockReset();
    clearOAuthPendingMock.mockReset();

    setSessionMock.mockResolvedValue(undefined);
    clearOAuthPendingMock.mockResolvedValue(undefined);
  });

  it('400 when code is missing', async () => {
    const req = makeRequest({ state: 'state-xyz' });
    const res = await GET(req as never);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('missing_code_or_state');
  });

  it('400 when state is missing', async () => {
    const req = makeRequest({ code: 'auth-code-123' });
    const res = await GET(req as never);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('missing_code_or_state');
  });

  it('400 with error param passed through to HTML', async () => {
    const req = makeRequest({ error: 'access_denied' });
    const res = await GET(req as never);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('access_denied');
  });

  it('400 when no pending cookie exists', async () => {
    getOAuthPendingMock.mockResolvedValueOnce(null);
    const req = makeRequest({ code: 'auth-code-123', state: 'state-xyz' });
    const res = await GET(req as never);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('no_pending_oauth');
  });

  it('400 when state does not match pending cookie, clears pending', async () => {
    getOAuthPendingMock.mockResolvedValueOnce({ ...PENDING, state: 'different-state' });
    const req = makeRequest({ code: 'auth-code-123', state: 'state-xyz' });
    const res = await GET(req as never);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('state_mismatch');
    expect(clearOAuthPendingMock).toHaveBeenCalled();
  });

  it('200 on successful ADK exchange: sets session, clears pending, returns popup HTML', async () => {
    getOAuthPendingMock.mockResolvedValueOnce(PENDING);
    adkSetSapCredentialsMock.mockResolvedValueOnce({
      success: true,
      sap_user: 'alice',
      method: 'oauth',
    });

    const req = makeRequest({ code: 'auth-code-123', state: 'state-xyz' });
    const res = await GET(req as never);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"success":true');
    expect(body).toContain('"sap_user":"alice"');
    expect(setSessionMock).toHaveBeenCalledWith('alice');
    expect(clearOAuthPendingMock).toHaveBeenCalled();
  });

  it('401 when ADK returns failure envelope with error field', async () => {
    getOAuthPendingMock.mockResolvedValueOnce(PENDING);
    adkSetSapCredentialsMock.mockResolvedValueOnce({
      success: false,
      error: 'token_exchange_failed',
    });

    const req = makeRequest({ code: 'auth-code-123', state: 'state-xyz' });
    const res = await GET(req as never);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain('token_exchange_failed');
    expect(setSessionMock).not.toHaveBeenCalled();
    expect(clearOAuthPendingMock).toHaveBeenCalled();
  });

  it('401 with default error when ADK failure has no error field', async () => {
    getOAuthPendingMock.mockResolvedValueOnce(PENDING);
    adkSetSapCredentialsMock.mockResolvedValueOnce({ success: false });

    const req = makeRequest({ code: 'auth-code-123', state: 'state-xyz' });
    const res = await GET(req as never);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain('oauth_failed');
    expect(setSessionMock).not.toHaveBeenCalled();
  });

  it('500 when ADK call throws', async () => {
    getOAuthPendingMock.mockResolvedValueOnce(PENDING);
    adkSetSapCredentialsMock.mockRejectedValueOnce(new Error('network error'));

    const req = makeRequest({ code: 'auth-code-123', state: 'state-xyz' });
    const res = await GET(req as never);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('callback_failed');
  });
});
