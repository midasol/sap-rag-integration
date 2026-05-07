# CLAUDE.md

Project context for Claude Code / future agent sessions.

## Stack

Next.js 16 (Turbopack) + React 19 + Tailwind v4 + Drizzle (postgres-js) +
@google/genai + @ai-sdk/google — chat UI shell + ingestion pipeline only.

Google ADK Python agent (`adk_agent/`, port 8200) — single LlmAgent with
5 tools: `search_documents` (pgvector RAG), `sap_authenticate`,
`sap_list_services`, `sap_query`, `sap_get_entity`. SAP integration is
in-process via the vendored `sap_gw_connector` package; the standalone
`sap-service/` FastAPI sidecar is removed.

## Parent-workspace trap (READ THIS BEFORE TOUCHING DEV)

If `pnpm dev` ever hangs on first request, fries the host's memory, or
spams `posix_spawn EAGAIN` errors:

**Cause.** Turbopack's CSS `@import` resolver does not honor
`turbopack.root` in `next.config.ts`. If a workspace marker file
(`package.json`, `*-lock.*`, `pnpm-workspace.yaml`, etc.) appears in the
**parent directory** of this project, Turbopack treats that parent as the
workspace root. Then `globals.css`'s `@import "tailwindcss"` resolves from
the wrong cwd, fails, and dumps a ~30 KB resolve-trace error object per CSS
chunk per compile. The Turbopack issue collector retains every error,
exhausting heap and the macOS fork pool within seconds.

**Symptoms.**
- `pnpm dev` boots fine (`✓ Ready in ~200ms`), but the first `GET /chat`
  never returns.
- `/tmp/sapphire-dev.log` (or whatever stderr is captured to) balloons to
  hundreds of KB of repeated `Error: Can't resolve 'tailwindcss' in
  '<parent dir>'` stack traces in seconds.
- Other shells start failing with `EAGAIN: resource temporarily
  unavailable, posix_spawn '/bin/sh'`.

**Fix.** Remove the offending parent-dir file, then clear `.next`:
```bash
rm /path/to/parent/package-lock.json   # or whichever marker triggered it
rm -rf .next
pnpm dev
```

**Defenses already in place.**
1. `scripts/check-parent-workspace.mjs` runs as `predev` and fails fast if
   any workspace marker is found in the parent directory.
2. `dev` script sets `NODE_OPTIONS=--max-old-space-size=4096` so Node hits
   OOM (with a usable error) before the OS fork pool is starved.
3. `next.config.ts` already pins `turbopack.root` and
   `outputFileTracingRoot` to `process.cwd()` — necessary but not
   sufficient (Turbopack ignores it for CSS).

**Upstream bug report.** Draft at
`docs/issues/2026-04-29-nextjs-turbopack-css-resolver-bug.md`. File against
`vercel/next.js` when ready.

**Do not bypass `predev`** unless you know the parent directory is clean
or you have re-verified Turbopack honors `turbopack.root` for CSS in your
Next version.

## Other dev notes

- DB: Postgres with pgvector (HNSW halfvec index — see migration history).
  `DATABASE_URL` in `.env.local`. `pnpm db:setup` to bootstrap schema.
- ADK Python agent must be running on `ADK_BASE_URL` (default
  `http://localhost:8200`) — `pnpm predev` enforces this. Start with:
  `uv run python -m adk_agent.server`.
- For OAuth callbacks: SAP must be configured to redirect to
  `${SAP_OAUTH_REDIRECT_URI}`, typically
  `http://localhost:3000/api/sap/oauth/callback` for dev.
  `/api/sap/oauth/callback` proxies to the ADK agent's Step 2 —
  no Cloud Run sidecar needed.
- HMR-aware singleton hardening for `db.ts` / `logger.ts` / `gemini.ts` /
  `gcs.ts` is **not yet applied** — currently they re-instantiate on
  module re-evaluation. Long dev sessions (many edits) will accumulate
  postgres pools and write streams. Track for a later cleanup pass.
