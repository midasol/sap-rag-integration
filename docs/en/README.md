# sap-rag-integration

Production-style RAG + SAP agentic workflow. A single Google ADK `LlmAgent`
(Python, port 8200) owns five tools — vector search over a multimodal corpus
plus four SAP OData tools — and a Next.js 16 app provides the chat UI and the
ingestion pipeline. The Next.js layer holds **no agent logic**; every chat turn
is proxied to the ADK agent over SSE.

## Components

| Component | Stack | Port | Responsibility |
|-----------|-------|------|----------------|
| Next.js app | Next 16 + React 19 + Tailwind 4 | 3000 | Chat UI, admin pipeline UI, ADK proxy, GCS file proxy, iron-session auth |
| ADK agent | Python 3.11+ / google-adk + FastAPI | 8200 | LlmAgent + 5 tools (RAG + SAP) + optional Pub/Sub MCP toolset |
| PostgreSQL | 17+ with pgvector / halfvec(3072) | 5432 | RAG embeddings, conversations, messages |
| Google Cloud Storage | — | — | Uploaded source files (served back via `/api/files/...`) |
| Google Cloud Pub/Sub MCP (optional) | HTTP MCP at `pubsub.googleapis.com/mcp` | — | Topic/subscription/publish operations exposed to the LLM under an allowlist |

The legacy standalone `sap-service/` FastAPI sidecar was removed in commit
`822a49f`. SAP integration now happens in-process inside the ADK agent via the
vendored `adk_agent/sap_gw_connector` package.

## The five LLM tools

Defined under `adk_agent/tools/` and registered in
[`adk_agent/agent.py`](../../adk_agent/agent.py).

| Tool | Purpose | Auth gate |
|------|---------|-----------|
| `search_documents(query, top_k=8)` | pgvector cosine search over the `embeddings` table; returns `{id, file_name, chunk_text, score}` | none |
| `sap_authenticate(method, …)` | Gate. Basic returns success + `sap_user`. OAuth Step 1 returns `action_required: "sap_login"` + `login_url`; the LLM is instructed to surface this verbatim | n/a (this is the gate) |
| `sap_list_services()` | Reads `adk_agent/services.yaml` and returns service catalog (id, path, entities, key fields) | none |
| `sap_query(service_id, entity_set, filter?, select?, top?, skip?)` | Calls SAP OData v2/v4 via `sap_gw_connector.SAPClient`, normalises both `d.results` and `value` envelopes | requires `tool_context.state["sap_credentials"]` |
| `sap_get_entity(service_id, entity_set, key)` | Fetches a single entity by key | requires `sap_credentials` |

If `setup_pubsub_mcp()` finds a valid `.mcp.json` entry, an additional
`McpToolset` is appended to the tool list and a deny-by-default
`before_tool_callback` rejects any topic/subscription not on the allowlist.

## Quick start

Prerequisites: Node 20+, pnpm, Python 3.11+, `uv`, PostgreSQL 17+ with
pgvector, a Google Cloud project with a GCS bucket, and a Gemini API key.

For step-by-step instructions intended to be executed by an AI agent, see
[`installation.md`](../../installation.md). Short version:

```bash
# 1. Clone & install
git clone https://github.com/midasol/sap-rag-integration.git
cd sap-rag-integration
pnpm install
uv venv && uv sync

# 2. Configure both env files
cp .env.local.example .env.local         # Next.js
cp adk_agent/.env.example adk_agent/.env # ADK agent
#   Fill in: GEMINI_API_KEY, DATABASE_URL, GCS_BUCKET_NAME, GCS_PROJECT_ID,
#            SAP_SESSION_SECRET (openssl rand -base64 48),
#            SAP_HOST + SAP_AUTH_TYPE, SAP_CRED_ENCRYPTION_KEY (Fernet)

# 3. Database
createdb gemini_rag
pnpm db:setup    # pgvector extension + 3 tables + HNSW halfvec index

# 4. Run both processes
uv run python -m adk_agent.server    # terminal 1 — port 8200
pnpm dev                              # terminal 2 — port 3000 (predev pings ADK /healthz)
```

Open <http://localhost:3000> and you'll be redirected to `/chat`. The chat
sidebar shows an inline SAP login form when no `sap_session` cookie exists.

