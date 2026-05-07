# Gemini AI Assistant — RAG + SAP Agentic Workflow

An AI agentic workflow powered by Google Gemini and Google ADK that intelligently routes queries to two data sources:
- **Document Search (RAG)**: Multimodal vector search over embedded text, PDF, image, audio, and video files
- **SAP Enterprise Data**: Live OData queries to SAP Product Master (materials, plants, sales, valuation, units of measure)

A single Google ADK `LlmAgent` exposes five tools and decides which data source to query — or both — synthesizing a unified answer. Next.js serves the chat UI and ingestion pipeline; all agent logic lives in the ADK Python backend.

---

## Architecture

### System Overview

```mermaid
graph TB
    User([👤 User])

    subgraph NextJS["Next.js App (Port 3000)"]
        ChatUI["Chat UI<br/><small>React 19 + Tailwind</small>"]
        ChatAPI["POST /api/chat"]
        EmbedAPI["POST /api/embed"]
        PipelineAPI["POST /api/pipeline"]
        OAuthCB["GET /api/sap/oauth/callback<br/><small>OAuth Step 2 proxy</small>"]
    end

    subgraph ADK["ADK FastAPI (Port 8200)"]
        LlmAgent["LlmAgent<br/><small>adk_agent/agent.py</small>"]

        subgraph Tools["5 base tools + 1 optional MCP toolset"]
            T1["search_documents<br/><small>pgvector RAG</small>"]
            T2["sap_authenticate<br/><small>Basic / OAuth PKCE</small>"]
            T3["sap_list_services<br/><small>services.yaml catalog</small>"]
            T4["sap_query<br/><small>OData $filter/$orderby</small>"]
            T5["sap_get_entity<br/><small>single entity fetch</small>"]
            T6["Pub/Sub MCP toolset<br/><small>list_topics · publish · …<br/>deny-by-default gate</small>"]
        end

        MCPCfg[".mcp.json<br/><small>tool/topic/sub allowlists</small>"]
    end

    subgraph DataSources["Data Sources"]
        PG[("PostgreSQL<br/>+ pgvector<br/><small>3072-dim embeddings</small>")]
        GCS[("Google Cloud<br/>Storage<br/><small>Documents · Media</small>")]
        SAP[("SAP Gateway<br/><small>OData v2/v4</small>")]
    end

    subgraph AI["Google AI"]
        Gemini["Gemini LLM<br/><small>Streaming · Tool Use</small>"]
        EmbModel["Gemini Embedding 2<br/><small>3072 dimensions</small>"]
    end

    subgraph MCP["MCP servers (HTTP)"]
        PubsubMCP["pubsub.googleapis.com/mcp<br/><small>Cloud Pub/Sub<br/>(ADC + roles/mcp.toolUser)</small>"]
    end

    User --> ChatUI
    ChatUI --> ChatAPI
    ChatAPI --> LlmAgent
    LlmAgent --> Gemini
    Gemini -.->|tool calls| LlmAgent
    LlmAgent --> T1 & T2 & T3 & T4 & T5
    LlmAgent -.->|"if .mcp.json present"| T6
    MCPCfg -.->|configures| T6
    T1 --> PG
    T1 --> EmbModel
    T2 & T4 & T5 --> SAP
    T6 --> PubsubMCP
    EmbedAPI --> EmbModel
    EmbedAPI --> GCS
    EmbedAPI --> PG
    PipelineAPI --> EmbModel
    PipelineAPI --> GCS
    PipelineAPI --> PG
    OAuthCB --> LlmAgent

    style NextJS fill:#e8f5e9,stroke:#2e7d32
    style ADK fill:#e3f2fd,stroke:#1565c0
    style DataSources fill:#fff3e0,stroke:#e65100
    style AI fill:#fce4ec,stroke:#c62828
    style Tools fill:#f3e5f5,stroke:#7b1fa2
    style MCP fill:#e0f7fa,stroke:#00838f
    style T6 stroke-dasharray: 5 5
    style MCPCfg fill:#fff8e1,stroke:#f57f17
```

### Request Flow

```mermaid
sequenceDiagram
    actor User
    participant UI as Chat UI
    participant API as /api/chat (Next.js)
    participant ADK as ADK FastAPI :8200
    participant Gemini as Gemini LLM
    participant SAP as SAP Gateway

    User->>UI: "Show me products of type FERT"
    UI->>API: POST {message, conversationId}
    API->>API: Load chat history from DB
    API->>ADK: POST /run (message, session_id)
    ADK->>Gemini: LlmAgent.run(message, tools)

    Note over Gemini: Analyzes intent →<br/>decides: sap_query

    Gemini-->>ADK: tool_call: sap_query<br/>{service: "API_PRODUCT_SRV",<br/>entity_set: "A_Product"}
    ADK->>SAP: OData GET A_Product?$filter=...
    SAP-->>ADK: {results: [...], count: N}
    ADK-->>Gemini: tool_result

    Note over Gemini: Formats response<br/>as markdown table

    Gemini-->>ADK: streamed text response
    ADK-->>API: SSE / streamed chunks
    API-->>UI: SSE stream
    UI-->>User: Rendered markdown table

    API->>API: Save messages to DB
```