- `SAP_SESSION_SECRET` (32+ chars) is required in `.env.local`. Used by
  `iron-session` to sign the `sap_session` cookie that scopes conversations
  per SAP user. Generate one with: `openssl rand -base64 48`.

## MCP servers (`.mcp.json`)

This project ships a project-scoped MCP config at `.mcp.json` (checked into
git). Anyone running Claude Code in this repo gets these MCP servers by
default after approving the project-scoped MCP prompt on first launch.

**Default registration: Google Cloud Pub/Sub MCP**

- Transport: HTTP at `https://pubsub.googleapis.com/mcp`
- Auth: OAuth 2.0 via Google credentials. Claude Code opens a browser flow
  on first tool call — no manual token wrangling.
- Billing project: `x-goog-user-project: sap-advanced-workshop-gck`
  (must match a GCP project the caller has access to). Edit `.mcp.json` if
  Pub/Sub lives in a different project.

**Prereqs to actually use it:**
1. Pub/Sub API enabled in `sap-advanced-workshop-gck`:
   `gcloud services enable pubsub.googleapis.com --project sap-advanced-workshop-gck`
2. Caller's principal has both:
   - `roles/mcp.toolUser` (gates the `mcp.tools.call` permission)
   - `roles/pubsub.editor` (or finer-grained Pub/Sub roles)
3. Local `gcloud auth application-default login` done at least once
   (Claude Code triggers an interactive OAuth flow if ADC is missing).

**Adding more MCP servers:** append entries under `mcpServers` in `.mcp.json`.
Restart Claude Code after editing — project MCP changes are picked up at
session start. Do NOT put secrets in `.mcp.json` (it's checked in); use
`headers` for non-secret routing only and rely on OAuth/ADC for credentials.

Reference: https://docs.cloud.google.com/pubsub/docs/use-pubsub-mcp

### Runtime Pub/Sub MCP (ADK agent)

Separate from Claude Code's `.mcp.json` consumption, the **deployed ADK
agent** also reads `.mcp.json` at startup and exposes the Pub/Sub MCP tools
to the LlmAgent. Wiring lives at `adk_agent/mcp_pubsub.py`; agent
construction at `adk_agent/agent.py` adds the toolset and registers the
resource gate as `before_tool_callback`.

**Schema additions** (also in `.mcp.json` under `mcpServers.pubsub`):

```json
{
  "allowedTools":         ["list_topics", "get_topic", "publish", ...],
  "allowedTopics":        ["sapphire-demo"],
  "allowedSubscriptions": ["sapphire-demo-sub"]
}
```

**Deny-by-default policy** (matches the sibling Next.js project):

| Field state | Effect |
|---|---|
| `allowedTools` missing or empty | 0 tools exposed to the LLM |
| `allowedTopics` missing | every call carrying a `topicId` arg is rejected |
| `allowedSubscriptions` missing | every call carrying a `subscriptionId` arg is rejected |

**Bearer-token freshness**: `MCPToolset.header_provider` is invoked per
HTTP exchange; ADC tokens are refreshed automatically without rebuilding
the toolset.

**Cloud Run deployment requirement**: the runtime service account must
hold both `roles/mcp.toolUser` and `roles/pubsub.editor` (or finer-grained
Pub/Sub roles). Local dev uses `service-account.json` if
`GOOGLE_APPLICATION_CREDENTIALS` points to it, else falls back to
`gcloud auth application-default login`.

**Verification**:
```bash
# unit tests for config + gate logic
uv run python -m pytest adk_agent/tests/unit/test_mcp_pubsub_config.py \
                       adk_agent/tests/unit/test_mcp_pubsub_gate.py -v --no-cov

# 8-check live e2e (requires sapphire-demo topic + sub to exist)
uv run python scripts/test_pubsub_mcp_live.py
```
