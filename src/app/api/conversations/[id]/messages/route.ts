import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { conversations, messages } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { requireSession, NotAuthenticatedError } from '@/lib/session';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let session;
  try {
    session = await requireSession();
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      return NextResponse.json({ error: 'NOT_AUTHENTICATED' }, { status: 401 });
    }
    throw err;
  }

  const { id } = await params;
  if (!id || !UUID_REGEX.test(id)) {
    return NextResponse.json({ error: 'Valid UUID id required' }, { status: 400 });
  }

  try {
    const ownerRows = await db
      .select({ sapUserId: conversations.sapUserId })
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);

    if (ownerRows.length === 0) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }
    if (ownerRows[0].sapUserId !== session.sapUserId) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }

    const rows = await db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        attachments: messages.attachments,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(messages.createdAt);

    return NextResponse.json(rows);
  } catch (err) {
    console.error('GET /api/conversations/[id]/messages error:', err instanceof Error ? err.message : 'Unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