### SAP OAuth Flow

```mermaid
sequenceDiagram
    actor User
    participant UI as Chat UI
    participant Next as Next.js API :3000
    participant ADK as ADK FastAPI :8200
    participant SAP_GW as SAP Gateway

    User->>UI: Request SAP login
    UI->>Next: POST /api/sap/auth {method: "oauth"}
    Next->>ADK: sap_authenticate Step 1
    ADK->>ADK: Generate PKCE<br/>(code_verifier + code_challenge)
    ADK-->>Next: {login_url, state}
    Next-->>UI: login_url (+ sets sap_oauth_pending cookie)
    UI->>UI: Open login_url in popup

    User->>SAP_GW: Authenticate in popup
    SAP_GW-->>Next: GET /api/sap/oauth/callback?code=&state=
    Next->>Next: Verify state via sap_oauth_pending cookie
    Next->>ADK: sap_authenticate Step 2 (code exchange)
    ADK->>SAP_GW: Exchange code + code_verifier for token
    SAP_GW-->>ADK: access_token
    ADK-->>Next: {success: true}
    Next-->>Next: Set sap_session cookie (iron-session)
    Next-->>UI: popup postMessage → opener notified, popup closes
    UI-->>User: SAP Connected

    Note over ADK: Credentials stored in<br/>ADK session state (in-process)
```

### Components

| Component | Stack | Purpose |
|-----------|-------|---------|
| **Next.js App** | TypeScript, Next.js 16, React 19 | Chat UI, API routes, ingestion pipeline |
| **ADK Agent** | Python, Google ADK, FastAPI, port 8200 | Single LlmAgent — 5 base tools + 1 optional MCP toolset, SAP + RAG logic |
| **Vector DB** | PostgreSQL + pgvector | 3072-dim Gemini embeddings for document search |
| **File Storage** | Google Cloud Storage | Uploaded documents and media files |
| **Pub/Sub MCP** *(optional)* | HTTP MCP at `pubsub.googleapis.com/mcp` | Topic / subscription / publish operations exposed to the LLM under deny-by-default allowlists in `.mcp.json` |

### ADK Tools

The ADK agent (`adk_agent/agent.py`) exposes one `LlmAgent` with five
base tools, plus an optional sixth slot wired in when `.mcp.json` is
present at the repo root:

| Tool | Description |
|------|-------------|
| `search_documents` | pgvector RAG — embeds the query with Gemini and searches the `embeddings` table (vector(3072)) |
| `sap_authenticate` | SAP login — Basic (username/password) or OAuth 2.0 PKCE; sets `sap_session` cookie on success |
| `sap_list_services` | Returns the services.yaml catalog of available SAP OData services |
| `sap_query` | OData entity-set query with `$filter`, `$orderby`, `$top` support against SAP Gateway |
| `sap_get_entity` | Fetches a single OData entity by key fields |
| **Pub/Sub MCP toolset** *(optional)* | Adds `list_topics`, `get_topic`, `list_subscriptions`, `get_subscription`, `publish` tools, gated by deny-by-default allowlists for tools, topics, and subscriptions. See [docs/en/MCP.md](./docs/en/MCP.md). |

---

## Preparation

Before installing, obtain the API keys required by both the Next.js app and the ADK agent.

### Gemini API Key

Both services need a Gemini API key — the Next.js app stores it as `GEMINI_API_KEY` and the ADK agent stores it as `GOOGLE_API_KEY`. They are the **same key** with different variable names.

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Sign in with your Google account
3. Click **"Create API key"**
4. Select an existing Google Cloud project or create a new one when prompted
5. Copy the generated key (starts with `AIza...`)

> **Free tier available.** Google AI Studio provides a free quota suitable for development and testing. No billing account is required to get started.

Set the key in both env files:

```env
# .env.local  (Next.js)
GEMINI_API_KEY=AIza...

# adk_agent/.env  (ADK Python agent)
GOOGLE_API_KEY=AIza...
```

> Both variables must contain the **same key value**. The different names reflect the conventions of each SDK — `@google/genai` for Next.js and `google-genai` for Python ADK.

### Google Cloud Project (for GCS & optional features)

Google Cloud Storage (for file uploads) and optional features (Vertex AI Agent Engine, Cloud SQL, Pub/Sub MCP) require a Google Cloud project.

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project selector at the top → **"New Project"**
3. Enter a project name and note the **Project ID** (e.g., `my-project-123`)
4. Enable billing if you plan to use GCS, Cloud SQL, or Vertex AI
5. Install and authenticate the `gcloud` CLI:
   ```bash
   # Install: https://cloud.google.com/sdk/docs/install
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   ```

> **GCS is required for file uploads.** The `pnpm gcp:setup` script (Option B, Step 5) creates the service account and bucket automatically once you have a project.

