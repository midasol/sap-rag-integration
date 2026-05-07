import { describe, it, expect } from 'vitest';
import {
  runWithRequestContext,
  getRequestContext,
  type RequestContext,
} from '../request-context';

describe('request-context', () => {
  it('returns undefined when no context is bound', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it('exposes bound context to nested async work', async () => {
    const ctx: RequestContext = { requestId: 'req_a', conversationId: 'conv_a' };
    const result = await runWithRequestContext(ctx, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getRequestContext();
    });
    expect(result).toEqual(ctx);
  });

  it('isolates two concurrent contexts (no leakage)', async () => {
    const ctxA: RequestContext = { requestId: 'req_A', conversationId: 'conv_A' };
    const ctxB: RequestContext = { requestId: 'req_B', conversationId: 'conv_B' };

    const a = runWithRequestContext(ctxA, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return getRequestContext();
    });
    const b = runWithRequestContext(ctxB, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return getRequestContext();
    });

    const [resA, resB] = await Promise.all([a, b]);
    expect(resA).toEqual(ctxA);
    expect(resB).toEqual(ctxB);
  });
});
