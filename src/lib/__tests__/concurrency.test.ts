import { describe, it, expect } from 'vitest';
import { mapWithLimit } from '../concurrency';

describe('mapWithLimit', () => {
  it('returns results in input order', async () => {
    const out = await mapWithLimit([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it('respects the concurrency limit', async () => {
    let inFlight = 0;
    let maxObserved = 0;
    await mapWithLimit([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight++;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return null;
    });
    expect(maxObserved).toBe(2);
  });

  it('propagates errors from fn', async () => {
    await expect(
      mapWithLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });

  it('rejects when limit is non-positive', async () => {
    await expect(mapWithLimit([1], 0, async () => 1)).rejects.toThrow(
      /limit must be > 0/,
    );
  });
});
