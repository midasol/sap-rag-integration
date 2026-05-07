import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { adk } from '@/lib/adk-client';
import { db } from '@/lib/db';
import { messages, conversations } from '@/lib/schema';
import { eq, count } from 'drizzle-orm';
import { getLogger } from '@/lib/logger';
import { runWithRequestContext } from '@/lib/request-context';
import { requireSession, NotAuthenticatedError } from '@/lib/session';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_LENGTH = 10000;

export const maxDuration = 300;

export async function POST(req: NextRequest): Promise<Response> {
  const log = getLogger();
  const requestId = `req_${randomUUID().slice(0, 8)}`;
  const start = Date.now();

  // --- Safeguard 1: Input validation ---
  let body: { message?: unknown; conversationId?: unknown };
  try {
    body = await req.json();
  } catch {
    log.warn({ event: 'chat.bad_request', requestId, reason: 'invalid_json' }, 'chat.bad_request');
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { message, conversationId } = body;
  if (!message || typeof message !== 'string') {
    log.warn({ event: 'chat.bad_request', requestId, reason: 'missing_message' }, 'chat.bad_request');
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }
  if (!conversationId || typeof conversationId !== 'string' || !UUID_REGEX.test(conversationId)) {
    log.warn({ event: 'chat.bad_request', requestId, reason: 'invalid_conversation_id' }, 'chat.bad_request');
    return NextResponse.json({ error: 'Valid conversationId is required' }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    log.warn({ event: 'chat.bad_request', requestId, reason: 'message_too_long', length: message.length }, 'chat.bad_request');
    return NextResponse.json({ error: `Message exceeds maximum length of ${MAX_MESSAGE_LENGTH}` }, { status: 400 });
  }

  // --- Safeguard 2: Auth handling ---
  let session;
  try {
    session = await requireSession();
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      return NextResponse.json({ error: 'NOT_AUTHENTICATED' }, { status: 401 });
    }
    throw err;
  }

  // --- Safeguard 3: Request context ---
  return runWithRequestContext({ requestId, conversationId }, async () => {
    log.info(
      {
        event: 'chat.start',
        requestId,
        conversationId,
        msgLen: message.length,
        userMsgPreview: message.slice(0, 120),
      },
      'chat.start',
    );

    try {
      // --- Safeguard 4: Ownership check ---
      const ownerRows = await db
        .select({ sapUserId: conversations.sapUserId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      if (ownerRows.length === 0 || ownerRows[0].sapUserId !== session.sapUserId) {
        log.warn(
          { event: 'chat.forbidden', requestId, conversationId, sapUserId: session.sapUserId },
          'chat.forbidden',
        );
        return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
      }

      // --- Safeguard 7 (prep): Count existing messages before insert to detect first message ---
      const [{ value: msgCount }] = await db
        .select({ value: count() })
        .from(messages)
        .where(eq(messages.conversationId, conversationId));
      const isFirstMessage = msgCount === 0;

      // --- Safeguard 5: Persist user message before invoking ADK ---
      await db.insert(messages).values({
        conversationId,
        role: 'user',
        content: message,
      });

      // Best-effort ADK session creation, seeding SAP credentials from the
      // iron-session cookie so query/entity tools can authenticate to SAP
      // without going through the LLM.
      const seedState = session.sapCredentials
        ? { sap_credentials: session.sapCredentials }
        : undefined;
      await adk.createSession(session.sapUserId, conversationId, seedState).catch(() => {
        // Session may already exist; ADK will use the existing one
      });

      const encoder = new TextEncoder();
      let assistantText = '';

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for await (const ev of adk.runSse({
              userId: session.sapUserId,
              sessionId: conversationId,
              message,
            })) {
              if (ev.type === 'text_delta') {
                assistantText += ev.data;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
              } else if (
                ev.type === 'tool_call' ||
                ev.type === 'tool_result' ||
                ev.type === 'action_required' ||
                ev.type === 'error'
              ) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
              } else if (ev.type === 'done') {
                break;
              }
            }
            controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'));
          } catch (err) {
            const msg = err instanceof Error ? err.message : 'Unknown error';
            log.error({ event: 'chat.stream_error', requestId, conversationId, err: msg }, 'chat.stream_error');
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'error', data: { message: 'agent unavailable' } })}\n\n`),
            );
          } finally {
            controller.close();

            // --- Safeguards 6 & 7: Persist assistant message + optional title update ---
            try {
              if (assistantText) {
                await db.insert(messages).values({
                  conversationId,
                  role: 'assistant',
                  content: assistantText,
                });
              }

              if (isFirstMessage) {
                const title = message.length > 30 ? message.substring(0, 30) + '...' : message;
                await db
                  .update(conversations)
                  .set({ title, updatedAt: new Date() })
                  .where(eq(conversations.id, conversationId));
              }
            } catch (saveErr) {
              const msg = saveErr instanceof Error ? saveErr.message : 'Unknown';
              log.error({ event: 'chat.save_error', requestId, conversationId, err: msg }, 'chat.save_error');
            }

            // --- Safeguard 8: chat.complete log ---
            log.info(
              {
                event: 'chat.complete',
                requestId,
                conversationId,
                totalMs: Date.now() - start,
                replyLen: assistantText.length,
              },
              'chat.complete',
            );
          }
        },
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'X-Request-ID': requestId,
        },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      log.error(
        { event: 'chat.error', requestId, conversationId, err: errMsg },
        'chat.error',
      );
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
  });
}
