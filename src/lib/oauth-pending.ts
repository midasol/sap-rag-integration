import { cookies } from 'next/headers';
import { getIronSession, type IronSession, type SessionOptions } from 'iron-session';
import { env } from './env';

const PENDING_COOKIE = 'sap_oauth_pending';
const TEN_MINUTES = 10 * 60;

export interface OAuthPending {
  userId: string;
  sessionId: string;
  state: string;
}

function options(): SessionOptions {
  return {
    cookieName: PENDING_COOKIE,
    password: env.SAP_SESSION_SECRET, // reuse the existing secret
    cookieOptions: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    },
    ttl: TEN_MINUTES,
  };
}

async function load(): Promise<IronSession<Partial<OAuthPending>>> {
  const store = await cookies();
  return getIronSession<Partial<OAuthPending>>(store, options());
}

export async function setOAuthPending(p: OAuthPending): Promise<void> {
  const s = await load();
  s.userId = p.userId;
  s.sessionId = p.sessionId;
  s.state = p.state;
  await s.save();
}

export async function getOAuthPending(): Promise<OAuthPending | null> {
  const s = await load();
  if (!s.userId || !s.sessionId || !s.state) return null;
  return { userId: s.userId, sessionId: s.sessionId, state: s.state };
}

export async function clearOAuthPending(): Promise<void> {
  const s = await load();
  s.destroy();
}
