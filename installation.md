# Installation Guide

> **This document is for AI agents.** It contains step-by-step instructions that AI tools (Gemini CLI, Antigravity, Cursor, Codex, Claude Code) execute automatically to install and configure this project.

## Execution Rules

1. Execute sections **top-to-bottom, in order**. Do not skip ahead.
2. Each Phase ends with a **VERIFY** block. Run every VERIFY command. Do not proceed to the next Phase until all VERIFY checks pass.
3. If a VERIFY check fails, consult the **TROUBLESHOOT** block in the same Phase. Apply the fix and re-run VERIFY.
4. When you encounter **ASK_USER**, prompt the user with the exact question shown and wait for their response before continuing.
5. Detect the operating system once at the start:
   ```bash
   uname -s
   ```
   - `Darwin` → macOS. Use `brew` for package installation.
   - `Linux` → Linux. Use `apt-get` for package installation.
   - For Windows, instruct the user: "This project requires WSL (Windows Subsystem for Linux). Please install WSL first, then re-run this guide inside WSL."

---

## Phase 1: Prerequisites

DESCRIPTION: Verify that all required system tools are installed. If any tool is missing, present the install command and ask the user for confirmation before installing.

### Steps

#### 1.1 Node.js (>= 24.14.0)

```bash
node -v
```

If the command fails or the version is below 24.14.0:

ASK_USER: "Node.js >= 24.14.0 is required but not found. Install it now?"

If yes:
- macOS: `brew install node` or `nvm install 24 && nvm use 24`
- Linux: `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs`

#### 1.2 pnpm

```bash
pnpm -v
```

If the command fails, install without asking:

```bash
npm install -g pnpm
```

#### 1.3 Python (>= 3.11)

```bash
python3 --version
```

If the command fails or the version is below 3.11:

ASK_USER: "Python >= 3.11 is required but not found. Install it now?"

If yes:
- macOS: `brew install python@3.11`
- Linux: `sudo apt-get install -y python3.11 python3.11-venv`

#### 1.4 PostgreSQL (>= 17) + pgvector

```bash
psql --version
```

If the command fails or the version is below 17:

ASK_USER: "PostgreSQL >= 17 with pgvector is required but not found. Install it now?"

If yes:
- macOS: `brew install postgresql@17 pgvector && brew services start postgresql@17`
- Linux: `sudo apt-get install -y postgresql-17 postgresql-17-pgvector && sudo systemctl start postgresql`

### VERIFY

Run all four checks. Every check must pass.

```bash
node -v          # Must print v24.14.0 or higher
pnpm -v          # Must print a version number
python3 --version  # Must print Python 3.11 or higher
psql --version   # Must print psql 17 or higher
```

### TROUBLESHOOT

| Symptom | Fix |
|---------|-----|
| `node: command not found` | Re-run the Node.js install command from Step 1.1 |
| `pnpm: command not found` | Run `npm install -g pnpm` |
| `python3: command not found` | Re-run the Python install command from Step 1.3 |
| `psql: command not found` | Re-run the PostgreSQL install command from Step 1.4 |
| PostgreSQL installed but service not running | macOS: `brew services start postgresql@17` / Linux: `sudo systemctl start postgresql` |

---

## Phase 2: Clone & Install

DESCRIPTION: Clone the repository and install Node.js dependencies.

### Steps

```bash
git clone https://github.com/midasol/sap-rag-integration.git
cd sap-rag-integration
pnpm install
```

### VERIFY

```bash
test -f package.json && echo "OK: package.json exists" || echo "FAIL: package.json not found"
test -f node_modules/.modules.yaml && echo "OK: node_modules installed" || echo "FAIL: node_modules not found"
```

Both checks must print `OK`.

### TROUBLESHOOT

| Symptom | Fix |
|---------|-----|
| `git clone` fails with permission error | Verify GitHub access: `ssh -T git@github.com` or use HTTPS URL |
| `pnpm install` fails | Delete `node_modules` and retry: `rm -rf node_modules && pnpm install` |
| `pnpm: command not found` | Go back to Phase 1, Step 1.2 |

---

## ADK Backend Setup

The ADK Python agent runs on port 8200 and serves all SAP + RAG tools.