## Project layout

```
adk_agent/
├── agent.py                 # root_agent: LlmAgent wiring 5 tools (+ optional Pub/Sub MCP)
├── server.py                # FastAPI app via google.adk.cli.fast_api.get_fast_api_app
├── settings.py              # frozen-dataclass env loader
├── probes.py                # startup probes (yaml, db, embed model, secret manager)
├── mcp_pubsub.py            # Pub/Sub MCP toolset + deny-by-default resource gate
├── oauth.py                 # SAP OAuth2 PKCE helpers
├── crypto.py                # Fernet wrapper for password-at-rest
├── services.yaml            # SAP OData service catalog (4 services bundled)
├── rag/
│   ├── db.py                # asyncpg pool + pgvector cosine search
│   └── embedding.py         # genai.Client embed_content(model=EMBED_MODEL)
├── tools/
│   ├── rag_tool.py          # search_documents
│   ├── auth_tool.py         # sap_authenticate (basic + oauth Step1/Step2)
│   ├── service_tool.py      # sap_list_services
│   ├── query_tool.py        # sap_query
│   └── entity_tool.py       # sap_get_entity
└── sap_gw_connector/        # vendored SAP Gateway client (auth, sap_client, transports)

src/
├── app/
│   ├── chat/page.tsx
│   ├── admin/pipeline/page.tsx
│   └── api/
│       ├── chat/route.ts                # SSE proxy to ADK /run_sse
│       ├── conversations/                # CRUD scoped to sap_user_id
│       ├── embed/                        # single-file embedding (multipart)
│       ├── pipeline/{start,status,upload}/
│       ├── files/[...path]/              # GCS file proxy with traversal guard
│       └── sap/
│           ├── auth/                     # POST {method:"basic"} → ADK /sap/auth/basic, sets cookie
│           ├── oauth/callback/           # OAuth round-trip (currently a stub)
│           └── services/                 # GET → ADK function_call: sap_list_services
├── lib/
│   ├── adk-client.ts        # SSE parser + runSse + createSession + authBasic
│   ├── session.ts           # iron-session, sap_session cookie, 8h TTL
│   ├── oauth-pending.ts     # sap_oauth_pending cookie, 10m TTL
│   ├── db.ts + schema.ts    # Drizzle: embeddings, conversations, messages
│   ├── embedding-ingest.ts  # text/pdf/image/audio/video ingestion
│   ├── gemini.ts, gcs.ts, file-parser.ts, env.ts, …
│   └── pipeline-state.ts    # in-memory ingestion progress
├── components/              # ChatWindow / ChatSidebar / ChatInput / SAPDataView / PipelineDashboard / ui/*
├── proxy.ts                 # Next 16 proxy.ts — gates protected routes when REQUIRE_AUTH=true
└── scripts/                 # setup-db.ts, migrate-sap-user-id.ts, pipeline.ts (CLI)

.mcp.json                    # project-scoped MCP config: Pub/Sub HTTP MCP + allowlists
docker-compose.yml           # nextjs + adk services (no sap-service)
```

## API surface (Next.js)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/chat` | SSE proxy to ADK `/run_sse`. Persists messages, auto-titles. Requires `sap_session`. |
| `GET / POST / DELETE` | `/api/conversations` | CRUD scoped to `sap_user_id` |
| `GET` | `/api/conversations/[id]/messages` | Ordered messages for a conversation |
| `POST` | `/api/embed` | Multipart upload + `embedFile` (≤100 MB) |
| `POST` | `/api/pipeline/start` | Background ingestion of a local dir or `gs://…` prefix |
| `GET` | `/api/pipeline/status` | Snapshot of in-memory pipeline state |
| `POST` | `/api/pipeline/upload` | Multipart `files[]` ingestion |
| `GET` | `/api/files/[...path]` | GCS file proxy (path-traversal-guarded) |
| `GET / POST / DELETE` | `/api/sap/auth` | GET = session probe; POST `{method:"basic"}` → ADK `/sap/auth/basic`, sets `sap_session`; DELETE clears |
| `GET` | `/api/sap/oauth/callback` | OAuth code/state landing — currently fails closed pending Step-2 wiring |
| `GET` | `/api/sap/services` | Forwards `sap_list_services` from ADK |

