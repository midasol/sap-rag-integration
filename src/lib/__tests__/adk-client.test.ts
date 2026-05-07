import { describe, it, expect, vi, beforeEach } from 'vitest';
import { adk } from '../adk-client';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('adk-client', () => {
  it('runSse parses SSE chunks into typed events', async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"type":"text_delta","data":"hi"}\n\n'));
        c.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));
        c.close();
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { status: 200 }) as Response
    );

    const events: Array<{ type: string }> = [];
    for await (const e of adk.runSse({ userId: 'u', sessionId: 's', message: 'hi' })) {
      events.push(e);
    }
    expect(events.map((e) => e.type)).toEqual(['text_delta', 'done']);
  });

  it('runSse throws when response is not ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('boom', { status: 500 }) as Response
    );
    const gen = adk.runSse({ userId: 'u', sessionId: 's', message: 'hi' });
    await expect(async () => {
      // Must consume to trigger the request
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _event of gen) { /* drain */ }
    }).rejects.toThrow(/adk runSse 500/);
  });

  it('createSession POSTs to the session URL', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }) as Response);
    await adk.createSession('alice', 'sess-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/apps\/adk_agent\/users\/alice\/sessions\/sess-1$/);
    expect(init?.method).toBe('POST');
  });
});
