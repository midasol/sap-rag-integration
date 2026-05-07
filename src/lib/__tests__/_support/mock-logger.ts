import type { DestinationStream } from 'pino';

export interface CapturedLog {
  level: string;
  msg?: string;
  event?: string;
  [key: string]: unknown;
}

/**
 * Build an in-memory pino destination plus an `events` accessor that returns
 * everything written so far. Tests can call `reset()` between cases.
 */
export function createInMemoryDestination(): {
  destination: DestinationStream;
  events: () => CapturedLog[];
  reset: () => void;
} {
  let buffer: CapturedLog[] = [];
  const destination: DestinationStream = {
    write(chunk: string): void {
      const trimmed = chunk.trim();
      if (!trimmed) return;
      try {
        buffer.push(JSON.parse(trimmed));
      } catch {
        buffer.push({ level: 'unknown', msg: trimmed });
      }
    },
  };
  return {
    destination,
    events: () => [...buffer],
    reset: () => {
      buffer = [];
    },
  };
}
