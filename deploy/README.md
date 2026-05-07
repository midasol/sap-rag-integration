# Deployment

This project ships two deployment topologies, both backed by **one shared
Cloud SQL Postgres + pgvector** instance:

- **Mode A — Cloud Run × 2.** `nextjs` (web + ingestion + chat proxy) and
  `adk_agent` (LLM + SAP tools) deploy as two Cloud Run services. The
  Next.js side mediates SAP authentication and serves the chat UI.
- **Mode B — Vertex AI Agent Engine standalone.** Only the ADK agent
  ships, deployed via `vertexai.agent_engines.create()`, then registered
  in **Gemini Enterprise** so end users can talk to it directly from the
  Gemini chat surface. The Next.js ingestion pipeline does **not** run on
  Agent Engine — run it once locally (or one-shot on Cloud Run) to seed
  the embeddings table; the agent on Agent Engine only **reads** that
  table for RAG.

Both modes target Postgres 17 + pgvector ≥ 0.7 (HNSW on `halfvec(3072)`).

## Decision matrix

|                                           | Mode A (Cloud Run × 2)   | Mode B (Agent Engine)  |
| ----------------------------------------- | ------------------------ | ---------------------- |
| End-user surface                          | Custom Next.js chat UI   | Gemini Enterprise UI   |
| SAP authentication                        | Basic **or** OAuth       | OAuth only             |
| Ingestion pipeline                        | Inside the web service   | Run separately         |
| SAP S/4HANA reachability                  | Serverless VPC connector | PSC interface          |
| Cloud SQL connection                      | Unix socket              | TCP to Private IP      |
| Pub/Sub MCP                               | Yes (via `.mcp.json`)    | Yes (via `.mcp.json`)  |
| `/sap/auth/basic` shortcut                | Available                | Not available          |
| Setup complexity                          | Lower                    | Higher (PSC + secrets) |

You can run **both** modes against the same Cloud SQL instance. The Cloud
Run web service is the embedding pipeline driver in either case.

## Prerequisites

- `gcloud` CLI authenticated (`gcloud auth login`) and a GCP project with
  billing enabled.
- `psql` installed locally — the setup script applies the schema through
  the Cloud SQL Auth Proxy.
- Python 3.11+ and `uv` for Mode B (the deploy script imports
  `vertexai.agent_engines`).
- `pnpm` is **not** required locally — Cloud Build runs the install/build
  inside Buildpacks.

## Mode A — Cloud Run × 2

```bash
# 1. Provision Cloud SQL (idempotent).
./deploy/setup-cloud-sql.sh <PROJECT_ID>

# 2. Fill in deploy/.env.deploy (auto-created from the example template).
$EDITOR deploy/.env.deploy

# 3. Deploy both services.
./deploy/deploy-cloud-run.sh <PROJECT_ID>
```

What `deploy-cloud-run.sh` does:

1. Enables `run`, `cloudbuild`, `artifactregistry`, `sqladmin`,
   `vpcaccess`, `secretmanager` APIs.
2. Creates the runtime service account `sap-rag-runner` with
   `roles/cloudsql.client`, `roles/storage.objectAdmin`,
   `roles/aiplatform.user`, plus `roles/mcp.toolUser` +
   `roles/pubsub.editor` if `.mcp.json` is checked in.
3. (Optional) Auto-detects the VPC for `SAP_HOST` if it is an RFC-1918
   IP, then creates a Serverless VPC Access connector + firewall rule.
4. `gcloud run deploy --source . --dockerfile=adk_agent/Dockerfile` for
   the agent (port 8200, private — IAM `run.invoker` only).
5. `gcloud run deploy --source .` for the Next.js web service (port
   3000, public). Buildpacks pick pnpm via `package.json`'s
   `packageManager` field.
6. Wires `ADK_BASE_URL=$AGENT_URL` on the web service so it proxies chat
   to the private agent.
7. Both services mount Cloud SQL via `--add-cloudsql-instances`; the
   `DATABASE_URL` uses the unix-socket form
   `postgresql://USER:PASS@/DB?host=/cloudsql/PROJECT:REGION:INSTANCE`.

