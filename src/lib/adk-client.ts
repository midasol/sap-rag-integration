const BASE = process.env.ADK_BASE_URL ?? 'http://localhost:8200';

export type AdkEvent =
  | { type: 'text_delta'; data: string }
  | { type: 'tool_call'; data: { name: string; args: unknown } }
  | { type: 'tool_result'; data: unknown }
  | { type: 'action_required'; data: { action: string; payload?: unknown } }
  | { type: 'error'; data: { message: string } }
  | { type: 'done' };

interface AdkRawEvent {
  partial?: boolean;
  content?: { parts?: Array<{
    text?: string;
    functionCall?: { name: string; args?: unknown };
    functionResponse?: { name?: string; response?: unknown };
  }> };
  error?: { message?: string } | string;
  errorCode?: string;
  errorMessage?: string;
}

function* normalizeAdkEvent(raw: AdkRawEvent): Iterable<AdkEvent> {
  // ADK forwards Gemini errors via errorCode/errorMessage; tool errors arrive in
  // functionResponse payloads. Surface either as a transport-level 'error'.
  if (raw.error || raw.errorCode || raw.errorMessage) {
    const message =
      typeof raw.error === 'string'
        ? raw.error
        : raw.error?.message ?? raw.errorMessage ?? raw.errorCode ?? 'agent_error';
    yield { type: 'error', data: { message } };
    return;
  }

  const parts = raw.content?.parts;
  if (!Array.isArray(parts)) return;

  // ADK emits partial:true chunks (incremental) followed by a final
  // partial:false aggregate of the same text. Drop the aggregate text events
  // to avoid duplicating; still forward function calls/responses (those only
  // arrive on the final event).
  const isAggregate = raw.partial === false;

  for (const p of parts) {
    if (typeof p.text === 'string' && p.text.length > 0) {
      if (isAggregate) continue;
      yield { type: 'text_delta', data: p.text };
    } else if (p.functionCall) {
      yield { type: 'tool_call', data: { name: p.functionCall.name, args: p.functionCall.args } };
    } else if (p.functionResponse) {
      yield { type: 'tool_result', data: p.functionResponse.response };
    }
  }
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<AdkEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let raw: AdkRawEvent;
      try {
        raw = JSON.parse(line.slice(5).trim()) as AdkRawEvent;
      } catch {
        continue; // malformed event
      }
      yield* normalizeAdkEvent(raw);
    }
  }
}

export type SapCredentials =
  | { type: 'basic'; user: string; password: string }
  | { type: 'oauth'; access_token: string; refresh_token?: string; sap_user?: string; expires_at?: string };

export interface AdkBasicAuthResult {
  success: boolean;
  sap_user?: string;
  error?: string;
  state?: { sap_credentials?: SapCredentials };
}

export const adk = {
  /** Create or refresh an ADK session, optionally seeding initial state. */
  async createSession(userId: string, sessionId: string, state?: object): Promise<void> {
    await fetch(`${BASE}/apps/adk_agent/users/${userId}/sessions/${sessionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state ?? {}),
    });
  },

  /** Verify SAP basic credentials via the dedicated ADK endpoint (bypasses LLM). */
  async authBasic(body: { username: string; password: string }): Promise<AdkBasicAuthResult> {
    const r = await fetch(`${BASE}/sap/auth/basic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`adk authBasic ${r.status}`);
    return r.json() as Promise<AdkBasicAuthResult>;
  },

  runSse(opts: { userId: string; sessionId: string; message: string }): AsyncGenerator<AdkEvent> {
    return (async function* () {
      const r = await fetch(`${BASE}/run_sse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          app_name: 'adk_agent',
          user_id: opts.userId,
          session_id: opts.sessionId,
          new_message: { role: 'user', parts: [{ text: opts.message }] },
          streaming: true,
        }),
      });
      if (!r.ok || !r.body) throw new Error(`adk runSse ${r.status}`);
      yield* parseSse(r.body);
    })();
  },
};
