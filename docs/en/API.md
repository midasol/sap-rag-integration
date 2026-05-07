# API Reference

This document covers both the Next.js HTTP surface (port 3000) and the ADK
agent's HTTP surface (port 8200), plus the five LLM tools the agent exposes.

The legacy `sap-service/` FastAPI sidecar is removed — there are **no**
endpoints on port 8100 anymore.

## Table of contents

- [Next.js API routes](#nextjs-api-routes)
  - [`POST /api/chat`](#post-apichat)
  - [`GET / POST / DELETE /api/conversations`](#conversation-crud)
  - [`GET /api/conversations/[id]/messages`](#get-apiconversationsidmessages)
  - [`POST /api/embed`](#post-apiembed)
  - [`POST /api/pipeline/start`](#post-apipipelinestart)
  - [`POST /api/pipeline/upload`](#post-apipipelineupload)
  - [`GET /api/pipeline/status`](#get-apipipelinestatus)
  - [`GET /api/files/[...path]`](#get-apifilespath)
  - [`POST /api/sap/auth`](#post-apisapauth)
  - [`GET /api/sap/oauth/callback`](#get-apisapoauthcallback)
  - [`GET /api/sap/services`](#get-apisapservices)
- [ADK agent endpoints](#adk-agent-endpoints)
- [LLM tools (called by the agent itself)](#llm-tools-called-by-the-agent-itself)
- [SSE event shapes](#sse-event-shapes)
- [Auth and error model](#auth-and-error-model)

---

## Next.js API routes

All routes set `runtime='nodejs'` and most pin `maxDuration = 300` (5 min).
The `sap_session` cookie (iron-session, 8 h TTL) is the canonical auth
indicator; `requireSession()` returns 401 with `{error:"NOT_AUTHENTICATED"}`
when missing.

### `POST /api/chat`

Streams an ADK chat reply over Server-Sent Events. Persists the user message
before invoking ADK, persists the assistant message after the stream ends,
auto-titles the conversation on first turn.

**Request**

```json
{
  "conversationId": "uuid",
  "content": "string",
  "attachments": [{ "fileName": "string", "mimeType": "string", "url": "string" }]
}
```

**Auth**: `sap_session` cookie required. The handler also verifies the
caller owns `conversationId` (`conversations.sap_user_id` match).

**Response**: `text/event-stream`. Each event payload is JSON; see
[SSE event shapes](#sse-event-shapes) below.

**Status codes**

| Status | Meaning |
|--------|---------|
| 200 | Stream begins immediately |
| 401 | `NOT_AUTHENTICATED` (no/expired `sap_session`) |
| 403 | Conversation belongs to a different SAP user |
| 404 | Conversation does not exist |
| 502 | ADK upstream error (logged with request id) |
| 503 | ADK unreachable (predev / health probe failed) |

### Conversation CRUD

`/api/conversations`

| Method | Body / params | Returns | Notes |
|--------|---------------|---------|-------|
| `GET` | — | `[{id, title, updatedAt, …}]` | Filtered by `conversations.sap_user_id` |
| `POST` | `{title?: string}` | `{id, title, …}` | Creates a row with current `sapUserId` |
| `DELETE` | `?id=<uuid>` | `{deleted: true}` | DELETE filters by `sapUserId` for safety |

All require `sap_session`.

### `GET /api/conversations/[id]/messages`

Returns ordered messages for a conversation:
`[{id, role, content, fileName, attachments, createdAt}]`. Verifies
ownership; returns `401 / 403 / 404` accordingly.

### `POST /api/embed`

Multipart upload of one file. Body: `multipart/form-data` with field
`file`. Max 100 MB enforced server-side.

Runs `embedFile(buffer, fileName)` synchronously: uploads to GCS, then
embeds based on category — text (chunked), pdf (6-page slices),
image/audio/video (multimodal embedding + AI summary).

**Returns**: `{success: true, fileName, chunks: number, gcsUrl}`.

### `POST /api/pipeline/start`

Kicks off a background batch ingestion. Body:
`{sourcePath: "./data" | "gs://bucket/prefix"}`. Local paths must be under
`./data` or `./uploads`.

Concurrency 3, 3 retries per file. Updates the in-memory `pipeline-state`
singleton; poll `/api/pipeline/status`.

**Returns**: `{started: true}` (or `409` if a run is already in progress).

### `POST /api/pipeline/upload`

Multipart `files[]` upload. Buffers each file, then runs `embedFile` in
background batches of 3.

### `GET /api/pipeline/status`

Returns the singleton snapshot:

```json
{
  "running": boolean,
  "total": number,
  "succeeded": number,
  "failed": number,
  "currentFile": "string | null",
  "logs": [{ "ts": "iso", "level": "info|warn|error", "msg": "string" }]
}
```

The state is in-memory and resets on process restart. No persistence.

### `GET /api/files/[...path]`

Streams a file from GCS. The path is appended to the bucket root and
**must** sit under `uploads/`. Any `..` triggers a 400.

**Cache**: `Cache-Control: public, max-age=86400`.

### `POST /api/sap/auth`

Single endpoint for all SAP-auth operations.

| Body | Behavior |
|------|----------|
| `{method: "basic", username, password}` | Forwards to ADK `/sap/auth/basic`. On success, sets the `sap_session` cookie and returns `{success:true, sap_user, method:"basic"}` |
| `{method: "oauth"}` | Returns `501 not_implemented` — the OAuth flow is initiated by the LLM mid-chat via the `sap_authenticate` tool, not by this endpoint |

`GET` returns the current session probe (`{authenticated, sapUserId}`).
`DELETE` clears the cookie and returns `{loggedOut: true}`.

### `GET /api/sap/oauth/callback`

Receives `?code&state` after the user completes the SAP OAuth flow. Validates
`state` against the `sap_oauth_pending` cookie. **Currently fails closed** —
returns a popup HTML that posts a failure message to the parent window.
Step-2 (token exchange via ADK) is wired in `adk_agent/oauth.exchange_code`
but not yet called from this route. Tracked in
[`docs/followups/post-migration.md`](../followups/post-migration.md).

### `GET /api/sap/services`

Calls ADK `/run` with `function_call: sap_list_services` and forwards the
JSON. Requires `sap_session`. `maxDuration = 60`.

```json
{
  "services": [
    {
      "id": "API_PRODUCT_SRV",
      "name": "Product",
      "path": "/sap/opu/odata/sap/API_PRODUCT_SRV",
      "version": "v2",
      "entities": [
        { "name": "A_Product", "key_field": "Product", "description": "..." }
      ]
    }
  ]
}
```

---

## ADK agent endpoints

The ADK agent is built by `google.adk.cli.fast_api.get_fast_api_app` plus
two custom routes. Base URL: `${ADK_BASE_URL}` (default
`http://localhost:8200`).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/healthz` | `{status:"ok"}` once startup probes pass; `predev` requires this |
| `POST` | `/sap/auth/basic` | Direct `sap_authenticate(method="basic", …)` invocation. Bypasses the LLM/`/run` envelope so the Next.js login route can seed encrypted creds into the iron-session cookie |
| `POST` | `/run` | Standard ADK function-call entrypoint. Used by `/api/sap/services` to invoke `sap_list_services` directly |
| `POST` | `/run_sse` | Standard ADK SSE endpoint. Used by `/api/chat` for streaming chat |

`/run` and `/run_sse` are documented by the ADK runtime itself
(<https://google.github.io/adk-docs/>); both expect `app_name: "adk_agent"`
and a `state` blob the Next.js layer uses to pass `sap_credentials`.

CORS is restricted to `http://localhost:3000` by default (see
`adk_agent/server.py`).

---

## LLM tools (called by the agent itself)

These are not HTTP endpoints — they are Python callables registered with the
`LlmAgent`. Documented here so you can write deterministic tests and reason
about what the LLM will see.

### `search_documents`

```python
search_documents(query: str, top_k: int = 8) -> dict
```

pgvector cosine search over the `embeddings` table.

**Returns**

```json
{
  "results": [
    { "id": "...", "file_name": "...", "chunk_text": "...", "score": 0.81 }
  ],
  "count": N
}
```

Soft-fail envelopes: `{"results": [], "count": 0, "warning": "embedding_unavailable"}` or `"vector_db_unavailable"` when the embed model or DB is down. The agent treats these as "no results" rather than errors.

### `sap_authenticate`

```python
sap_authenticate(
    method: str | None = None,   # "basic" | "oauth", defaults to env SAP_AUTH_TYPE
    username: str | None = None,
    password: str | None = None,
    code: str | None = None,
    state: str | None = None,
    user_id: str | None = None,
) -> dict
```

| Scenario | Returns |
|----------|---------|
| Basic, OK | `{success:true, sap_user, method:"basic", credentials:{...encrypted}}` |
| Basic, bad password | `{success:false, error:"invalid_credentials"}` |
| OAuth Step 1 | `{success:false, action_required:"sap_login", login_url, oauth_state, method:"oauth"}` |
| OAuth Step 2, OK | `{success:true, sap_user, method:"oauth"}` |
| OAuth state mismatch | `{success:false, error:"oauth_state_mismatch"}` |
| OAuth env incomplete | `{success:false, error:"oauth_config_incomplete: missing […]"}` |
| OAuth exchange failed | `{success:false, error:"oauth_exchange_failed: <detail>"}` |

The agent's system prompt instructs it to surface
`action_required: "sap_login"` envelopes verbatim and present the
`login_url` to the user.

### `sap_list_services`

```python
sap_list_services() -> dict
```

Synchronous read of `adk_agent/services.yaml`. Returns the service
catalog (see the `/api/sap/services` example above). Never errors — if the
YAML is empty, startup probes will have already failed.

### `sap_query`

```python
sap_query(
    service_id: str,
    entity_set: str,
    filter: str | None = None,
    select: str | None = None,
    top: int | None = None,
    skip: int | None = None,
) -> dict
```

Calls SAP OData via `sap_gw_connector.SAPClient`. Both v2 (`d.results`) and
v4 (`value`) response envelopes are normalised.

| Scenario | Returns |
|----------|---------|
| OK | `{success:true, results:[…], count}` |
| No `sap_credentials` in session | `{success:false, action_required:"sap_login", error:"not_authenticated"}` |
| `SAPAuthenticationError` (e.g. expired) | `{success:false, action_required:"re_authenticate", error:"<detail>"}` |
| `SAPRequestError` | `{success:false, error:{message:"<detail>"}}` |
| Other | `{success:false, error:"internal_error", detail:"<repr>"}` |

A fresh `SAPClient` is built per call inside an `async with` block — no
shared client state across turns.

### `sap_get_entity`

```python
sap_get_entity(service_id: str, entity_set: str, key: str) -> dict
```

Same auth gating and error envelopes as `sap_query`. Returns
`{success:true, entity:{…}}` on success.

### Pub/Sub MCP tools (optional)

When `.mcp.json` defines a valid `mcpServers.pubsub` entry, the
`McpToolset` exposes the tools from that allowlist. The default config
allows: `list_topics`, `get_topic`, `list_subscriptions`, `get_subscription`,
`publish` — and only against the `sapphire-demo` topic and
`sapphire-demo-sub` subscription. Args:

- `projectId` — bare project string, no `projects/` prefix
- `topicId` / `subscriptionId` — bare names; the gate strips
  `projects/X/topics/` and `topics/` prefixes before checking the allowlist
- `data` (publish) — base64-encoded message body

A denied call returns `{"isError": true, "content":[{"type":"text","text":"Access denied: …"}]}` and never reaches Pub/Sub.

---

## SSE event shapes

`/api/chat` streams `text/event-stream` chunks; each `data:` payload is JSON
emitted by `src/lib/adk-client.ts:normalizeAdkEvent` after parsing the raw
ADK frame.

```json
{ "type": "text_delta", "delta": "Hello" }
{ "type": "tool_call", "name": "sap_query", "args": { "service_id": "API_PRODUCT_SRV", "entity_set": "A_Product", "top": 5 } }
{ "type": "tool_result", "name": "sap_query", "result": { "success": true, "results": [...], "count": 5 } }
{ "type": "error", "error": "string" }
```

The `partial:false` aggregate text frame from the underlying ADK runtime is
**dropped** to avoid duplicating the assembled message.

A typical chat turn yields: many `text_delta`, optionally one or more
`tool_call`/`tool_result` pairs, and zero or one terminal `error`. The
front-end (`src/components/ChatWindow.tsx`) renders text deltas inline and
attaches tool results as collapsible details.

---

## Auth and error model

| Failure | HTTP status | JSON body |
|---------|-------------|-----------|
| Missing `sap_session` cookie | 401 | `{error:"NOT_AUTHENTICATED"}` |
| Conversation owned by different user | 403 | `{error:"FORBIDDEN"}` |
| Resource missing | 404 | `{error:"NOT_FOUND"}` |
| Pipeline already running | 409 | `{error:"PIPELINE_BUSY"}` |
| ADK returned non-2xx | 502 | `{error:"ADK_UPSTREAM", detail:"…"}` |
| ADK unreachable | 503 | `{error:"ADK_UNAVAILABLE"}` |
| `proxy.ts` blocked when `REQUIRE_AUTH=true` | 401 | empty body |

LLM-tool error envelopes (returned **inside** the SSE `tool_result` events,
HTTP status remains 200) follow the patterns documented per-tool above.
`action_required` is the canonical handshake the agent uses to ask the
user to log in or re-authenticate; the system prompt forwards it
verbatim, and the chat UI special-cases `"sap_login"` to render the inline
SAP login form.

---

## Related

- [ARCHITECTURE.md](./ARCHITECTURE.md) — runtime topology and sequence diagrams
- [DEPLOYMENT.md](./DEPLOYMENT.md) — env vars, schema, GCS, Cloud Run / Vertex Agent Engine
- [SAP_QUERY_EXAMPLES.md](./SAP_QUERY_EXAMPLES.md) — natural-language prompts → OData calls