Output: prints both URLs at the end. The web URL is what users hit; the
agent URL is private and called only by the web service.

### Mode A known limitation

The OAuth callback (`src/app/api/sap/oauth/callback/route.ts:63`) is
**currently stubbed** — it expects a dedicated `/sap/auth/oauth/exchange`
ADK endpoint that doesn't exist yet. SAP **basic auth** works end-to-end
on Mode A; SAP **OAuth** does not (tracked separately). If you need
OAuth in Mode A, deploy the Mode B `cloud-run-oauth-callback/` service
on the side and point `SAP_OAUTH_REDIRECT_URI` at it.

## Mode B — Vertex AI Agent Engine standalone

```bash
# 1. Provision Cloud SQL with Private IP (PSA peering).
MODE=agent-engine VPC_NETWORK=<your-vpc> \
  ./deploy/setup-cloud-sql.sh <PROJECT_ID>

# 2. Fill in deploy/.env.agent-engine (auto-created from example).
#    CLOUD_SQL_PASSWORD and CLOUD_SQL_PRIVATE_IP are pre-filled.
$EDITOR deploy/.env.agent-engine

# 3. Provision Agent Engine prerequisites:
#    service account, PSC subnet, network attachment, firewall, secrets.
./deploy/setup-agent-engine.sh <PROJECT_ID>

# 4. Populate the SAP credentials and Fernet key in Secret Manager
#    (the setup script prints the exact gcloud commands).
echo '{"auth_type":"sap_oauth","host":"...", "oauth_client_id":"...", ...}' \
  | gcloud secrets versions add sap-credentials --data-file=-

python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())" \
  | gcloud secrets versions add sap-cred-encryption-key --data-file=-

# 5. Deploy the SAP OAuth callback Cloud Run service.
gcloud run deploy sap-oauth-callback \
  --source ./cloud-run-oauth-callback \
  --region us-central1 \
  --set-env-vars=GOOGLE_CLOUD_PROJECT=<PROJECT_ID> \
  --allow-unauthenticated

# 6. Update SAP_OAUTH_REDIRECT_URI in deploy/.env.agent-engine to the
#    callback service URL printed by step 5 (append /callback).

# 7. Deploy the agent.
uv run python deploy/deploy-agent-engine.py --project <PROJECT_ID>
# Prints: Resource Name: projects/<N>/locations/us-central1/reasoningEngines/<ID>

# 8. Register the resource name in Gemini Enterprise:
#    https://gemini.google.com/enterprise → Agents → Register agent
```

What the Mode B scripts do:

- `setup-cloud-sql.sh MODE=agent-engine` reserves a PSA peering range
  (`/16` global address) and peers `servicenetworking.googleapis.com`
  with `VPC_NETWORK`. The Cloud SQL instance is created with both
  Private IP (used at runtime by the agent) and Public IP (used once
  for the schema bootstrap from your workstation via cloud-sql-proxy).
- `setup-agent-engine.sh` provisions the runtime service account
  (`agent-engine-sa`), grants the AI Platform service agents
  `compute.networkAdmin` + `dns.peer`, creates a `/28` PSC subnet and
  network attachment, opens a firewall rule from the PSC subnet to
  `SAP_HOST` on `tcp:44300,443`, creates the Cloud Build staging bucket,
  and ensures the `sap-credentials` and `sap-cred-encryption-key`
  Secret Manager secrets exist.
- `deploy-agent-engine.py` imports `adk_agent.agent.root_agent`, wraps
  it in `vertexai.agent_engines.AdkApp(...)`, and calls
  `agent_engines.create()` with `extra_packages=["./adk_agent",
  "./.mcp.json"]`, `psc_interface_config={"network_attachment": ...}`,
  and an `env_vars` payload that includes the runtime
  `DATABASE_URL=postgresql://app:<pw>@<PRIVATE_IP>:5432/sap_rag`,
  the SAP env, the Fernet key fetched from Secret Manager, and
  `MCP_CONFIG_PATH=/app/.mcp.json` so the bundled `.mcp.json` is found
  at runtime. Use `--update <RESOURCE_NAME>` for re-deploys.

