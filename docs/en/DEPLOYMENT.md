# Deployment Guide

This guide covers env-var reference, database setup, Google Cloud
integration, and production considerations for both processes
(Next.js + ADK agent).

The legacy `sap-service/` FastAPI sidecar is removed — there is **no**
third process to deploy.

## 1. Environment variables

Two env files, one per process. Templates ship in
[`.env.local.example`](../../.env.local.example) and
[`adk_agent/.env.example`](../../adk_agent/.env.example).

### 1.1 Next.js (`.env.local`)

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `GEMINI_API_KEY` | yes | — | <https://aistudio.google.com/apikey> |
| `DATABASE_URL` | yes | — | `postgresql://user:pass@host:5432/db`. Same DB as the ADK agent. |
| `GCS_BUCKET_NAME` | yes | — | Must exist under `GCS_PROJECT_ID` |
| `GCS_PROJECT_ID` | yes | — | Owns the bucket and the service account |
| `SAP_SESSION_SECRET` | yes | — | iron-session signing key. ≥ 32 chars. `openssl rand -base64 48` |
| `ADK_BASE_URL` | yes | `http://localhost:8200` | Read directly via `process.env`; `pnpm predev` health-probes this URL |
| `GOOGLE_APPLICATION_CREDENTIALS` | no | — | Absolute path to a service account JSON. If unset, falls back to ADC. `pnpm gcp:setup` populates this. |
| `GEMINI_EMBEDDING_MODEL` | no | `gemini-embedding-2-preview` | 3072-dim embedding model used during ingestion |
| `GEMINI_CHAT_MODEL` | no | `gemini-3.1-pro-preview` | Used by `src/lib/gemini.ts` for content summaries; the chat model the agent uses is set in `adk_agent/.env` (`SAP_AGENT_MODEL`) |
| `LOG_LEVEL` | no | `info` | `debug | info | warn | error` |
| `LOG_PAYLOAD` | no | `meta` | `meta` (status + counts) or `full` (response body) |
| `LOG_FORMAT` | no | `pretty` | `pretty` adds a stdout pino-pretty target; file output is always JSON |
| `LOG_DIR` | no | `./logs` | Directory created at startup if missing |
| `REQUIRE_AUTH` | no | unset | When `true`, `src/proxy.ts` gates protected routes at the proxy layer in addition to per-handler `requireSession()` |

### 1.2 ADK agent (`adk_agent/.env`)

| Var | Required | Default | Notes |
|-----|----------|---------|-------|
| `DATABASE_URL` | yes | — | Same DB as Next.js |
| `SAP_HOST` | yes | — | SAP Gateway hostname (no scheme) |
| `EMBED_MODEL` | yes | `gemini-embedding-001` | Used for the RAG **query** path. Must produce vectors of dim `EMBED_OUTPUT_DIM` |
| `EMBED_OUTPUT_DIM` | yes | `3072` | Must match the column type `vector(3072)` |
| `SAP_CRED_ENCRYPTION_KEY` | yes | — | Fernet key. Generate with `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `GOOGLE_API_KEY` | conditional | — | Required unless ADC is available |
| `GOOGLE_CLOUD_PROJECT` | conditional | — | Required for the optional Secret Manager probe |
| `SAP_AGENT_MODEL` | no | `gemini-3.1-pro-preview` | LLM the agent uses |
| `SAP_AUTH_TYPE` | no | `basic` | `basic` or `sap_oauth` |
| `SAP_PORT` | no | `44300` | |
| `SAP_CLIENT` | no | `100` | |
| `SAP_VERIFY_SSL` | no | `false` | Should be `true` in production |
| `SAP_OAUTH_CLIENT_ID` | conditional | — | Required when `SAP_AUTH_TYPE=sap_oauth` |
| `SAP_OAUTH_CLIENT_SECRET` | conditional | — | Same |
| `SAP_OAUTH_TOKEN_URL` | conditional | — | Same |
| `SAP_OAUTH_AUTHORIZE_URL` | conditional | — | Same |
| `SAP_OAUTH_REDIRECT_URI` | conditional | — | Same. Typically `http://localhost:3000/api/sap/oauth/callback` for dev |
| `EMBED_NORMALIZE` | no | `true` | L2-normalise query embeddings |
| `RAG_TABLE` | no | `embeddings` | Override only if you partition the corpus |
| `ADK_HOST` | no | `0.0.0.0` | |
| `ADK_PORT` | no | `8200` | |
| `ADK_SESSION_BACKEND` | no | `memory` | `memory` or `vertex` (Vertex AI Agent Engine session store) |

