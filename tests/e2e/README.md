# E2E Tests

Three smoke scenarios for the ADK migration:

- **E1** — POST `/api/sap/auth` (basic) → load `/chat` → ask a RAG question → assert assistant reply.
- **E2** — same auth, then SAP query → assert table or assistant reply renders.
- **E3** — POST `/api/chat` without a session → expect 401.

## Prerequisites

1. Postgres + pgvector reachable on `DATABASE_URL` (host or `docker compose up -d postgres` if you have a postgres service in your overlay).
2. ADK Python agent: `uv run python -m adk_agent.server` (port 8200).
3. Next.js dev server: `pnpm dev` (port 3000).
4. SAP Gateway reachable from the ADK agent (see `.env.local` `SAP_HOST`, etc.).
5. A SAP user with read access to `API_PRODUCT_SRV` for E2.

## Running

```bash
# one-time
pnpm install
pnpm playwright install chromium

# every run
export E2E_SAP_USER=...
export E2E_SAP_PASSWORD=...
pnpm e2e
```

E1/E2 self-skip when `E2E_SAP_PASSWORD` is unset, so `pnpm e2e` in CI without
credentials only runs E3.

## Configuration

| Env | Default | Purpose |
|---|---|---|
| `E2E_BASE_URL` | `http://localhost:3000` | Where the Next.js app is served |
| `E2E_PORT` | `3000` | Used to derive default base URL |
| `E2E_SAP_USER` | `admin` | SAP username for E1/E2 |
| `E2E_SAP_PASSWORD` | _(unset → skip)_ | SAP password for E1/E2 |