### Mode B OAuth flow

```
End user (Gemini Enterprise UI)
  └─ "list SAP services"
     └─ Agent Engine → adk_agent
        └─ sap_authenticate(method="oauth")  # Step 1
           └─ returns {action_required: "sap_login", login_url, state}
End user clicks login_url
  └─ SAP login → SAP redirects to sap-oauth-callback /callback?code=...&state=...
     └─ Cloud Run service writes payload to Secret Manager:
        sap-oauth-pending-<state-prefix>
End user returns to Gemini Enterprise → next message
  └─ Agent Engine → adk_agent
     └─ sap_authenticate(method="oauth", code=..., state=...)  # Step 2
        └─ exchange_code(...) → SAP token → store in tool_context.state
```

The agent currently expects `code`/`state` to be passed back through the
chat envelope (see `adk_agent/tools/auth_tool.py:84-103`). Wiring the
agent to **poll** `sap-oauth-pending-<prefix>` Secret Manager keys
between turns is **out of scope** for this deploy work — the
infrastructure is in place; the polling helper inside the agent is a
follow-up. Until then, after SAP login the user must paste the `code`
and `state` from the callback page back into the chat.

The reference implementation of this poller is in
[`/Users/judelee/myproject/sap-gemini-enterprise/sap_agent/agent.py`](https://) —
search for `_check_pending_oauth_code` (~line 70).

## Re-running

All scripts are idempotent.

- `setup-cloud-sql.sh` skips create when the instance/db/user exist;
  always re-applies `schema.sql` (every statement is `IF NOT EXISTS` /
  `CREATE OR REPLACE`); always pushes `CLOUD_SQL_PASSWORD` to Cloud SQL
  and writes it back to the relevant `.env*` files so the two cannot
  drift.
- `deploy-cloud-run.sh` ships a new revision of each Cloud Run service.
- `deploy-agent-engine.py --update <RESOURCE_NAME>` updates an existing
  Agent Engine in place; without `--update` it creates a new one.

## File layout

```
deploy/
├── README.md                      # this file
├── schema.sql                     # ports src/scripts/setup-db.ts
├── .env.deploy.example            # Mode A template
├── .env.agent-engine.example      # Mode B template
├── setup-cloud-sql.sh             # Mode A + Mode B (MODE=...)
├── deploy-cloud-run.sh            # Mode A
├── setup-agent-engine.sh          # Mode B prereqs
└── deploy-agent-engine.py         # Mode B deploy

cloud-run-oauth-callback/          # Mode B SAP OAuth redirect handler
├── Dockerfile
├── main.py
└── requirements.txt
```

## Architecture notes

- **DB hop (Mode A)**: app → Cloud SQL is via the proxy unix socket on
  the same Cloud Run instance. No VPC needed for the database.
- **DB hop (Mode B)**: agent → Cloud SQL is via TCP to the Private IP,
  routed through PSA peering established by `setup-cloud-sql.sh
  MODE=agent-engine`. The PSC interface configured on Agent Engine
  attaches into the same VPC.
- **SAP hop**: only the agent (Mode A) or Agent Engine (Mode B) needs
  VPC reachability to SAP. Mode A's web service does not.
- **GCS access**: the runtime service account holds
  `storage.objectAdmin`, so the app uses ADC from the metadata server.
  `GOOGLE_APPLICATION_CREDENTIALS` and the JSON key are not needed in
  production.
- **Pub/Sub MCP**: enabled when `.mcp.json` exists at the repo root. In
  Mode A it is COPYed into the agent container by `adk_agent/Dockerfile`
  and resolved via `Path(__file__).parent.parent / ".mcp.json"`. In
  Mode B it is bundled by `extra_packages=["./.mcp.json"]` and resolved
  via `MCP_CONFIG_PATH=/app/.mcp.json`. See
  `adk_agent/mcp_pubsub.py:_default_mcp_config_path`. **Full guide:**
  [`docs/en/MCP.md`](../docs/en/MCP.md) ([한국어](../docs/ko/MCP.md))
  — covers deny-by-default semantics, IAM, per-mode delivery, and how
  to add a new MCP server.
