import { afterEach, vi } from 'vitest';
import { createInMemoryDestination } from './mock-logger';

// Safe env defaults — `src/lib/env.ts` throws when these are missing.
process.env.GEMINI_API_KEY ??= 'test-gemini-key';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
process.env.GCS_BUCKET_NAME ??= 'test-bucket';
process.env.GCS_PROJECT_ID ??= 'test-project';
process.env.SAP_SESSION_SECRET ??= 'test-session-secret-at-least-32-characters-long-xx';

// Single shared in-memory destination per worker. Tests that want to inspect
// logs can import this same module and call `getCapturedEvents()`/`resetCapturedEvents()`.
const memo = createInMemoryDestination();

export function getCapturedEvents() {
  return memo.events();
}

export function resetCapturedEvents() {
  memo.reset();
}

vi.mock('@/lib/logger', async () => {
  const actual = await vi.importActual<typeof import('../../logger')>('../../logger');
  const { createLogger } = actual;
  const sharedLogger = createLogger({ serviceName: 'test', destination: memo.destination });
  return {
    ...actual,
    getLogger: () => sharedLogger,
  };
});

afterEach(() => {
  resetCapturedEvents();
  vi.restoreAllMocks();
});
