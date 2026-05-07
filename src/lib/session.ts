import { cookies } from 'next/headers';
import { getIronSession, type IronSession, type SessionOptions } from 'iron-session';
import { env } from './env';
import type { SapCredentials } from './adk-client';

export const SAP_SESSION_COOKIE = 'sap_session';

export interface Session {
  sapUserId: string;
  loggedInAt: number;
  sapCredentials?: SapCredentials;
}

export class NotAuthenticatedError extends Error {
  readonly code = 'NOT_AUTHENTICATED';
  constructor() {
    super('NOT_AUTHENTICATED');
    this.name = 'NotAuthenticatedError';
  }
}

const EIGHT_HOURS_SECONDS = 8 * 60 * 60;

function options(): SessionOptions {
  return {
    cookieName: SAP_SESSION_COOKIE,
    password: env.SAP_SESSION_SECRET,
    cookieOptions: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      // maxAge intentionally omitted — iron-session derives it as ttl - 60s.
    },
    ttl: EIGHT_HOURS_SECONDS,
  };
}

async function load(): Promise<IronSession<Partial<Session>>> {
  const store = await cookies();
  return getIronSession<Partial<Session>>(store, options());
}

export async function getSession(): Promise<Session | null> {
  const session = await load();
  if (!session.sapUserId || typeof session.loggedInAt !== 'number') return null;
  return {
    sapUserId: session.sapUserId,
    loggedInAt: session.loggedInAt,
    sapCredentials: session.sapCredentials,
  };
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw new NotAuthenticatedError();
  return session;
}

export async function setSession(sapUserId: string, sapCredentials?: SapCredentials): Promise<void> {
  const session = await load();
  session.sapUserId = sapUserId;
  session.loggedInAt = Date.now();
  if (sapCredentials !== undefined) session.sapCredentials = sapCredentials;
  await session.save();
}

export async function clearSession(): Promise<void> {
  const session = await load();
  session.destroy();
}