1. Install Python deps: `uv venv && uv sync`
2. Copy `adk_agent/.env.example` → `adk_agent/.env` and fill in values.
   - Required: `DATABASE_URL`, `SAP_HOST`, `SAP_AUTH_TYPE`, `EMBED_MODEL`, `EMBED_OUTPUT_DIM`, `SAP_CRED_ENCRYPTION_KEY`.
   - Generate the Fernet key: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"`
   - For OAuth: also set `SAP_OAUTH_CLIENT_ID`, `SAP_OAUTH_CLIENT_SECRET`, `SAP_OAUTH_AUTHORIZE_URL`, `SAP_OAUTH_TOKEN_URL`, `SAP_OAUTH_REDIRECT_URI`.
3. Run: `uv run python -m adk_agent.server`
4. Healthcheck: `curl http://localhost:8200/healthz` → `{"status":"ok"}`

> **Start the ADK agent before running `pnpm dev`.** The `predev` script runs
> `scripts/check-adk-health.mjs` and refuses to start Next.js if ADK is not
> reachable. If you see:
> ```
> [predev] ADK health check failed — http://localhost:8200/healthz returned no response
> [predev] Start the ADK agent first: uv run python -m adk_agent.server
> ```
> run the ADK server in another terminal, then retry `pnpm dev`.

---

## Phase 3: Environment Configuration

DESCRIPTION: Create the `.env.local` file and collect required configuration values from the user.

### Steps

```bash
cp .env.local.example .env.local
```

Now ask the user for each value and write it into `.env.local`.

#### 3.1 Required Variables

ASK_USER: "Enter your Gemini API Key. You can create one at https://aistudio.google.com/apikey"

Write the response into `.env.local`:
```bash
# Replace the empty value with the user's response
# Example: sed -i.bak -e 's|^GEMINI_API_KEY=.*|GEMINI_API_KEY=user_value_here|' .env.local
```

ASK_USER: "Enter your PostgreSQL connection URL (press Enter for default: postgresql://localhost:5432/gemini_rag)"

If the user provides a value, write it. If the user presses Enter or skips, use the default:
```bash
# Replace with user value or default
# Example: sed -i.bak -e 's|^DATABASE_URL=.*|DATABASE_URL=postgresql://localhost:5432/gemini_rag|' .env.local
```

ASK_USER: "Enter a SAP_SESSION_SECRET (32+ characters). Generate one with: openssl rand -base64 48"

Write the response into `.env.local` as `SAP_SESSION_SECRET`.

After writing all values, clean up backup files: `rm -f .env.local.bak`

#### 3.2 Google Cloud Storage Setup (Optional)

GCS is required for file upload/download. Skip this section only if the user does not need file ingestion.

ASK_USER: "Set up Google Cloud Storage now? This creates a service account and key file via gcloud. (yes/no)"

If **yes**, prefer the automated script — it creates the service account, grants the role, generates the JSON key, and writes all three GCS variables into `.env.local` in one shot:

```bash
pnpm gcp:setup
```

The script will prompt for **GCP Project ID** and **GCS Bucket Name** if they are not already in `.env.local`. It is idempotent — re-running with the same inputs is safe.

Preconditions for the script:
- `gcloud` CLI installed (`gcloud --version`). If missing: macOS `brew install --cask google-cloud-sdk` / Linux see https://cloud.google.com/sdk/docs/install
- Authenticated: `gcloud auth login` (the script will fail with a clear message if not)

If the script fails (no `gcloud`, no auth, or insufficient permissions) or the user prefers manual setup, fall back to asking each value:

ASK_USER: "Enter your GCS Bucket name (press Enter to skip)"

If the user provides a value, write it into `GCS_BUCKET_NAME`. Otherwise, leave it empty.

ASK_USER: "Enter your GCP Project ID (press Enter to skip)"

If the user provides a value, write it into `GCS_PROJECT_ID`. Otherwise, leave it empty.

ASK_USER: "Enter the path to your Service Account JSON file (press Enter to skip)"

If the user provides a value, write it into `GOOGLE_APPLICATION_CREDENTIALS`. Otherwise, leave it empty. See README "Service Account & Credentials" section for the full manual gcloud / Console steps.

Also write `ADK_BASE_URL` with the default value into `.env.local`:

