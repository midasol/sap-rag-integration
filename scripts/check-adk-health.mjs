#!/usr/bin/env node
// Predev guard. Refuses to start `next dev` if the ADK Python agent is not
// reachable on its /healthz endpoint. The Next.js chat/SAP routes proxy to
// the agent, so booting the UI without it produces a wall of 502/503s on
// first interaction. Failing fast here saves the trip.

const url = (process.env.ADK_BASE_URL ?? 'http://localhost:8200') + '/healthz';

try {
  const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!r.ok) {
    console.error(`\x1b[31m[predev] ADK ${url} returned ${r.status}\x1b[0m`);
    process.exit(1);
  }
  console.log(`[predev] ADK healthy at ${url}`);
} catch (e) {
  console.error(`\x1b[31m[predev] ADK not reachable at ${url}: ${e.message}\x1b[0m`);
  console.error('\x1b[33m[predev] start it with:\x1b[0m');
  console.error('  uv run python -m adk_agent.server');
  console.error('  # or: docker compose up -d adk');
  process.exit(1);
}