`adk_agent/settings.py` raises `RuntimeError("missing env: …")` at startup
if any required var is unset, so misconfiguration fails fast instead of
producing cryptic LLM errors mid-turn.

### 1.3 Example `.env.local`

```env
GEMINI_API_KEY=AIza...
DATABASE_URL=postgresql://localhost:5432/gemini_rag
GCS_BUCKET_NAME=gemini-rag-uploads
GCS_PROJECT_ID=my-gcp-project
SAP_SESSION_SECRET=<openssl rand -base64 48>

GOOGLE_APPLICATION_CREDENTIALS=./service-account.json

ADK_BASE_URL=http://localhost:8200
LOG_LEVEL=info
LOG_FORMAT=pretty
```

### 1.4 Example `adk_agent/.env`

```env
GOOGLE_API_KEY=AIza...
SAP_AGENT_MODEL=gemini-3.1-pro-preview

EMBED_MODEL=gemini-embedding-001
EMBED_OUTPUT_DIM=3072
EMBED_NORMALIZE=true

DATABASE_URL=postgresql://localhost:5432/gemini_rag

SAP_AUTH_TYPE=basic
SAP_HOST=sap.example.com
SAP_PORT=44300
SAP_CLIENT=100
SAP_VERIFY_SSL=false

SAP_CRED_ENCRYPTION_KEY=<Fernet.generate_key()>

ADK_HOST=0.0.0.0
ADK_PORT=8200
ADK_SESSION_BACKEND=memory
```

## 2. Database setup

### 2.1 Prerequisites

- PostgreSQL 17+ (16 also works, but HNSW halfvec performance was tuned on 17)
- `pgvector` ≥ 0.7.0 (for `halfvec` and HNSW support)

### 2.2 Install pgvector

macOS (Homebrew):
```bash
brew install pgvector
```

Debian/Ubuntu:
```bash
sudo apt install postgresql-17-pgvector
```

From source:
```bash
git clone https://github.com/pgvector/pgvector.git
cd pgvector && make && sudo make install
```

### 2.3 Create database and apply schema

```bash
createdb gemini_rag
pnpm db:setup
```