```bash
grep -q '^ADK_BASE_URL=' .env.local || echo 'ADK_BASE_URL=http://localhost:8200' >> .env.local
```

### VERIFY

```bash
grep -q 'GEMINI_API_KEY=.\+' .env.local && echo "OK: GEMINI_API_KEY is set" || echo "FAIL: GEMINI_API_KEY is empty"
grep -q 'DATABASE_URL=.\+' .env.local && echo "OK: DATABASE_URL is set" || echo "FAIL: DATABASE_URL is empty"
grep -q 'SAP_SESSION_SECRET=.\+' .env.local && echo "OK: SAP_SESSION_SECRET is set" || echo "FAIL: SAP_SESSION_SECRET is empty"
```

All checks must print `OK`.

### TROUBLESHOOT

| Symptom | Fix |
|---------|-----|
| `.env.local.example` not found | You are not in the project root. Run `cd sap-rag-integration` |
| VERIFY fails for GEMINI_API_KEY | Re-ask the user for the API key and write it into `.env.local` |
| VERIFY fails for DATABASE_URL | Write the default: `sed -i.bak -e 's|^DATABASE_URL=.*|DATABASE_URL=postgresql://localhost:5432/gemini_rag|' .env.local && rm -f .env.local.bak` |

---

## Phase 4: Database Setup

DESCRIPTION: Create the PostgreSQL database and initialize tables with pgvector extension.

### Steps

Extract the database name from DATABASE_URL, then create the database and run setup:

```bash
createdb gemini_rag 2>/dev/null || true
pnpm db:setup
```

If DATABASE_URL uses a custom database name, extract it:
```bash
# Example: DATABASE_URL=postgresql://user:pass@localhost:5432/mydb → createdb mydb
```

### VERIFY

```bash
# Use the DATABASE_URL from .env.local
source <(grep DATABASE_URL .env.local)
psql "$DATABASE_URL" -c "SELECT 1" >/dev/null 2>&1 && echo "OK: Database connection successful" || echo "FAIL: Cannot connect to database"
```

Must print `OK`.

### TROUBLESHOOT

| Symptom | Fix |
|---------|-----|
| `connection refused` | PostgreSQL is not running. macOS: `brew services start postgresql@17` / Linux: `sudo systemctl start postgresql` |
| `database "gemini_rag" does not exist` | Run `createdb gemini_rag` again |
| `role "xxx" does not exist` | Create the role: `createuser -s xxx` or adjust DATABASE_URL to use an existing PostgreSQL user |
| `FATAL: role "username" does not exist` (Linux) | Linux default install uses only the `postgres` role. Run: `sudo -u postgres createdb gemini_rag` |
| `pnpm db:setup` fails with pgvector error | Ensure pgvector is installed. macOS: `brew install pgvector` / Linux: `sudo apt-get install postgresql-17-pgvector` |

---

## Phase 5: ADK Agent Setup

DESCRIPTION: Set up the Google ADK Python agent. Required for all SAP and RAG tool functionality.

### Steps

```bash
cp adk_agent/.env.example adk_agent/.env
```

#### 5.1 ADK Connection Settings

ASK_USER: "Enter your SAP Host (e.g., your-sap-host.example.com — press Enter to skip SAP integration)"

If provided, write into `adk_agent/.env` as `SAP_HOST`.

ASK_USER: "Choose SAP authentication type: basic or sap_oauth (press Enter for default: basic)"

Write the response or default `basic` into `SAP_AUTH_TYPE`.

Generate and write the Fernet encryption key:

