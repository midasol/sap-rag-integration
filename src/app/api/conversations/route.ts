import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { conversations } from '@/lib/schema';
import { and, eq, desc } from 'drizzle-orm';
import { requireSession, NotAuthenticatedError } from '@/lib/session';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unauthorized() {
  return NextResponse.json({ error: 'NOT_AUTHENTICATED' }, { status: 401 });
}

export async function GET() {
  let session;
  try {
    session = await requireSession();
  } catch (err) {
    if (err instanceof NotAuthenticatedError) return unauthorized();
    throw err;
  }

  try {
    const result = await db
      .select()
      .from(conversations)
      .where(eq(conversations.sapUserId, session.sapUserId))
      .orderBy(desc(conversations.updatedAt));

    return NextResponse.json(result);
  } catch (err) {
    console.error('GET /api/conversations error:', err instanceof Error ? err.message : 'Unknown error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  let session;
  try {
    session = await requireSession();
  } catch (err) {
    if (err instanceof NotAuthenticatedError) return unauthorized();
    throw err;
  }

  try {
    const body = await req.json();
    const title = typeof body.title === 'string' ? body.title.slice(0, 200) : 'New Chat';

    const [conv] = await db
      .insert(conversations)
      .values({ title, sapUserId: session.sapUserId })
      .returning();

    return NextResponse.json(conv);
  } catch (err) {
    console.error('POST /api/conversations error:', err instanceof Error ? err.message : 'Unknown error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  let session;
  try {
    session = await requireSession();
  } catch (err) {
    if (err instanceof NotAuthenticatedError) return unauthorized();
    throw err;
  }

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id || !UUID_REGEX.test(id)) {
      return NextResponse.json({ error: 'Valid UUID id required' }, { status: 400 });
    }

    await db
      .delete(conversations)
      .where(and(eq(conversations.id, id), eq(conversations.sapUserId, session.sapUserId)));

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/conversations error:', err instanceof Error ? err.message : 'Unknown error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