The ADK agent itself exposes `/run_sse` (provided by `get_fast_api_app`),
`/healthz`, and `/sap/auth/basic` (proxied by Next.js).

See [API.md](./API.md) for full payloads and SSE event shapes.

## Configuration overview

Two env files, one per process:

- **Next.js** — `.env.local` (template: `.env.local.example`)
  - Required: `GEMINI_API_KEY`, `DATABASE_URL`, `GCS_BUCKET_NAME`, `GCS_PROJECT_ID`, `SAP_SESSION_SECRET`
  - ADK link: `ADK_BASE_URL` (default `http://localhost:8200`)
  - Optional: `GOOGLE_APPLICATION_CREDENTIALS`, `GEMINI_*_MODEL`, `LOG_*`, `REQUIRE_AUTH`
- **ADK agent** — `adk_agent/.env` (template: `adk_agent/.env.example`)
  - Required: `DATABASE_URL`, `SAP_HOST`, `EMBED_MODEL`, `EMBED_OUTPUT_DIM`, `SAP_CRED_ENCRYPTION_KEY` (Fernet)
  - SAP: `SAP_AUTH_TYPE` (default `basic`), `SAP_PORT`, `SAP_CLIENT`, `SAP_VERIFY_SSL`, plus 5 `SAP_OAUTH_*` vars when `SAP_AUTH_TYPE=sap_oauth`
  - Server: `ADK_HOST=0.0.0.0`, `ADK_PORT=8200`, `ADK_SESSION_BACKEND=memory|vertex`
  - Model: `SAP_AGENT_MODEL` (default `gemini-3.1-pro-preview`)

See [DEPLOYMENT.md](./DEPLOYMENT.md) for a complete reference and production
guidance.

## Pub/Sub MCP (optional)

If `.mcp.json` defines a `mcpServers.pubsub` HTTP MCP entry, the ADK agent
attaches it to the LlmAgent at startup (`adk_agent/mcp_pubsub.py`). The
checked-in config targets `https://pubsub.googleapis.com/mcp` with
`x-goog-user-project: sap-advanced-workshop-gck` and **deny-by-default**
allowlists for tools, topics, and subscriptions.

Caller must have both `roles/mcp.toolUser` and `roles/pubsub.editor` (or
finer-grained Pub/Sub roles), and ADC must be available
(`gcloud auth application-default login`). See the "MCP servers" section in
the project root [`CLAUDE.md`](../../CLAUDE.md) and
[ARCHITECTURE.md](./ARCHITECTURE.md#pub-sub-mcp-toolset) for details.

## Development scripts

| Command | What it does |
|---------|--------------|
| `pnpm dev` | `predev` (parent-workspace guard + ADK `/healthz` probe) → `next dev` with `--max-old-space-size=4096` |
| `pnpm build` / `pnpm start` | Production Next build + serve |
| `pnpm db:setup` | Create pgvector extension + tables + HNSW halfvec index |
| `pnpm db:migrate:sap-user-id` | Idempotent ALTER for legacy DBs |
| `pnpm pipeline -- ./data` | CLI batch ingestion (local dir or `gs://…`) |
| `pnpm gcp:setup` | Create GCP service account + GCS bucket + key, write to `.env.local` |
| `pnpm test` / `pnpm test:run` / `pnpm test:coverage` | Vitest |
| `pnpm e2e` | Playwright (assumes Next + ADK already running) |
| `uv run python -m adk_agent.server` | Run the ADK agent (port 8200) |
| `uv run pytest` | ADK agent unit tests |

## Related docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) — runtime topology, data flow diagrams, sequence diagrams
- [API.md](./API.md) — full Next.js + ADK endpoint reference, SSE event shapes
- [DEPLOYMENT.md](./DEPLOYMENT.md) — env vars, database schema, GCS setup, Cloud Run / Vertex Agent Engine, Docker Compose
- [SAP_QUERY_EXAMPLES.md](./SAP_QUERY_EXAMPLES.md) — natural-language prompts mapped to OData calls across all 4 bundled services
- Project root [`CLAUDE.md`](../../CLAUDE.md) — known dev traps (parent-workspace Turbopack bug), MCP wiring notes
- Korean translations under [`docs/ko/`](../ko/)