```bash
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Write the output into `SAP_CRED_ENCRYPTION_KEY` in `adk_agent/.env`.

Also copy the same `DATABASE_URL` from `.env.local` into `adk_agent/.env`:

```bash
grep '^DATABASE_URL=' .env.local >> adk_agent/.env
```

#### 5.2 Authentication Credentials

**If SAP_AUTH_TYPE is `basic`:**

ASK_USER: "Do you want to set SAP credentials in adk_agent/.env now? (yes/no — answer 'no' to log in via the inline form in the chat UI at runtime)"

If **no**, leave `SAP_USER` and `SAP_PASSWORD` commented out.

If **yes**:

ASK_USER: "Enter your SAP Username"

Write into `SAP_USER`.

ASK_USER: "Enter your SAP Password"

Write into `SAP_PASSWORD`.

**If SAP_AUTH_TYPE is `sap_oauth`:**

ASK_USER: "Enter OAuth Client ID" → write into `SAP_OAUTH_CLIENT_ID`.

ASK_USER: "Enter OAuth Client Secret" → write into `SAP_OAUTH_CLIENT_SECRET`.

ASK_USER: "Enter OAuth Authorize URL" → write into `SAP_OAUTH_AUTHORIZE_URL`.

ASK_USER: "Enter OAuth Token URL" → write into `SAP_OAUTH_TOKEN_URL`.

ASK_USER: "Enter OAuth Redirect URI (press Enter for default: http://localhost:3000/api/sap/oauth/callback)"

Write the response or default `http://localhost:3000/api/sap/oauth/callback` into `SAP_OAUTH_REDIRECT_URI`.

#### 5.3 Install and Start

```bash
uv venv && uv sync
uv run python -m adk_agent.server &
```

Wait 3 seconds for the server to start.

### VERIFY

```bash
curl -s http://localhost:8200/healthz | grep -q "ok" && echo "OK: ADK agent is running" || echo "FAIL: ADK agent not responding"
```

Must print `OK`.

### TROUBLESHOOT

| Symptom | Fix |
|---------|-----|
| `uv: command not found` | Install uv: `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| `ModuleNotFoundError` | Re-run `uv sync` inside the project root |
| `Address already in use` (port 8200) | Find and kill: `lsof -i :8200` then `kill <PID>`, then retry |
| `curl` returns connection refused | Wait a few more seconds and retry. If still failing, check `uv run python -m adk_agent.server` output |
| Missing `SAP_CRED_ENCRYPTION_KEY` error | Generate a Fernet key (see step 5.1) and add it to `adk_agent/.env` |

> **Migrating from sap-service?** The standalone `sap-service/` FastAPI application has been
> removed. All SAP and RAG functionality now lives in `adk_agent/`. Follow this Phase instead
> of any previous `sap-service` setup instructions.

---

## Final Verification

DESCRIPTION: Verify the ADK agent is up, then start the Next.js development server and confirm the application is accessible.

### Steps

First, confirm the ADK agent is still running (started in Phase 5):

```bash
curl -s http://localhost:8200/healthz | grep -q "ok" && echo "OK: ADK running" || echo "FAIL: Start ADK first: uv run python -m adk_agent.server"
```

Then start Next.js:

```bash
pnpm dev &
```

Wait 5 seconds for the server to start.

```bash
sleep 5
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000
```

### VERIFY

```bash
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000)
case "$HTTP_CODE" in
  200|301|302|307|308)
    echo "OK: Application is running (HTTP $HTTP_CODE)"
    ;;
  *)
    echo "FAIL: Application returned HTTP $HTTP_CODE"
    ;;
esac
```

The root path `/` redirects to `/chat` (307), which is expected. Any 2xx or 3xx response means the app is up.

Must print `OK`.

### TROUBLESHOOT

| Symptom | Fix |
|---------|-----|
| `FAIL: Application returned HTTP 000` | Server not started yet. Wait 5 more seconds and retry the VERIFY |
| `pnpm dev` exits with ADK health check error | ADK is not running. Start it: `uv run python -m adk_agent.server` in another terminal |
| Port 3000 already in use | Find and kill: `lsof -i :3000` then `kill <PID>`, retry `pnpm dev &` |
| Build errors during `pnpm dev` | Check for missing environment variables in `.env.local`. Re-run Phase 3 |

---

## Installation Complete

The application is now running. Here is a summary:

| Service | URL | Status |
|---------|-----|--------|
| ADK Agent | http://localhost:8200 | Running |
| Next.js App | http://localhost:3000 | Running |

### Next Steps

1. Open http://localhost:3000/chat to start chatting
2. Attach a file and type "embedding" to embed it into the vector database
3. Ask questions about embedded documents using natural language
4. If SAP is configured, ask about SAP product master data (e.g., "Show me products of type FERT")
5. For SAP queries, log in via the inline Basic auth form or click the SAP login button for OAuth
