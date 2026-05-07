import { describe, it, expect, beforeEach, vi } from 'vitest';

const cookieStore = new Map<string, { value: string; options?: Record<string, unknown> }>();

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => {
      const entry = cookieStore.get(name);
      return entry ? { name, value: entry.value } : undefined;
    },
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      cookieStore.set(name, { value, options });
    },
    delete: (name: string) => {
      cookieStore.delete(name);
    },
  }),
}));

import {
  getSession,
  requireSession,
  setSession,
  clearSession,
  NotAuthenticatedError,
  SAP_SESSION_COOKIE,
} from '../session';

describe('session', () => {
  beforeEach(() => {
    cookieStore.clear();
  });

  it('getSession returns null when no cookie', async () => {
    expect(await getSession()).toBeNull();
  });

  it('setSession then getSession roundtrips the SAP user id', async () => {
    await setSession('alice@example.com');
    const session = await getSession();
    expect(session?.sapUserId).toBe('alice@example.com');
    expect(typeof session?.loggedInAt).toBe('number');
  });

  it('clearSession removes the cookie', async () => {
    await setSession('bob');
    await clearSession();
    expect(await getSession()).toBeNull();
  });

  it('requireSession throws NotAuthenticatedError when no session', async () => {
    await expect(requireSession()).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it('requireSession returns session when present', async () => {
    await setSession('carol');
    const session = await requireSession();
    expect(session.sapUserId).toBe('carol');
  });

  it('getSession returns null when cookie value is tampered', async () => {
    await setSession('dave');
    const entry = cookieStore.get(SAP_SESSION_COOKIE)!;
    // Flip a byte inside the integrity-protected portion of the iron-session
    // seal (the prefix before the trailing version segment). Tampering with
    // characters after the final '~' would be silently absorbed by
    // parseSeal's parseInt and not detected.
    const tampered = entry.value[10] === 'A'
      ? entry.value.slice(0, 10) + 'B' + entry.value.slice(11)
      : entry.value.slice(0, 10) + 'A' + entry.value.slice(11);
    cookieStore.set(SAP_SESSION_COOKIE, { ...entry, value: tampered });
    expect(await getSession()).toBeNull();
  });
});
