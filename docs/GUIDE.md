# sap-rag-integration — Developer Guide

> A walkthrough of the codebase as it actually exists today: a Google ADK
> Python `LlmAgent` (port 8200) that owns five tools — pgvector RAG plus
> four SAP OData tools — fronted by a Next.js 16 chat UI and ingestion
> pipeline (port 3000). The Next.js layer holds **no agent logic**; every
> chat turn is proxied to the ADK agent over SSE. The legacy
> `sap-service/` Python sidecar was removed in commit `822a49f`.

> If you are looking for installation steps, start with
> [`installation.md`](../installation.md). If you are looking for narrower
> topics, the per-locale doc set under [`docs/en/`](./en/) — `README`,
> `ARCHITECTURE`, `API`, `DEPLOYMENT`, `SAP_QUERY_EXAMPLES` — covers each
> in isolation. This guide ties them together for someone reading the
> codebase top-to-bottom for the first time.

## Table of contents

1. [Project overview](#1-project-overview)
2. [Tech stack](#2-tech-stack)
3. [Project structure](#3-project-structure)
4. [Environment setup](#4-environment-setup)
5. [The ADK agent](#5-the-adk-agent)
6. [The five LLM tools](#6-the-five-llm-tools)
7. [Optional Pub/Sub MCP toolset](#7-optional-pub-sub-mcp-toolset)
8. [Next.js API surface](#8-nextjs-api-surface)
9. [Frontend components](#9-frontend-components)
10. [Database schema](#10-database-schema)
11. [Ingestion pipeline](#11-ingestion-pipeline)
12. [Auth model](#12-auth-model)
13. [Observability](#13-observability)
14. [Testing](#14-testing)
15. [Operational pitfalls](#15-operational-pitfalls)

---

## 1. Project overview

The product is a chat assistant that:

1. Answers questions over a multimodal corpus (text, PDF, images, audio,
   video) embedded in pgvector.
2. Answers questions over **live SAP** OData services (Product Master,
   Material Stock, Plant Master, Material Documents) via four typed tools.
3. Mixes both within the same turn — e.g. "compare what our snapshot doc
   says about FERT products with what's in SAP today" — by allowing the
   agent to call multiple tools per turn.

The agent is a **single** ADK `LlmAgent` (no multi-agent orchestration,
no LangGraph). Tool selection, fallbacks, and response shaping all
happen via the system prompt. The Next.js layer:

- Hosts the chat and admin UIs.
- Proxies chat turns to the agent over SSE.
- Owns the ingestion pipeline (the agent is read-only against pgvector).
- Owns the iron-session login cookie that scopes conversations per SAP
  user.

This split keeps the Python ADK runtime focused on agent execution and
keeps the user-facing surface in the framework most familiar to web
developers.

## 2. Tech stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Web framework | Next.js 16 (App Router, Turbopack) | `runtime='nodejs'` everywhere; `maxDuration=300` on streaming/ingestion routes |
| UI | React 19 + Tailwind 4 + shadcn/ui | `react-markdown` + `remark-gfm` for chat; `lucide-react` icons |
| Agent runtime | `google-adk>=1.27` (Python 3.11+) | `LlmAgent` + `McpToolset`; `get_fast_api_app` builds the FastAPI surface |
| Agent transport | FastAPI (uvicorn) | SSE on `/run_sse`; `predev` health-probes `/healthz` |
| LLM | `gemini-3.1-pro-preview` | Override via `SAP_AGENT_MODEL` |
| Embedding | `gemini-embedding-2` | 3072-dim (`task_type=RETRIEVAL_QUERY` on the RAG path) |
| Vector store | PostgreSQL 17 + `pgvector` `halfvec(3072)` | HNSW index; cosine distance |
| ORM | Drizzle (Next side) + asyncpg (ADK side) | They do not share a connection pool |
| File storage | Google Cloud Storage | served via `/api/files/[...path]` with traversal guard |
| Auth | `iron-session` (`sap_session`, `sap_oauth_pending`) + Fernet for SAP creds | |
| Optional MCP | Google Cloud Pub/Sub HTTP MCP | Deny-by-default allowlists in `.mcp.json` |
| Logging | `pino` (Next) + `structlog` (ADK) | `LOG_LEVEL`, `LOG_PAYLOAD`, `LOG_FORMAT` shared |

## 3. Project structure

```
sap-rag-integration/
├── adk_agent/                    # Python: the LlmAgent + tools + MCP
│   ├── agent.py                  # root_agent wiring
│   ├── server.py                 # FastAPI bootstrap (build_app + main)
│   ├── settings.py               # frozen-dataclass env loader
│   ├── probes.py                 # 4 startup probes
│   ├── mcp_pubsub.py             # Pub/Sub MCP toolset + resource gate
│   ├── oauth.py                  # SAP OAuth2 PKCE helpers
│   ├── crypto.py                 # Fernet wrapper for password-at-rest
│   ├── sap_auth_config.py        # ADK AuthConfig builder (currently unused)
│   ├── services.yaml             # SAP catalog (4 services)
│   ├── rag/
│   │   ├── db.py                 # asyncpg pool + cosine search
│   │   └── embedding.py          # genai embed_content (RETRIEVAL_QUERY)
│   ├── tools/
│   │   ├── rag_tool.py           # search_documents
│   │   ├── auth_tool.py          # sap_authenticate
│   │   ├── service_tool.py       # sap_list_services
│   │   ├── query_tool.py         # sap_query
│   │   └── entity_tool.py        # sap_get_entity
│   ├── sap_gw_connector/         # vendored SAP Gateway client
│   ├── tests/                    # pytest unit tests
│   ├── Dockerfile                # python:3.12-slim + uv sync, EXPOSE 8200
│   └── .env.example
│
├── src/                          # TypeScript: Next.js app
│   ├── app/
│   │   ├── layout.tsx, page.tsx (redirect → /chat)
│   │   ├── chat/page.tsx
│   │   ├── admin/pipeline/page.tsx
│   │   └── api/
│   │       ├── chat/route.ts
│   │       ├── conversations/{[…],[id]/messages/}
│   │       ├── embed/route.ts
│   │       ├── pipeline/{start,status,upload}/route.ts
│   │       ├── files/[...path]/route.ts
│   │       └── sap/{auth,oauth/callback,services}/route.ts
│   ├── components/               # ChatWindow, ChatSidebar, ChatInput, SAPDataView, PipelineDashboard, ui/*
│   ├── lib/
│   │   ├── adk-client.ts         # SSE parser + runSse + createSession + authBasic
│   │   ├── session.ts            # iron-session sap_session cookie (8 h)
│   │   ├── oauth-pending.ts      # iron-session sap_oauth_pending cookie (10 m)
│   │   ├── db.ts + schema.ts     # Drizzle: embeddings, conversations, messages
│   │   ├── embedding-ingest.ts   # text/pdf/image/audio/video ingestion
│   │   ├── gemini.ts             # GoogleGenAI client wrappers
│   │   ├── gcs.ts                # uploadToGCS + downloadFromGCS (traversal guard)
│   │   ├── file-parser.ts        # category, MIME, EMBEDDING_LIMITS, chunkText
│   │   ├── env.ts                # required-vs-optional guard
│   │   ├── pipeline-state.ts     # in-memory ingestion progress singleton
│   │   ├── request-context.ts    # AsyncLocalStorage for {requestId, conversationId}
│   │   ├── concurrency.ts        # mapWithLimit (bounded parallel mapper)
│   │   ├── logger.ts             # pino with redaction
│   │   └── utils.ts
│   ├── proxy.ts                  # Next 16 proxy.ts — REQUIRE_AUTH gate
│   └── scripts/                  # setup-db, migrate-sap-user-id, pipeline (CLI)
│
├── scripts/                      # Repo-wide scripts
│   ├── check-parent-workspace.mjs (predev)
│   ├── check-adk-health.mjs       (predev)
│   ├── setup-gcp-service-account.sh
│   ├── test_pubsub_mcp_live.py
│   ├── fetch_sap_metadata.py
│   ├── list_sap_services.py
│   ├── benchmark-rag.ts
│   └── migration-parity-check.py + parity-targets.yaml  # obsolete; sap-service is gone
│
├── tests/e2e/                    # Playwright smoke tests
├── docs/                         # this directory
├── .mcp.json                     # project-scoped Pub/Sub MCP config
├── docker-compose.yml            # nextjs + adk (no sap-service)
├── next.config.ts                # CSP, turbopack.root, image remotePatterns
├── drizzle.config.ts, vitest.config.ts, playwright.config.ts, eslint.config.mjs
├── package.json + pnpm-lock.yaml + pnpm-workspace.yaml
├── pyproject.toml + uv.lock
├── README.md, README.ko.md, installation.md, CLAUDE.md
└── .env.local.example, adk_agent/.env.example
```

## 4. Environment setup

There are two env files — one per process. Templates ship in
`.env.local.example` and `adk_agent/.env.example`. The required and
optional keys are fully reference in
[DEPLOYMENT.md §1](./en/DEPLOYMENT.md#1-environment-variables); the short
version:

| File | Must set |
|------|----------|
| `.env.local` | `GEMINI_API_KEY`, `DATABASE_URL`, `GCS_BUCKET_NAME`, `GCS_PROJECT_ID`, `SAP_SESSION_SECRET` |
| `adk_agent/.env` | `DATABASE_URL`, `SAP_HOST`, `EMBED_MODEL`, `EMBED_OUTPUT_DIM`, `SAP_CRED_ENCRYPTION_KEY` |

`SAP_SESSION_SECRET` is a 32+ char iron-session signing key
(`openssl rand -base64 48`). `SAP_CRED_ENCRYPTION_KEY` is a Fernet key
(`python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`).

The Next.js process will refuse to boot via `pnpm dev` if the ADK agent
isn't responding on `${ADK_BASE_URL}/healthz` (predev guard at
`scripts/check-adk-health.mjs`). It will also refuse to boot if a
workspace marker file (`package.json`, `pnpm-workspace.yaml`,
`*-lock.*`) appears in the parent directory — that's the Turbopack CSS
resolver bug documented in CLAUDE.md.

Boot order:

```bash
# Terminal 1
uv run python -m adk_agent.server   # blocks on /healthz green

# Terminal 2
pnpm dev                            # predev probes ADK, then next dev
```

## 5. The ADK agent

### 5.1 `agent.py` — root agent

`adk_agent/agent.py` builds a single `Agent` (alias for `LlmAgent`)
with:

- `name="sapphire26_agent"`
- `model = os.getenv("SAP_AGENT_MODEL", "gemini-3.1-pro-preview")`
- A short system prompt that tells the LLM to:
  - Route document questions to `search_documents`.
  - Route SAP questions to `sap_query` / `sap_get_entity`.
  - Surface any `action_required` envelope verbatim — including the
    `login_url` when present — so the front-end can render a login
    affordance.
  - Render SAP results as markdown tables and cite RAG `source` fields.
- Tools registered in this order:
  1. `search_documents`
  2. `sap_authenticate`
  3. `sap_list_services`
  4. `sap_query`
  5. `sap_get_entity`
  6. *(optional)* `McpToolset(pubsub …)` if `setup_pubsub_mcp()` returns
     a bundle.
- `before_tool_callback = _pubsub.gate` only when Pub/Sub is wired.

The agent does **not** maintain its own conversation memory layer — that's
the ADK session backend's job. With `ADK_SESSION_BACKEND=memory` (the
default), state is per-replica; for multi-replica deployments switch to
`vertex` so the Vertex AI Agent Engine session store is used.

### 5.2 `server.py` — FastAPI bootstrap

`build_app(run_probes=True)`:

1. Loads settings (`adk_agent/settings.py`).
2. Runs all four startup probes (yaml, db, embed model, secret manager).
3. Calls `google.adk.cli.fast_api.get_fast_api_app(agents_dir, session_service_uri, allow_origins=["http://localhost:3000"], web=False)` — this gives you `/run`, `/run_sse`, and the standard ADK control surface.
4. Adds two custom routes:
   - `GET /healthz` — used by `pnpm predev`.
   - `POST /sap/auth/basic` — direct invocation of `sap_authenticate(method="basic", …)` so the Next.js login route can seed the iron-session cookie with Fernet-encrypted creds without going through the LLM.
5. `main()` runs probes synchronously, then `uvicorn.run(app, host=ADK_HOST, port=ADK_PORT)`.

### 5.3 `settings.py` — env loader

Frozen dataclass; raises `RuntimeError("missing env: …")` at startup
if any of `[DATABASE_URL, SAP_HOST, EMBED_MODEL, EMBED_OUTPUT_DIM,
SAP_CRED_ENCRYPTION_KEY]` is unset. Keeps misconfiguration out of the
LLM hot path.

### 5.4 `probes.py` — startup probes

Four probes (all run via `asyncio.run`):

1. `_probe_services_yaml` — load `services.yaml`, fail if empty.
2. `_probe_db` — connect with asyncpg, assert `embeddings` table exists.
3. `_probe_embed_model` — embed `"ping"` and assert dim = `EMBED_OUTPUT_DIM`.
4. `_probe_secret_manager` — runs only if `GOOGLE_CLOUD_PROJECT` is set.

A failed probe prevents the FastAPI app from starting, so
`/healthz` will never report green if any precondition is broken.

### 5.5 `crypto.py` — Fernet wrapper

Singleton initialised lazily from `SAP_CRED_ENCRYPTION_KEY`. Used by
`sap_authenticate` to encrypt the SAP basic-auth password before it
leaves the ADK process, and by `_client_for` (in `query_tool` /
`entity_tool`) to decrypt at the moment of an OData call. There is no
plain password persisted anywhere — even the iron-session cookie carries
the encrypted blob.

## 6. The five LLM tools

Each tool is an `async def` callable in `adk_agent/tools/*.py`. The
`tool_context` argument is provided by ADK at call time and exposes the
session state seeded by the chat route.

### 6.1 `search_documents`

```python
search_documents(query: str, top_k: int = 8) -> dict
```

Embeds the query with `EMBED_MODEL` (`task_type=RETRIEVAL_QUERY`) and
runs a pgvector cosine search:

```sql
SELECT id, file_name, chunk_text, 1 - (embedding <=> $1::vector) AS score
FROM embeddings
ORDER BY embedding <=> $1::vector
LIMIT $2
```

Returns `{results: [{id, file_name, chunk_text, score}], count}`. On
embed-model failure or DB unavailability, returns a soft envelope
`{results: [], count: 0, warning: "embedding_unavailable" | "vector_db_unavailable"}` —
the agent treats these as "no results found" rather than errors so the
chat keeps flowing.

### 6.2 `sap_authenticate`

The single SAP auth gate. Three call shapes:

| Shape | Meaning |
|-------|---------|
| `method="basic", username, password` | Probe SAP with the Basic header, return `{success, sap_user, credentials:{...encrypted}}` |
| `method="oauth", user_id` | Step 1: call `oauth.build_login_url`, return `{success:false, action_required:"sap_login", login_url, oauth_state}` |
| `method="oauth", code, state, user_id` | Step 2: call `oauth.exchange_code`, return `{success, access_token, refresh_token, sap_user, expires_at}` |

The system prompt forwards `action_required` envelopes verbatim, and
`ChatWindow.tsx` recognises `action_required: "sap_login"` to render the
inline login form (basic) or surface the OAuth `login_url` (oauth).

### 6.3 `sap_list_services`

Synchronous read of `adk_agent/services.yaml`. Never errors at runtime
(if the YAML were empty, the startup probe would already have failed).

The bundled catalog covers four services:

- `API_PRODUCT_SRV` — Product Master (the workhorse; ~32 entity sets)
- `API_MATERIAL_STOCK_SRV` — Material Stock
- `API_PLANT_SRV` — Plant Master
- `API_MATERIAL_DOCUMENT_SRV` — Material Documents

Each entity carries `name`, `key_field`, `description`, `navigations`,
and `default_select` so the agent has enough metadata to construct
non-trivial `sap_query` calls without trial-and-error.

### 6.4 `sap_query`

Calls SAP via a freshly built `SAPClient` per invocation (inside an
`async with` block). Both v2 (`d.results`) and v4 (`value`) response
envelopes are normalised by `_transform`.

```python
sap_query(
    service_id: str,
    entity_set: str,
    filter: str | None = None,    # OData $filter clause
    select: str | None = None,    # OData $select clause
    top: int | None = None,
    skip: int | None = None,
) -> dict
```

Auth gating: if `tool_context.state["sap_credentials"]` is missing, returns
`{success:false, action_required:"sap_login", error:"not_authenticated"}`
and never touches the network. On `SAPAuthenticationError` (e.g. expired
token mid-conversation), the envelope upgrades to
`action_required: "re_authenticate"` so the front-end can prompt the
user to re-login.

### 6.5 `sap_get_entity`

Same auth model as `sap_query`. Single-entity fetch by key:

```python
sap_get_entity(service_id: str, entity_set: str, key: str) -> dict
```

Returns `{success: true, entity: {…}}`.

## 7. Optional Pub/Sub MCP toolset

`.mcp.json` in the repo root defines a `mcpServers.pubsub` HTTP MCP
entry (`https://pubsub.googleapis.com/mcp`). When ADK boots,
`adk_agent/mcp_pubsub.py:setup_pubsub_mcp()`:

1. Parses `.mcp.json` and validates `type=="http"`, the URL, and the
   required `x-goog-user-project` header.
2. Acquires ADC for the `https://www.googleapis.com/auth/pubsub` scope.
3. Builds `McpToolset(StreamableHTTPConnectionParams, tool_filter=allowed_tools, header_provider=…)`. The header provider is invoked **per HTTP exchange**, so token refresh happens transparently — the toolset object never has to be rebuilt.
4. Builds the `instruction_block` (added to the agent prompt) listing
   allowed tools/topics/subscriptions and arg-shape hints (bare
   `projectId`, base64-encoded `data` for publish).
5. Builds the `gate` (`before_tool_callback`). The gate inspects tool
   args for any of `topicId / topic / topicName / topic_name` (and the
   subscription variants), strips `projects/X/topics/` and `topics/`
   prefixes via `_extract_bare_name`, and rejects unmatched values with
   `{"isError": true, "content":[{"type":"text","text":"Access denied: …"}]}`.

The default policy is **deny-by-default**:

| `.mcp.json` field | Effect when missing/empty |
|-------------------|---------------------------|
| `allowedTools` | 0 Pub/Sub tools exposed |
| `allowedTopics` | every `topicId` arg rejected |
| `allowedSubscriptions` | every `subscriptionId` arg rejected |

Caller principal must hold both `roles/mcp.toolUser` (gates the
`mcp.tools.call` permission) and `roles/pubsub.editor`. For local dev,
`gcloud auth application-default login` once is enough.

To verify the wiring end-to-end:

```bash
uv run python scripts/test_pubsub_mcp_live.py
```

## 8. Next.js API surface

Every route lives under `src/app/api/**/route.ts`. They use
`runtime='nodejs'` and most pin `maxDuration=300`. The `sap_session`
cookie is the canonical auth signal; `requireSession()` returns
`401 NOT_AUTHENTICATED` when missing.

| Path | Method(s) | Role |
|------|-----------|------|
| `/api/chat` | POST | SSE proxy to ADK `/run_sse`; persists user + assistant messages; auto-titles on first turn |
| `/api/conversations` | GET / POST / DELETE | CRUD scoped to `conversations.sap_user_id` |
| `/api/conversations/[id]/messages` | GET | Ordered messages for a conversation |
| `/api/embed` | POST | Multipart upload of one file (≤100 MB) → `embedFile` |
| `/api/pipeline/start` | POST | Background batch ingestion (local under `./data` / `./uploads`, or `gs://…`) |
| `/api/pipeline/upload` | POST | Multipart `files[]` ingestion |
| `/api/pipeline/status` | GET | Snapshot of the in-memory `pipeline-state` |
| `/api/files/[...path]` | GET | GCS file proxy with traversal guard |
| `/api/sap/auth` | GET / POST / DELETE | Login / probe / logout. POST `{method:"basic"}` proxies to ADK `/sap/auth/basic` and sets `sap_session` |
| `/api/sap/oauth/callback` | GET | OAuth `?code&state` landing — currently fails closed pending Step-2 wiring |
| `/api/sap/services` | GET | Forwards `sap_list_services` from ADK `/run` |

Detailed payloads, status codes, and SSE event shapes are in
[API.md](./en/API.md). The two non-obvious bits worth calling out:

- **Chat route** parses each SSE chunk through
  `src/lib/adk-client.ts:normalizeAdkEvent`, which flattens Gemini
  `parts[]` into `{type: text_delta | tool_call | tool_result | error}`
  and **drops** the `partial:false` aggregate text frame. Without that
  drop, the chat would render the assembled message twice.
- **OAuth callback** is a stub. The Step-2 token exchange lives in
  `adk_agent/oauth.exchange_code`, but the Next.js route does not yet
  call it; instead it renders a popup HTML that posts a failure message
  to the parent. This is tracked in
  [`docs/followups/post-migration.md`](./followups/post-migration.md).

## 9. Frontend components

```
src/components/
├── ChatSidebar.tsx        # conversation list, new/select/delete, session-user header, logout
├── ChatWindow.tsx         # markdown stream w/ remark-gfm, copy buttons, attachment grid, inline SAP login form
├── ChatInput.tsx          # textarea + paperclip file picker + send
├── PipelineDashboard.tsx  # source-path input + folder upload + status polling
├── SAPDataView.tsx        # generic record-array → table renderer (used inside chat)
└── ui/                    # shadcn primitives (button, card, dialog, input, …)
```

The chat shell at `src/app/chat/page.tsx` is a thin composition of
`ChatSidebar + ChatWindow + ChatInput`. There is no client-side state
manager — local state lives in component hooks and server state is
fetched via `fetch()` against the API routes.

## 10. Database schema

Three tables, defined in `src/lib/schema.ts` and created by
`pnpm db:setup`:

```text
embeddings
  id              uuid pk
  file_name       text
  file_type       text
  file_path       text
  chunk_index     int
  chunk_text      text
  content_summary text
  embedding       vector(3072)
  metadata        jsonb
  created_at      timestamptz default now()

  index (file_name)
  index hnsw (embedding halfvec_cosine_ops)

conversations
  id              uuid pk
  sap_user_id     varchar(255) not null
  title           text
  created_at, updated_at

  index (sap_user_id, updated_at desc)

messages
  id              uuid pk
  conversation_id uuid references conversations(id) on delete cascade
  role            text
  content         text
  file_name       text
  attachments     jsonb
  created_at      timestamptz default now()

  index (conversation_id, created_at)
```

`sap_user_id` is the SAP login name returned by `sap_authenticate`. Every
conversations CRUD endpoint filters by it — the iron-session cookie
binds the web user to a SAP user, and rows owned by other SAP users are
invisible.

For legacy DBs that pre-date the `sap_user_id` column,
`pnpm db:migrate:sap-user-id` adds it idempotently.

## 11. Ingestion pipeline

Entry: `src/lib/embedding-ingest.ts:embedFile(buffer, fileName)`.

1. `file-parser.getFileCategory(fileName)` → `text | pdf | image | audio | video`.
2. Upload the buffer to GCS at `uploads/{uuid}{ext}` via
   `src/lib/gcs.ts:uploadToGCS`.
3. Branch by category:
   - **text** — `chunkText(content, 2000, 200)` then embed each chunk
     in parallel (concurrency 3 via `mapWithLimit`).
   - **pdf** — `pdf-lib` splits into 6-page slices; each slice is sent
     as `application/pdf` inlineData for multimodal embedding, plus
     `pdf-parse` extracts the text and `gemini.ts:generateContentSummary`
     produces an AI summary.
   - **image / audio / video** — single multimodal embedding with the
     file as `inlineData` plus an AI summary.
4. INSERT into `embeddings` with the 3072-dim vector and the `metadata`
   jsonb (mime type, sizes, page index, etc.).

Both `/api/pipeline/start` (local dir or `gs://…` prefix) and
`/api/pipeline/upload` (browser upload of multiple files) wrap this
loop in a background task. Progress lives in the in-memory
`pipeline-state` singleton; the admin UI polls
`/api/pipeline/status`. There is **no persistence** — restarting the
Next.js process clears the in-flight state.

For one-off CLI use:

```bash
pnpm pipeline -- ./data
pnpm pipeline -- gs://my-bucket/documents
```

## 12. Auth model

### 12.1 Web session

`iron-session` cookie `sap_session`, signed with `SAP_SESSION_SECRET`.
TTL 8 hours. `httpOnly`, `sameSite=lax`, `secure` only in production.
Body: `{sapUserId, loggedInAt, sapCredentials?}`. Defined in
`src/lib/session.ts`.

A separate `sap_oauth_pending` cookie (10-minute TTL, same secret) holds
the in-flight OAuth state so `/api/sap/oauth/callback` can validate the
returned `state` parameter (`src/lib/oauth-pending.ts`).

### 12.2 SAP credentials

Basic auth: the password is Fernet-encrypted in the ADK process
(`crypto.encrypt`) before the `sap_authenticate` response leaves the
agent. The encrypted blob round-trips through Next.js into the
iron-session cookie, gets seeded back into ADK session state on the next
chat turn, and is decrypted only inside `_client_for` at the moment of an
OData call.

OAuth + PKCE: `oauth.build_login_url` and `oauth.exchange_code` use
PKCE; the chat-driven flow is documented in
[ARCHITECTURE.md §4.2](./en/ARCHITECTURE.md#42-oauth-20--pkce). Step-2
wiring from the Next.js callback into the agent is the open follow-up.

### 12.3 Proxy gate

`src/proxy.ts` (Next 16's renamed middleware) is a no-op unless
`REQUIRE_AUTH=true`. When enabled, it gates `/api/chat`, `/api/embed`,
`/api/conversations`, `/api/pipeline/*`, `/api/files/*`, and
`/api/sap/services` at the proxy layer in addition to the per-handler
`requireSession()` checks. `/api/sap/auth` is intentionally excluded so
users can log in.

### 12.4 Pub/Sub allowlist

The `before_tool_callback` gate (see §7) blocks the LLM from touching
topics or subscriptions outside the curated set, even if the upstream
MCP server exposes more.

## 13. Observability

Both processes log structured JSON. Honoured env vars:

- `LOG_LEVEL` — `debug | info | warn | error`
- `LOG_PAYLOAD` — `meta` (status + counts) or `full` (response body).
  Keep `meta` in production unless actively debugging — `full` writes
  unredacted SAP responses.
- `LOG_FORMAT` (Next only) — `pretty` adds a stdout pino-pretty target;
  file output is always JSON.
- `LOG_DIR` (Next only) — file output directory, default `./logs`.

`src/lib/logger.ts` defines a redaction list: `Authorization`,
`Set-Cookie`, `Cookie`, `access_token`, `refresh_token`, `password`.

`src/lib/request-context.ts` uses `AsyncLocalStorage` to attach
`{requestId, conversationId}` to every log line emitted during a single
chat turn — useful when grepping production logs for a user's
conversation.

The ADK agent uses `structlog`; logs go to stdout where Cloud Run /
Docker collect them.

## 14. Testing

| Surface | Tooling | Command |
|---------|---------|---------|
| Next.js unit | Vitest + v8 coverage | `pnpm test` / `pnpm test:run` / `pnpm test:coverage` |
| Next.js e2e | Playwright (single chromium project) | `pnpm e2e` (assumes Next + ADK already running) |
| ADK unit | pytest + pytest-asyncio + pytest-cov | `uv run pytest` |
| Pub/Sub MCP live | Python script | `uv run python scripts/test_pubsub_mcp_live.py` |

Coverage gates are tracked per-project. The ADK side ships with 80%+ unit
coverage as of the migration (`uv run python -m pytest adk_agent/tests/unit/test_mcp_pubsub_*` for the MCP-specific tests).

Vitest config (`vitest.config.ts`): `node` env, includes
`src/**/__tests__/**/*.test.ts`, setup
`./src/lib/__tests__/_support/setup.ts`, alias `@` → `./src`.

## 15. Operational pitfalls

These are the gotchas worth memorising before a long debugging session.

### 15.1 Parent-workspace Turbopack bug

If `pnpm dev` ever hangs on first request, fries the host's memory, or
spams `posix_spawn EAGAIN` errors:

- Cause: Turbopack's CSS `@import` resolver does **not** honour
  `turbopack.root` in `next.config.ts`. If a workspace marker file
  (`package.json`, `*-lock.*`, `pnpm-workspace.yaml`) appears in the
  parent directory, Turbopack treats that parent as the workspace root,
  fails to resolve `globals.css`'s `@import "tailwindcss"`, and dumps a
  ~30 KB resolve-trace error per CSS chunk per compile until the macOS
  fork pool is starved.
- Fix: remove the offending parent file, then `rm -rf .next` and restart.
- Defenses: `scripts/check-parent-workspace.mjs` runs as `predev` and
  fails fast; `dev` script sets `NODE_OPTIONS=--max-old-space-size=4096`
  so Node OOMs before the OS fork pool is starved.
- Upstream draft:
  [`docs/issues/2026-04-29-nextjs-turbopack-css-resolver-bug.md`](./issues/2026-04-29-nextjs-turbopack-css-resolver-bug.md).

### 15.2 ADK must be up before `pnpm dev`

`scripts/check-adk-health.mjs` runs as `predev` and exits 1 if
`${ADK_BASE_URL}/healthz` is not green. If you bypass `predev`, the
chat route will return 503 on every turn.

### 15.3 HMR singleton accumulation

`db.ts`, `logger.ts`, `gemini.ts`, and `gcs.ts` re-instantiate on
module re-evaluation in HMR mode. Long dev sessions accumulate Postgres
pools and write streams. Tracked in CLAUDE.md as a planned cleanup.

### 15.4 In-memory state

`pipeline-state.ts` and the default ADK session backend (`memory`) both
reset on process restart. For multi-replica production, switch ADK to
`ADK_SESSION_BACKEND=vertex` so the Vertex AI Agent Engine session store
is used.

### 15.5 Embedding model

Both the ingestion path (Next side) and the RAG-query path (ADK side)
use `gemini-embedding-2` targeting `vector(3072)`. If you change the
model, update both `GEMINI_EMBEDDING_MODEL` and `EMBED_MODEL`, and
verify `EMBED_OUTPUT_DIM` still matches the column type — `vector(N)`
columns can't be ALTERed in place.

### 15.6 Obsolete artifacts

- `sap-service/` — emptied by commit `822a49f`; only `__pycache__` and
  a stray `.env` remain. Safe to delete.
- `scripts/migration-parity-check.py` and `scripts/parity-targets.yaml`
  — compared the old `sap-service` `/query` to the new ADK `sap_query`;
  no longer useful now that the legacy service is gone.

---

## See also

- [`README.md`](../README.md) — top-level README (English)
- [`README.ko.md`](../README.ko.md) — top-level README (Korean)
- [`installation.md`](../installation.md) — agent-executable install steps
- [`docs/en/`](./en/) — per-locale doc set (English)
- [`docs/ko/`](./ko/) — per-locale doc set (Korean)
- [`docs/superpowers/specs/2026-04-29-adk-migration-design.md`](./superpowers/specs/2026-04-29-adk-migration-design.md) — original migration design doc
- [`docs/followups/post-migration.md`](./followups/post-migration.md) — open follow-up items (deploy target, Secret Manager, OAuth Step 2 wiring)
