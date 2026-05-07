import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { getSession } from '@/lib/session';
import { getLogger } from '@/lib/logger';

/**
 * REQUIRE_AUTH gate (Next.js 16 proxy file convention, formerly middleware.ts).
 *
 * When REQUIRE_AUTH=true, blocks matched API routes unless the iron-session
 * cookie is present. When unset/false the proxy is a no-op so local dev is
 * unchanged. The actual per-route enforcement still happens in each handler
 * via requireSession() — this layer is a coarse network gate for staging.
 */
export async function proxy(req: NextRequest): Promise<NextResponse> {
  if (process.env.REQUIRE_AUTH !== 'true') {
    return NextResponse.next();
  }

  const requestId = `req_${randomUUID().slice(0, 8)}`;
  const session = await getSession();
  if (!session) {
    getLogger().info(
      { event: 'auth.gate_blocked', requestId, path: req.nextUrl.pathname },
      'auth.gate_blocked',
    );
    return NextResponse.json(
      { error: 'Authentication required. POST /api/sap/auth { method: "basic", username, password } to log in.' },
      { status: 401 },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/api/chat',
    '/api/embed',
    '/api/conversations',
    '/api/pipeline/start',
    '/api/pipeline/upload',
    '/api/pipeline/status',
    '/api/files/:path*',
    '/api/sap/services',
  ],
};
