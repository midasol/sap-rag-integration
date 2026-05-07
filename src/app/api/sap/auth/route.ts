import { NextRequest, NextResponse } from 'next/server';
import { adk } from '@/lib/adk-client';
import { getSession, setSession, clearSession } from '@/lib/session';
import { setOAuthPending } from '@/lib/oauth-pending';
import { getLogger } from '@/lib/logger';

export const runtime = 'nodejs';

export async function GET() {
  const session = await getSession();
  return NextResponse.json({
    authenticated: session !== null,
    sap_user: session?.sapUserId ?? null,
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { method } = body as { method?: string; username?: string; password?: string };

    if (method === 'basic') {
      const { username, password } = body as { username?: string; password?: string };
      if (!username || !password) {
        return NextResponse.json(
          { success: false, error: 'username and password are required' },
          { status: 400 }
        );
      }

      const result = await adk.authBasic({ username, password });

      if (result.success) {
        const sapUser = result.sap_user ?? username;
        await setSession(sapUser, result.state?.sap_credentials);
        return NextResponse.json({ success: true, sap_user: sapUser });
      }

      getLogger().warn({ event: 'sap.login_failed', sap_user: username }, 'sap.login_failed');
      return NextResponse.json(
        { success: false, error: result.error ?? 'login_failed' },
        { status: 401 }
      );
    }

    if (method === 'oauth') {
      // OAuth start path needs a dedicated /sap/auth/oauth/start endpoint on
      // the ADK side (the previous wiring used /run with a function_call,
      // which Gemini rejects on user-side messages). Tracked as follow-up.
      return NextResponse.json(
        { success: false, error: 'oauth_pending_dedicated_endpoint' },
        { status: 501 }
      );
    }

    return NextResponse.json({ success: false, error: 'unknown_method' }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  await clearSession();
  return NextResponse.json({ success: true });
}
