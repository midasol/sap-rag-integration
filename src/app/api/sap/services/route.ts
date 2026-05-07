import { NextResponse } from 'next/server';
import { requireSession, NotAuthenticatedError } from '@/lib/session';

export const runtime = 'nodejs';
export const maxDuration = 60;

const ADK_BASE = process.env.ADK_BASE_URL ?? 'http://localhost:8200';

export async function GET() {
  let session;
  try {
    session = await requireSession();
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      return NextResponse.json({ error: 'NOT_AUTHENTICATED' }, { status: 401 });
    }
    throw err;
  }
  try {
    const r = await fetch(`${ADK_BASE}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        app_name: 'adk_agent',
        user_id: session.sapUserId,
        session_id: 'admin',
        new_message: {
          role: 'user',
          parts: [{ function_call: { name: 'sap_list_services', args: {} } }],
        },
      }),
    });
    if (!r.ok) {
      return NextResponse.json(
        { success: false, error: `adk ${r.status}` },
        { status: 502 },
      );
    }
    const text = await r.text();
    return new Response(text, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'adk unavailable' }, { status: 503 });
  }
}