---

## Installation

There are **two ways** to install this project. Pick one — you do not need both.

| Option | Who is it for? | Effort | Recommended? |
|--------|----------------|--------|--------------|
| **A. Install with an AI coding tool** | Anyone with Gemini CLI, Antigravity, Cursor, Codex, or Claude Code | One paste, then answer prompts | ⭐ **Yes** — faster, fewer mistakes |
| **B. Install manually** | No AI tool available, or you want to run each command yourself | ~15–30 minutes of reading and typing | Only if Option A is not possible |

---

### Option A: Install with an AI Coding Tool (Recommended)

> **AI tools install this project better than humans do.** They detect your OS, install missing
> dependencies, clone the repo, configure environment variables interactively, initialize the
> database, optionally set up the SAP service, and verify every step before moving on. The full
> install playbook lives in [`installation.md`](./installation.md), which is written specifically
> for AI agents to execute top-to-bottom.

Paste this single line into your AI coding tool (Gemini CLI, Antigravity, Cursor, Codex, or Claude Code):

```
Install and configure sap-rag-integration by following the instruction here:
https://raw.githubusercontent.com/midasol/sap-rag-integration/main/installation.md
```

The AI agent will then ask you for your Gemini API key, database URL, and (optionally) SAP credentials — and handle everything else.