`pnpm db:setup` (`src/scripts/setup-db.ts`):
1. `CREATE EXTENSION IF NOT EXISTS vector;`
2. Creates `embeddings`, `conversations`, `messages` (full schema in
   [ARCHITECTURE.md §6](./ARCHITECTURE.md#6-database-schema))
3. Creates an HNSW halfvec index on `embeddings.embedding`
4. Creates the per-user composite index on `conversations`

For a legacy DB that pre-dates per-user scoping, run
`pnpm db:migrate:sap-user-id` once — it ALTERs `conversations` to add
`sap_user_id` and the composite index, idempotently.

### 2.4 Connection pooling

Both processes hold their own pool:

- Next.js: a single `postgres()` client wrapped by Drizzle (`src/lib/db.ts`).
  No HMR singleton guard yet — long dev sessions accumulate pools (tracked
  in CLAUDE.md).
- ADK agent: `asyncpg.create_pool` (`adk_agent/rag/db.py`), one pool per
  worker process.

Use a connection pooler like PgBouncer in front of both processes when
deploying with multiple replicas.

## 3. Google Cloud Storage

### 3.1 Bucket layout

```
gs://<GCS_BUCKET_NAME>/
└── uploads/
    ├── 9f23...a1.pdf
    ├── 1c08...b3.png
    └── ...
```

Files are written under `uploads/{uuid}{ext}` by `src/lib/gcs.ts:uploadToGCS`
and served back through `/api/files/<path>`. The path-traversal guard
in `downloadFromGCS` enforces a hard `uploads/` prefix and rejects any
path containing `..`.

### 3.2 Service account

The simplest path is `pnpm gcp:setup` (`scripts/setup-gcp-service-account.sh`):

1. Creates a service account in `GCS_PROJECT_ID`
2. Grants `roles/storage.objectAdmin` on the bucket
3. Generates a JSON key and writes it to `./service-account.json`
4. Updates `.env.local` with `GOOGLE_APPLICATION_CREDENTIALS`,
   `GCS_PROJECT_ID`, `GCS_BUCKET_NAME`

For Cloud Run, prefer **workload identity** over JSON keys — attach a
service account to the revision and skip `GOOGLE_APPLICATION_CREDENTIALS`
entirely; the SDK will pick up Application Default Credentials.

### 3.3 Cache

`/api/files/[...path]` serves with `Cache-Control: public, max-age=86400`.
Files in `uploads/` are immutable (UUID names), so the long cache is safe.

## 4. Gemini API

### 4.1 Models

| Use | Default model | Where set |
|-----|--------------|-----------|
| Embedding (ingestion) | `gemini-embedding-2-preview` | `GEMINI_EMBEDDING_MODEL` (Next.js) |
| Embedding (RAG query in agent) | `gemini-embedding-001` | `EMBED_MODEL` (ADK) |
| Chat / agent | `gemini-3.1-pro-preview` | `SAP_AGENT_MODEL` (ADK) |
| Content summaries | `gemini-3.1-pro-preview` | `GEMINI_CHAT_MODEL` (Next.js) |

Both embedding models output 3072-dim vectors and target the same
`embeddings.embedding` column. If you switch to a different dimension,
update `EMBED_OUTPUT_DIM` and re-run `pnpm db:setup` against a fresh DB
(or migrate — `vector(N)` columns can't be altered in place).

### 4.2 Format restrictions (ingestion)

| Category | Limits |
|----------|--------|
| Text | 8,192 tokens; chunked to 2000 chars / 200 overlap |
| PDF | 6 pages per request (auto-split with `pdf-lib`) |
| Image | `image/png`, `image/jpeg`; ≤ 6 / request |
| Audio | `audio/mp3`, `audio/wav`; ≤ 80 s |
| Video | `video/mpeg`, `video/mp4`; ≤ 80 s with audio, ≤ 120 s without |

See [official Gemini Embedding 2 docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/embedding-2)
for upstream limits. Other extensions (`.gif`, `.webp`, `.flac`, `.mov`, …) can
be uploaded and served but are **not** sent to the embedding API — they
land in GCS only.

### 4.3 Task type

ADK queries set `task_type: "RETRIEVAL_QUERY"` (see
`adk_agent/rag/embedding.py`); ingestion uses `RETRIEVAL_DOCUMENT`. Mixing
the two halves the recall on this corpus.

## 5. Pub/Sub MCP (optional)

> **Full guide:** [MCP.md](./MCP.md) — what MCP is in this project, the
> deny-by-default semantics, per-deploy-mode delivery, and how to add a
> new MCP server.

Configured via `.mcp.json` in the repo root. The checked-in config targets
`https://pubsub.googleapis.com/mcp` with `x-goog-user-project:
sap-advanced-workshop-gck` and the `sapphire-demo` topic /
`sapphire-demo-sub` subscription on the allowlist.

Prereqs:

```bash
gcloud services enable pubsub.googleapis.com --project sap-advanced-workshop-gck
gcloud auth application-default login   # local dev
```

Caller principal must hold both:

- `roles/mcp.toolUser` (gates `mcp.tools.call`)
- `roles/pubsub.editor` (or finer-grained Pub/Sub roles)

For Cloud Run, attach both to the runtime service account. To verify the
end-to-end wiring:

```bash
uv run python scripts/test_pubsub_mcp_live.py
```

The script publishes a message via the MCP toolset; arrival is confirmed
out of band with `gcloud pubsub subscriptions pull`.

## 6. Production considerations

### 6.1 Concurrency and rate limits

| Surface | Default |
|---------|---------|
| Ingestion (`/api/pipeline/start`) | 3 concurrent files, 3 retries |
| Embed (`/api/embed`) | One request at a time per HTTP connection |
| Chat (`/api/chat`) | Bound by ADK session backend; with `memory`, scope is single replica |

Gemini API quotas vary by project tier; embedding requests are the most
frequent and should be the first to hit a quota wall. Watch for HTTP 429
and implement backoff at the edge of your batch jobs (the built-in
ingestion already retries 3×).

### 6.2 Logging in production

- Set `LOG_FORMAT=json` and `LOG_LEVEL=info`.
- Mount `LOG_DIR` to a persistent volume or stream to stdout (Cloud Run /
  GKE will collect to Cloud Logging automatically).
- Keep `LOG_PAYLOAD=meta` unless actively debugging — `full` writes
  unredacted SAP response bodies, which can include sensitive product /
  partner data.

Sensitive fields (`Authorization`, `Set-Cookie`, `Cookie`, `access_token`,
`refresh_token`, `password`) are redacted by `src/lib/logger.ts`.

### 6.3 Deployment targets

| Target | Status |
|--------|--------|
| Local Docker Compose | Supported. See [`docker-compose.yml`](../../docker-compose.yml) — two services (`nextjs` + `adk`) |
| Mode A — Cloud Run × 2 + Cloud SQL | **Scripted.** See [`deploy/README.md`](../../deploy/README.md). `./deploy/setup-cloud-sql.sh` then `./deploy/deploy-cloud-run.sh`. |
| Mode B — Vertex AI Agent Engine + Cloud SQL | **Scripted.** See [`deploy/README.md`](../../deploy/README.md). `MODE=agent-engine ./deploy/setup-cloud-sql.sh`, `./deploy/setup-agent-engine.sh`, `python deploy/deploy-agent-engine.py`. Then register the resource name in **Gemini Enterprise**. |

Both managed-target modes share one Cloud SQL instance. Mode A connects
via the unix socket mounted by `--add-cloudsql-instances`; Mode B
connects via TCP to the Private IP through PSA peering.

#### Mode A topology (Cloud Run × 2)

```
Cloud Run service: sap-rag-web      → Next.js (port 3000, public)
Cloud Run service: sap-rag-agent    → ADK    (port 8200, private)
Secret Manager:    SAP_CRED_ENCRYPTION_KEY, SAP_SESSION_SECRET, GEMINI_API_KEY
Cloud SQL:         PostgreSQL 17 + pgvector
GCS:               <GCS_BUCKET_NAME>
VPC Connector:     adk_agent → SAP S/4HANA private IP (auto-detected)
```

The web service mounts the agent service URL as `ADK_BASE_URL` and is
the only one that needs `--allow-unauthenticated`. The agent service is
private and reachable only by the web service's runtime SA via
`roles/run.invoker`.

#### Mode B topology (Agent Engine + Gemini Enterprise)

```
Gemini Enterprise UI ─→ Agent Engine: adk_agent.root_agent
                            │
                            │ PSC interface + network attachment
                            ▼
                       VPC ─┬─→ Cloud SQL Postgres (Private IP)
                            └─→ SAP S/4HANA (port 44300)

Cloud Run service: sap-oauth-callback     → Receives SAP redirect → writes
                                             code/state into Secret Manager
                                             (sap-oauth-pending-<state>)
Secret Manager:    sap-credentials, sap-cred-encryption-key
Service account:   agent-engine-sa
```

The Next.js side is **not deployed** in Mode B. The ingestion pipeline
runs once locally (or one-shot on Cloud Run) to seed the `embeddings`
table; the agent on Agent Engine only reads it for RAG.

### 6.4 docker-compose

```yaml
services:
  nextjs:
    build: .
    ports: ["3000:3000"]
    env_file: .env.local
    environment:
      ADK_BASE_URL: http://adk:8200
    depends_on: [adk]

  adk:
    build:
      context: .
      dockerfile: adk_agent/Dockerfile
    ports: ["8200:8200"]
    env_file: adk_agent/.env
    restart: unless-stopped
```

The current [`docker-compose.yml`](../../docker-compose.yml) matches this
shape exactly. There is no `sap-service` service.

### 6.5 Monitoring

Recommended signals to alert on:

- Next: `502 ADK_UPSTREAM` rate > 1% of `/api/chat` requests
- Next: `/api/pipeline/start` failure rate per file
- ADK: `/healthz` non-200
- ADK: log line `event=tool_error tool=sap_query` rate spikes
- DB: pgvector query p95 latency
- GCS: 4xx rate on the `/api/files` proxy

### 6.6 Security checklist

Before exposing the service:

- [ ] `SAP_SESSION_SECRET` and `SAP_CRED_ENCRYPTION_KEY` rotated and in Secret Manager
- [ ] `REQUIRE_AUTH=true` set on the Next service
- [ ] `SAP_VERIFY_SSL=true` on the ADK service
- [ ] Pub/Sub allowlist in `.mcp.json` matches the prod topic/subscription set (it is checked into git, so prod-specific values may need a deploy-time override)
- [ ] CORS list in `adk_agent/server.py` includes the prod web host
- [ ] CSP allowlist in `next.config.ts` includes the prod GCS bucket origin
- [ ] Cloud Run revision uses workload identity, not a JSON key
- [ ] DB user has the minimum required privileges (no superuser)

For full architecture context see [ARCHITECTURE.md](./ARCHITECTURE.md);
for endpoint payloads see [API.md](./API.md).
