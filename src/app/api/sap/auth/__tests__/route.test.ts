import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => undefined,
    delete: () => undefined,
  }),
}));

const {
  adkCreateSessionMock,
  adkSetSapCredentialsMock,
  setSessionMock,
  getSessionMock,
  clearSessionMock,
  setOAuthPendingMock,
  loggerMock,
} = vi.hoisted(() => {
  const adkCreateSessionMock = vi.fn(async () => {});
  const adkSetSapCredentialsMock = vi.fn();
  const setSessionMock = vi.fn(async () => {});
  const getSessionMock = vi.fn();
  const clearSessionMock = vi.fn(async () => {});
  const setOAuthPendingMock = vi.fn(async () => {});
  const loggerMock = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    adkCreateSessionMock,
    adkSetSapCredentialsMock,
    setSessionMock,
    getSessionMock,
    clearSessionMock,
    setOAuthPendingMock,
    loggerMock,
  };
});

vi.mock('@/lib/adk-client', () => ({
  adk: {
    createSession: adkCreateSessionMock,
    setSapCredentials: adkSetSapCredentialsMock,
  },
}));

vi.mock('@/lib/session', () => ({
  setSession: setSessionMock,
  getSession: getSessionMock,
  clearSession: clearSessionMock,
}));

vi.mock('@/lib/oauth-pending', () => ({
  setOAuthPending: setOAuthPendingMock,
}));

vi.mock('@/lib/logger', () => ({
  getLogger: () => loggerMock,
}));

import { GET, POST, DELETE } from '../route';

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/sap/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/sap/auth', () => {
  beforeEach(() => {
    adkCreateSessionMock.mockReset();
    adkSetSapCredentialsMock.mockReset();
    setSessionMock.mockReset();
    getSessionMock.mockReset();
    clearSessionMock.mockReset();
    setOAuthPendingMock.mockReset();
    loggerMock.warn.mockClear();
    loggerMock.info.mockClear();
    loggerMock.error.mockClear();
    loggerMock.debug.mockClear();

    // Default mocks
    adkCreateSessionMock.mockResolvedValue(undefined);
    getSessionMock.mockResolvedValue(null);
    setSessionMock.mockResolvedValue(undefined);
    clearSessionMock.mockResolvedValue(undefined);
    setOAuthPendingMock.mockResolvedValue(undefined);
  });

  it('200 on basic success', async () => {
    adkSetSapCredentialsMock.mockResolvedValueOnce({
      success: true,
      sap_user: 'admin',
      method: 'basic',
    });
    const req = jsonRequest({ method: 'basic', username: 'admin', password: 'p' });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, sap_user: 'admin' });
    expect(setSessionMock).toHaveBeenCalledWith('admin');
  });

  it('401 when ADK reports failure', async () => {
    adkSetSapCredentialsMock.mockResolvedValueOnce({
      success: false,
      error: 'invalid_credentials',
    });
    const req = jsonRequest({ method: 'basic', username: 'admin', password: 'bad' });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ success: false, error: 'invalid_credentials' });
    expect(setSessionMock).not.toHaveBeenCalled();
  });

  it('400 when basic credentials missing', async () => {
    const req = jsonRequest({ method: 'basic' });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      success: false,
      error: 'username and password are required',
    });
  });

  it('200 oauth start: returns login_url and action_required, calls setOAuthPending', async () => {
    adkSetSapCredentialsMock.mockResolvedValueOnce({
      login_url: 'https://sap.example.com/auth?response_type=code',
      oauth_state: 'abc123',
      success: false,
      action_required: 'sap_login',
      method: 'oauth',
    });
    const req = jsonRequest({ method: 'oauth' });
    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      success: false,
      action_required: 'sap_login',
      login_url: 'https://sap.example.com/auth?response_type=code',
      oauth_state: 'abc123',
    });
    expect(setOAuthPendingMock).toHaveBeenCalledOnce();
    expect(setOAuthPendingMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: expect.stringMatching(/^pending-/),
        sessionId: expect.stringMatching(/^sess-pending-/),
        state: 'abc123',
      })
    );
  });

  it('502 when oauth start: ADK returns error envelope', async () => {
    adkSetSapCredentialsMock.mockResolvedValueOnce({
      success: false,
      error: 'sap_unreachable',
    });
    const req = jsonRequest({ method: 'oauth' });
    const res = await POST(req as never);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      success: false,
      error: 'sap_unreachable',
    });
    expect(setOAuthPendingMock).not.toHaveBeenCalled();
  });

  it('400 for unknown method', async () => {
    const req = jsonRequest({ method: 'magic' });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      success: false,
      error: 'unknown_method',
    });
  });

  it('401 when ADK returns error without sap_user field', async () => {
    adkSetSapCredentialsMock.mockResolvedValueOnce({
      success: false,
      error: 'network_error',
    });
    const req = jsonRequest({ method: 'basic', username: 'admin', password: 'bad' });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ success: false, error: 'network_error' });
  });

  it('401 with default error when ADK response has no error field', async () => {
    adkSetSapCredentialsMock.mockResolvedValueOnce({ success: false });
    const req = jsonRequest({ method: 'basic', username: 'admin', password: 'bad' });
    const res = await POST(req as never);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('login_failed');
  });

  it('400 when method is missing', async () => {
    const req = jsonRequest({ username: 'admin', password: 'p' });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  it('500 on JSON parse error', async () => {
    const req = new Request('http://localhost/api/sap/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    const res = await POST(req as never);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      success: false,
      error: expect.any(String),
    });
  });
});

describe('DELETE /api/sap/auth', () => {
  beforeEach(() => {
    clearSessionMock.mockReset();
    clearSessionMock.mockResolvedValue(undefined);
  });

  it('200 and clears session', async () => {
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
    expect(clearSessionMock).toHaveBeenCalled();
  });
});

describe('GET /api/sap/auth', () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue(null);
  });

  it('returns authenticated state when session exists', async () => {
    getSessionMock.mockResolvedValueOnce({ sapUserId: 'alice', loggedInAt: 1 });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      authenticated: true,
      sap_user: 'alice',
    });
  });

  it('returns unauthenticated when no session', async () => {
    getSessionMock.mockResolvedValueOnce(null);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      authenticated: false,
      sap_user: null,
    });
  });

  it('returns sap_user null when session exists but sapUserId is undefined', async () => {
    getSessionMock.mockResolvedValueOnce({ loggedInAt: 1 });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      authenticated: true,
      sap_user: null,
    });
  });
});