> ✅ **If you used Option A, you are done. Skip Option B entirely and jump to [Usage Guide](#usage-guide).**

---

### Option B: Manual Installation (For Humans)

<details>
<summary>📖 <strong>Click to expand manual install steps</strong> — only if you did not use Option A above</summary>

<br>

> **Use this section only if you did not use Option A.** If you installed via the AI-tool path
> above, every step below is already done — there is nothing more to do here. Skip to
> [Usage Guide](#usage-guide).

The rest of this section walks through each step manually. You will install prerequisites, clone the repo, configure environment variables, initialize the database, and start both services yourself.

#### Prerequisites

> 🛑 **Manual install only.** Everything below this point — prerequisites, environment setup,
> database initialization, service startup — is for users doing the install **by hand**. If you
> already ran the Option A one-liner with an AI coding tool, **do not run any of these steps
> again**. The AI agent has already done all of this for you. Skip ahead to [Usage Guide](#usage-guide).

##### 1. Node.js

Node.js **24.14.0 or higher** is required.

```bash
node -v   # Must be v24.14.0 or higher

# Install (macOS - Homebrew)
brew install node

# Or via nvm
nvm install 24 && nvm use 24
```

##### 2. pnpm

```bash
npm install -g pnpm
```

##### 3. Python 3.11+

Required for the SAP service.

```bash
python3 --version   # Must be 3.11+

# Install (macOS - Homebrew)
brew install python@3.11
```

##### 4. PostgreSQL + pgvector

```bash
# macOS - Homebrew
brew install postgresql@17 pgvector
brew services start postgresql@17

# Create database
createdb gemini_rag
```

> The pgvector extension is automatically enabled when running `pnpm db:setup`.

##### 5. Google Cloud Account & API Key

###### Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Click "Create API Key"
3. Copy and save the API key

###### Google Cloud Storage (GCS) Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Go to **Cloud Storage** > "Create Bucket"

###### Service Account & Credentials (GOOGLE_APPLICATION_CREDENTIALS)

A service account JSON key is required for GCS file upload/download.

**Path 1 (Recommended): Automated Script**

```bash
pnpm gcp:setup
```

This script creates the service account, grants `roles/storage.objectAdmin`, creates the GCS bucket if it doesn't already exist, generates the JSON key file, and writes `GCS_PROJECT_ID`, `GCS_BUCKET_NAME`, and `GOOGLE_APPLICATION_CREDENTIALS` into `.env.local`. It is idempotent — re-running is safe.

Preconditions:
- `gcloud` CLI installed: https://cloud.google.com/sdk/docs/install
- Authenticated: `gcloud auth login`

The script will prompt for **GCP Project ID** and **GCS Bucket Name** if they are not already set in `.env.local`. Defaults can be overridden via env vars (`GCP_SA_NAME`, `GCP_KEY_FILE`, `GCP_BUCKET_LOCATION`) — see the script header for details.

**Path 2: Google Cloud Console (UI)**

1. Go to [Google Cloud Console](https://console.cloud.google.com/) > **IAM & Admin** > **Service Accounts**
2. Click **"+ CREATE SERVICE ACCOUNT"**
3. Enter a name (e.g., `gemini-rag-storage`) → **Create and Continue**
4. Select role: **Storage Object Admin** → **Continue** → **Done**
5. Click the created service account → **Keys** tab
6. **Add Key** → **Create new key** → **JSON** → **Create**
7. A JSON file will be downloaded automatically
8. Move it to the project root:
   ```bash
   mv ~/Downloads/your-project-xxxxxx.json ./service-account.json
   ```
9. Set the path in `.env.local`:
   ```env
   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
   ```

**Path 3: Manual gcloud Commands**

```bash
# Create service account
gcloud iam service-accounts create gemini-rag-storage \
  --display-name="Gemini RAG Storage"

# Grant Storage Object Admin role
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:gemini-rag-storage@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"

# Download JSON key
gcloud iam service-accounts keys create ./service-account.json \
  --iam-account=gemini-rag-storage@YOUR_PROJECT_ID.iam.gserviceaccount.com
```

> `service-account.json` is already in `.gitignore` — it will not be committed to git.
> If `GOOGLE_APPLICATION_CREDENTIALS` is not set, the SDK falls back to [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials).

##### 6. SAP System Access (Optional)

Required only for SAP data queries:
- SAP Gateway host with OData services exposed
- OAuth 2.0 client configured in SAP (transaction SOAUTH2)
- Network access to the SAP system

#### Quick Start (Manual Steps)

> 🛑 **Manual install only.** These steps are part of Option B. If you used the Option A AI-tool
> one-liner, the agent has already cloned the repo, written `.env.local`, run `pnpm db:setup`,
> and started both services for you — running them again will not help. Go to
> [Usage Guide](#usage-guide).

##### Step 1: Clone & Install

```bash
git clone https://github.com/midasol/sap-rag-integration.git
cd sap-rag-integration
pnpm install
```

##### Step 2: Configure Environment

```bash
cp .env.local.example .env.local
```

Edit `.env.local`:

```env
# === Required ===
GEMINI_API_KEY=your-gemini-api-key
DATABASE_URL=postgresql://username:password@localhost:5432/gemini_rag
GCS_BUCKET_NAME=your-bucket-name
GCS_PROJECT_ID=your-gcp-project-id
SAP_SESSION_SECRET=<32+ char secret — openssl rand -base64 48>

# === Optional ===
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
# GEMINI_EMBEDDING_MODEL=gemini-embedding-2-preview
# GEMINI_CHAT_MODEL=gemini-3.1-pro-preview

# === ADK Backend ===
ADK_BASE_URL=http://localhost:8200
```

##### Step 3: Initialize Database

```bash
pnpm db:setup
```

##### Step 4: Start the ADK Backend

```bash
# From the project root
cp adk_agent/.env.example adk_agent/.env   # Edit with your SAP + DB credentials
uv venv && uv sync
uv run python -m adk_agent.server          # Starts on port 8200

# Verify:
curl http://localhost:8200/healthz         # → {"status":"ok"}
```

##### Step 5: Start the Next.js App

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) — it redirects to the `/chat` page.

</details>

---

## Usage Guide

Open [http://localhost:3000/chat](http://localhost:3000/chat) to start. The status bar at the bottom shows active data sources:
- **SAP Connected** (green) / **Not connected** (yellow)
- **Documents** (green) — available when pgvector has embedded data

---

### Scenario 1: Document Embedding & Search

Embed files into the vector database, then ask questions about them.

**Step 1 — Embed a file in chat**

Click the paperclip icon, attach a file (PDF, image, video, etc.), and type a message containing "embedding":

```
User: [attached: annual-report-2025.pdf] embedding this file
Assistant: File 'annual-report-2025.pdf' has been successfully embedded. (12 chunks created)
```

**Step 2 — Ask questions about the document**

```
User: What does the annual report say about Q3 revenue?
Assistant: According to the annual report (similarity: 92.3%), Q3 revenue was...
         [File: annual-report-2025.pdf, Similarity: 92.3%]
```

**Batch embedding (multiple files at once)**

```bash
# CLI — embed all files in a folder
pnpm pipeline -- ./data

# Or use the Admin UI
open http://localhost:3000/admin/pipeline
```

---

### Scenario 2: SAP Data Queries

Query live SAP enterprise data using natural language.

**Discover available SAP data**

```
User: What SAP data can I access?
Assistant: The following SAP service is available:
         | Module | Service | Description |
         | Product Master | API_PRODUCT_SRV | Product (material) master, plant, sales, valuation, units |
```

**Query with filters**

```
User: Show me the first 5 products of type FERT
Assistant: | Product | Type | Cross-Plant Status | Created |
         | MZ-FG-R100 | FERT | Active | 2024-08-12 |
         | MZ-FG-R101 | FERT | Active | 2024-08-12 |
         ...
```

**Fetch a specific record**

```
User: Show me details of product MZ-FG-R100
Assistant: **Product MZ-FG-R100**
         - Product Type: FERT (Finished good)
         - Cross-Plant Status: Active
         - Created: 2024-08-12 by USER01
         - Last Changed: 2025-01-04
         ...
```

**Cross-entity queries**

```
User: What plants stock product MZ-FG-R100?
User: Show me the description of product MZ-FG-R100 in English
User: What is the standard price and valuation class for product MZ-FG-R100?
```

#### API_PRODUCT_SRV test query bank

A ready-to-paste set of prompts that exercise every entity in the Product Master service.
Replace example IDs (`MZ-FG-R100`, plant `1010`, sales org `1010`) with values that exist in your SAP system.

**`A_Product` — header (cross-plant)**
```
Show me 10 products of type FERT
List products created after 2024-01-01, ordered by creation date
How many products have CrossPlantStatus active?
Show full details of product MZ-FG-R100
```

**`A_ProductDescription` — multilingual descriptions**
```
Show the English description of product MZ-FG-R100
List all language descriptions for product MZ-FG-R100
```

**`A_ProductPlant` — plant-level master data**
```
Which plants does product MZ-FG-R100 exist in?
Show purchasing group and country of origin for MZ-FG-R100 in plant 1010
Which products in plant 1010 are managed in production inventory?
```

**`A_ProductSales` — sales status and tax**
```
What is the sales status and tax classification of MZ-FG-R100?
Show the transportation group for the first 5 products of type FERT
```

**`A_ProductSalesDelivery` — sales org / distribution channel**
```
What is the minimum order quantity and supplying plant for MZ-FG-R100 in sales org 1010?
List the account determination product group for products in distribution channel 10
```

**`A_ProductStorage` — storage and hazmat**
```
Show storage conditions and minimum remaining shelf life for MZ-FG-R100
Which products have a hazardous material number set?
```

**`A_ProductValuation` — pricing per valuation area**
```
What is the standard price and valuation class for MZ-FG-R100 in valuation area 1010?
Show valuation type and inventory valuation procedure for MZ-FG-R100
```

**`A_ProductUnitsOfMeasure` — alternative units**
```
Show alternative units of measure for MZ-FG-R100
What is the gross weight and material volume of MZ-FG-R100?
```

**Filters, ordering, and aggregations**
```
Show me the 5 most recently changed products
List products created by USER01 in the last 30 days
Group products by ProductType and count
```

---

### Scenario 3: Combined Queries (Documents + SAP)

Ask questions that need both embedded documents and live SAP data. The ADK agent calls multiple tools automatically across `search_documents`, `sap_query`, and friends.

```
User: Compare our product master snapshot document with the live SAP product data
Assistant: **Document Analysis** (from product-master-snapshot.pdf):
         The snapshot listed 12 finished goods (type FERT)...

         **Actual SAP Data** (from API_PRODUCT_SRV / A_Product):
         | Product | Type | Cross-Plant Status | Last Changed |
         | MZ-FG-R100 | FERT | Active | 2025-01-04 |
         | MZ-FG-R101 | FERT | Active | 2025-01-04 |
         | MZ-FG-R102 | FERT | Inactive | 2024-11-22 |

         Overall Q1 actual revenue was $2.15M vs forecast $2.1M (+2.4%).
```

```
User: Compare the product list in the uploaded spreadsheet with the current SAP product master
Assistant: The spreadsheet lists 20 finished goods (type FERT)...
         Checking SAP Product Master (API_PRODUCT_SRV / A_Product):
         | Product | Type | Cross-Plant Status | Last Changed |
         | MZ-FG-R100 | FERT | Active | 2025-01-04 |
         | MZ-FG-R101 | FERT | Active | 2025-01-04 |
         ...
```

---

### Scenario 4: SAP Authentication

#### Basic Auth (SAP_AUTH_TYPE=basic)

When `SAP_AUTH_TYPE=basic` is configured, an inline login form appears in the chat window:

1. Enter your SAP User ID and Password in the inline form
2. Click **Login**
3. The status bar changes to "SAP Connected" (green)
4. SAP queries are available immediately

> Credentials are stored in-memory for the session. Restart the SAP service to clear them.

#### OAuth 2.0 (SAP_AUTH_TYPE=sap_oauth)

When `SAP_AUTH_TYPE=sap_oauth` is configured:

1. The chat status bar shows "SAP Not connected" (yellow)
2. Ask the assistant about SAP data — it will provide an OAuth login URL
3. Open the URL in your browser and authenticate with SAP
4. The authorization code is exchanged for an access token automatically
5. Tokens are refreshed automatically when they expire

---

### Scenario 5: Multimodal Document Search

Embed and search across different file types — text, PDF, images, audio, and video.

**Image search**

```
User: [attached: architecture-diagram.png] embedding
Assistant: File 'architecture-diagram.png' has been successfully embedded. (1 chunks created)

User: What components are shown in the architecture diagram?
Assistant: Based on the architecture diagram (similarity: 88.5%), the system consists of...
         [File: architecture-diagram.png, Similarity: 88.5%]
```

**Video search**

```
User: [attached: product-demo.mp4] embedding this video
Assistant: File 'product-demo.mp4' has been successfully embedded. (1 chunks created)

User: What features are demonstrated in the product demo video?
Assistant: The product demo video shows three main features...
         [File: product-demo.mp4, Similarity: 85.2%]
```

**Cross-format search**

```
User: Find all documents related to "cloud migration"
Assistant: Found 4 relevant results across different file types:
         1. cloud-migration-plan.pdf (94.1%) — 12-page migration roadmap...
         2. infrastructure-diagram.png (87.3%) — Shows target cloud architecture...
         3. migration-meeting.mp3 (82.5%) — Discussion about timeline and risks...
         4. project-notes.txt (79.8%) — Notes on migration dependencies...
```

---

## ADK Agent

The ADK Python agent (`adk_agent/`) is a Google ADK FastAPI application on port 8200. It owns all SAP and RAG tool logic. Next.js proxies agent calls via `ADK_BASE_URL`.

### Supported SAP Modules

| Module | Service ID | Entity Sets | Key Fields |
|--------|-----------|-------------|------------|
| Product Master | API_PRODUCT_SRV | A_Product, A_ProductDescription, A_ProductPlant, A_ProductSales, A_ProductSalesDelivery, A_ProductStorage, A_ProductValuation, A_ProductUnitsOfMeasure | Product |

### ADK Agent Configuration

Create `adk_agent/.env` from the example:

```bash
cp adk_agent/.env.example adk_agent/.env
```

```env
# === Database / RAG ===
DATABASE_URL=postgresql://username:password@localhost:5432/gemini_rag
EMBED_MODEL=gemini-embedding-2-preview
EMBED_OUTPUT_DIM=3072
EMBED_NORMALIZE=false

# === SAP Connection ===
SAP_HOST=your-sap-host.example.com
SAP_AUTH_TYPE=basic   # Options: basic, sap_oauth

# === Credentials encryption (Fernet key) ===
# Generate: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
SAP_CRED_ENCRYPTION_KEY=your-fernet-key

# === Basic Auth (SAP_AUTH_TYPE=basic) ===
# SAP_USER=your-sap-username
# SAP_PASSWORD=your-sap-password

# === OAuth 2.0 (SAP_AUTH_TYPE=sap_oauth) ===
# SAP_OAUTH_CLIENT_ID=your-oauth-client-id
# SAP_OAUTH_CLIENT_SECRET=your-oauth-client-secret
# SAP_OAUTH_AUTHORIZE_URL=https://your-sap-host:44300/sap/bc/sec/oauth2/authorize?sap-client=100
# SAP_OAUTH_TOKEN_URL=https://your-sap-host:44300/sap/bc/sec/oauth2/token?sap-client=100
# SAP_OAUTH_REDIRECT_URI=http://localhost:3000/api/sap/oauth/callback

# === Server ===
ADK_HOST=0.0.0.0
ADK_PORT=8200
SESSION_BACKEND=memory   # memory (dev) | vertex (production)
```

#### `SAP_AUTH_TYPE` Options

| Value | Description | Required Variables |
|-------|-------------|-------------------|
| `basic` | **HTTP Basic Authentication** (default). Credentials supplied via the inline login modal or `SAP_USER`/`SAP_PASSWORD` env vars. Suitable for development, demos, service-to-service. | `SAP_USER`, `SAP_PASSWORD` (or supplied at runtime) |
| `sap_oauth` | **OAuth 2.0 Authorization Code + PKCE**. User authenticates via browser popup; SAP redirects to Next.js `/api/sap/oauth/callback` (no Cloud Run sidecar needed). Recommended for production. | `SAP_OAUTH_CLIENT_ID`, `SAP_OAUTH_CLIENT_SECRET`, `SAP_OAUTH_AUTHORIZE_URL`, `SAP_OAUTH_TOKEN_URL`, `SAP_OAUTH_REDIRECT_URI` |

### ADK API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/healthz` | Health check |
| POST | `/run` | Send a message to the LlmAgent (streaming) |
| POST | `/api/sap/auth` | Trigger SAP authentication (Basic or OAuth Step 1) |
| GET | `/api/sap/oauth/callback` | OAuth Step 2 — proxied from Next.js callback route |

---

## Docker Compose (Local Development)

Run both services with a single command:

```bash
# Create env files first
cp .env.local.example .env.local
cp adk_agent/.env.example adk_agent/.env
# Edit both with your credentials

docker compose up
```

This starts:
- **adk** on port 8200 (built from `adk_agent/Dockerfile`)
- **nextjs** on port 3000 (with `ADK_BASE_URL=http://adk:8200`; depends on `adk`)

---

## Production Deployment

Two deployment topologies are scripted, both backed by **one shared
Cloud SQL Postgres + pgvector** instance:

- **Mode A — Cloud Run × 2.** `nextjs` + `adk_agent` as two Cloud Run
  services. Custom Next.js chat UI as the end-user surface.
- **Mode B — Vertex AI Agent Engine standalone.** Only `adk_agent`
  ships, then registered in **Gemini Enterprise** so end users talk to
  it from the Gemini chat surface.

```bash
# Mode A
./deploy/setup-cloud-sql.sh <PROJECT_ID>
./deploy/deploy-cloud-run.sh <PROJECT_ID>

# Mode B
MODE=agent-engine VPC_NETWORK=<vpc> ./deploy/setup-cloud-sql.sh <PROJECT_ID>
./deploy/setup-agent-engine.sh <PROJECT_ID>
gcloud run deploy sap-oauth-callback --source ./cloud-run-oauth-callback \
  --region us-central1 --allow-unauthenticated \
  --set-env-vars=GOOGLE_CLOUD_PROJECT=<PROJECT_ID>
uv run python deploy/deploy-agent-engine.py --project <PROJECT_ID>
# → Resource Name: projects/.../reasoningEngines/...
# Register that name in Gemini Enterprise (Agents → Register agent)
```

See [`deploy/README.md`](./deploy/README.md) for the decision matrix,
prerequisites, network topology diagrams, and full step-by-step.

---

## MCP (Model Context Protocol)

The ADK agent ships with optional **Google Cloud Pub/Sub** access via
MCP — the same `.mcp.json` Claude Code uses for project-scoped MCP
registration is also read by the agent at startup
(`adk_agent/mcp_pubsub.py`). When present, the LLM gets `list_topics`,
`get_topic`, `list_subscriptions`, `get_subscription`, and `publish`
tools, all gated by **deny-by-default allowlists** for tools, topics,
and subscriptions.

```jsonc
// .mcp.json (excerpt)
{
  "mcpServers": {
    "pubsub": {
      "type": "http",
      "url": "https://pubsub.googleapis.com/mcp",
      "headers": { "x-goog-user-project": "<your-gcp-project>" },
      "allowedTools":         ["list_topics", "publish", ...],
      "allowedTopics":        ["sapphire-demo"],
      "allowedSubscriptions": ["sapphire-demo-sub"]
    }
  }
}
```

To run **without** Pub/Sub: delete or rename `.mcp.json` — the agent
loads with the 5 base tools (RAG + 4 SAP) instead of 6 and logs
`mcp.pubsub.not_configured` once at startup. Nothing else changes.

For the full surface — what MCP is here, the deny-by-default semantics,
how `.mcp.json` travels into each deploy mode (Mode A: Dockerfile COPY,
Mode B: `extra_packages` bundle), IAM requirements, and how to add a
new MCP server — see [`docs/en/MCP.md`](./docs/en/MCP.md)
([한국어](./docs/ko/MCP.md)).

---

## Project Structure

```
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── page.tsx                  # / → /chat redirect
│   │   ├── chat/page.tsx             # Chat UI with SAP status
│   │   ├── admin/pipeline/page.tsx   # Batch embedding dashboard
│   │   └── api/
│   │       ├── chat/route.ts         # Chat proxy → ADK /run
│   │       ├── embed/route.ts        # Single file embedding
│   │       ├── conversations/        # Conversation CRUD
│   │       ├── pipeline/             # Batch pipeline
│   │       ├── files/[...path]/      # GCS file proxy
│   │       └── sap/                  # SAP proxy routes
│   │           ├── auth/route.ts     # SAP auth (Basic + OAuth Step 1)
│   │           ├── oauth/callback/   # OAuth Step 2 proxy → ADK
│   │           └── services/route.ts # SAP services list
│   ├── lib/
│   │   ├── adk-client.ts            # HTTP client for ADK agent
│   │   ├── gemini.ts                 # Gemini API client (ingestion)
│   │   ├── embedding.ts             # Embedding generation
│   │   ├── db.ts                     # PostgreSQL connection
│   │   ├── schema.ts                # DB schema (Drizzle)
│   │   ├── file-parser.ts           # File parsing/chunking
│   │   ├── gcs.ts                    # GCS upload/download
│   │   └── env.ts                    # Environment variables
│   ├── components/
│   │   ├── ChatSidebar.tsx           # Conversation list
│   │   ├── ChatWindow.tsx            # Message display
│   │   ├── ChatInput.tsx             # Input + file attachment
│   │   ├── SAPDataView.tsx           # SAP data table renderer
│   │   └── PipelineDashboard.tsx     # Pipeline dashboard
│   └── scripts/
│       ├── setup-db.ts               # DB initialization
│       └── pipeline.ts               # Batch embedding CLI
├── adk_agent/                        # Google ADK Python agent
│   ├── agent.py                      # LlmAgent + 5 tool definitions
│   ├── server.py                     # FastAPI entrypoint (port 8200)
│   ├── sap_gw_connector/             # Vendored SAP OData connector
│   ├── .env.example                  # ADK env var template
│   ├── Dockerfile
│   └── pyproject.toml
├── scripts/
│   ├── check-parent-workspace.mjs    # predev: guard against parent workspace
│   └── check-adk-health.mjs         # predev: verify ADK :8200 is up
├── tests/e2e/                        # Playwright E2E tests
├── docker-compose.yml
└── docs/
```

---

## npm Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start development server (http://localhost:3000) — predev checks ADK health |
| `pnpm build` | Production build |
| `pnpm start` | Start production server |
| `pnpm lint` | Run ESLint |
| `pnpm db:setup` | Initialize PostgreSQL tables and indexes |
| `pnpm pipeline -- <path>` | Batch embed files in a folder |
| `pnpm e2e` | Run Playwright E2E tests (see `tests/e2e/README.md` for prerequisites) |
| `uv run python -m adk_agent.server` | Start ADK backend on port 8200 |

---

## Supported File Formats

> Based on the [Gemini Embedding 2 documentation](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/embedding-2).

| Category | MIME Types | Restrictions | Processing Method |
|----------|-----------|-------------|-------------------|
| Text | Plain text | Max 8,192 tokens | Chunking (2000 chars, 200 overlap) |
| PDF | `application/pdf` | Max 6 pages per request | Split into 6-page chunks + multimodal embedding |
| Image | `image/png`, `image/jpeg` | Max 6 images per request | Base64 → multimodal embedding + AI summary |
| Audio | `audio/mp3`, `audio/wav` | Max 80 seconds | Base64 → multimodal embedding + AI summary |
| Video | `video/mpeg`, `video/mp4` | Max 80s (with audio) / 120s (silent) | Base64 → multimodal embedding + AI summary |

Additional formats (`.txt`, `.md`, `.csv`, `.json`, `.xml`, `.html`, `.gif`, `.webp`, `.ogg`, `.flac`, `.m4a`, `.webm`, `.avi`, `.mov`) are accepted for upload and processed as text or stored for reference.

---

## Configuration

### Authentication gate (`REQUIRE_AUTH`)

The Next.js app does not enforce authentication by default — local development
is friction-free. **Before exposing the app to any non-trusted network**, set:

```bash
REQUIRE_AUTH=true
```

When enabled, every protected API route returns `401 Unauthorized` unless the
session has logged in via `POST /api/sap/auth`. Authentication is verified via
the `sap_session` iron-session cookie signed with `SAP_SESSION_SECRET`.

Routes protected: `/api/chat`, `/api/embed`, `/api/conversations`,
`/api/pipeline/*`, `/api/files/*`, `/api/sap/services`.
Excluded: `/api/sap/auth` (login itself).

---

## Troubleshooting

### pgvector Installation Error

```
ERROR: could not open extension control file "vector"
```

```bash
# macOS
brew install pgvector

# Ubuntu
sudo apt install postgresql-17-pgvector

# Docker
docker run -p 5432:5432 pgvector/pgvector:pg16
```

### DATABASE_URL Connection Failure

```bash
brew services list | grep postgresql
brew services start postgresql@17
psql postgresql://username:password@localhost:5432/gemini_rag
```

### GCS Authentication Error

```
ERROR: Could not load the default credentials
```

Check `GOOGLE_APPLICATION_CREDENTIALS` in `.env.local` and verify the file exists.

### ADK Agent Not Running

```
pnpm dev fails: ADK health check failed — http://localhost:8200/healthz returned no response
```

1. Start the ADK backend first: `uv run python -m adk_agent.server`
2. Verify: `curl http://localhost:8200/healthz` → `{"status":"ok"}`
3. Check `ADK_BASE_URL` in `.env.local` (default `http://localhost:8200`)
4. Check `adk_agent/.env` for required variables (`DATABASE_URL`, `SAP_CRED_ENCRYPTION_KEY`, etc.)

### SAP Connection Failure

```
SAP Not connected (yellow dot in chat)
```

1. For Basic auth: enter credentials in the inline SAP login form in the chat UI
2. For OAuth: click the SAP login button — a popup opens the SAP authorize URL; authenticate and the popup closes automatically
3. Check `SAP_HOST` and `SAP_AUTH_TYPE` in `adk_agent/.env`

### SAP OAuth Callback Issues

If the OAuth popup does not close or session is not set:
1. Verify `SAP_OAUTH_REDIRECT_URI` in `adk_agent/.env` matches `http://localhost:3000/api/sap/oauth/callback`
2. Check that `SAP_SESSION_SECRET` is set in `.env.local`
3. Verify SAP Gateway is configured with the redirect URI in transaction `SOAUTH2`

### Gemini API 429 (Rate Limit)

The batch pipeline fails immediately when a rate limit is encountered. Rate-limit handling (retry with backoff) is the responsibility of the caller.

---

## Tech Stack

| Area | Technology |
|------|-----------|
| Chat UI / Ingestion | Next.js 16 (App Router), TypeScript, React 19 |
| Agent Framework | Google ADK (Python), single LlmAgent |
| Agent API | FastAPI, port 8200 |
| Embedding Model | gemini-embedding-2-preview (3072 dimensions) |
| LLM | Gemini (streaming, tool use) |
| Vector DB | PostgreSQL + pgvector |
| ORM | Drizzle ORM |
| File Storage | Google Cloud Storage |
| AI Streaming | Vercel AI SDK v6 |
| SAP Auth | Basic + OAuth 2.0 Authorization Code + PKCE |
| SAP Protocol | OData v2/v4 |
| UI | Tailwind CSS v4 + shadcn/ui |
| E2E Tests | Playwright |

> For detailed architecture and code analysis, see [docs/GUIDE.md](./docs/GUIDE.md).
