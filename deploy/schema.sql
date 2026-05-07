-- =============================================================================
-- sapphire26-adk — Cloud SQL schema
-- Mirrors src/scripts/setup-db.ts so a fresh Cloud SQL instance has the
-- same tables / indexes both the Next.js app and the ADK agent expect.
--
-- Apply via deploy/setup-cloud-sql.sh (uses cloud-sql-proxy + psql).
-- Requires PostgreSQL 17 with pgvector >= 0.7 (halfvec, HNSW on 3072-dim).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- embeddings: file/chunk text + 3072-dim Gemini embedding.
-- Written by the Next.js ingestion pipeline (src/lib/embedding-ingest.ts);
-- read by the ADK agent's `search_documents` tool (adk_agent/tools/rag_tool.py).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS embeddings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_name VARCHAR(500) NOT NULL,
    file_type VARCHAR(50) NOT NULL,
    file_path VARCHAR(1000) NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    chunk_text TEXT,
    content_summary TEXT,
    embedding vector(3072) NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- conversations: per-SAP-user chat threads
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sap_user_id VARCHAR(255) NOT NULL,
    title VARCHAR(200) NOT NULL DEFAULT 'New Chat',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- messages: chat turns under a conversation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE NOT NULL,
    role VARCHAR(20) NOT NULL,
    content TEXT NOT NULL,
    file_name VARCHAR(500),
    attachments JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Drop legacy IVFFlat index if it exists (idempotent re-runs).
DROP INDEX IF EXISTS idx_embeddings_vector;

-- HNSW on halfvec(3072) — vector(3072) is too wide for HNSW directly.
CREATE INDEX IF NOT EXISTS idx_embeddings_halfvec_hnsw
    ON embeddings USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_embeddings_file_name
    ON embeddings (file_name);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages (conversation_id, created_at);

CREATE INDEX IF NOT EXISTS idx_conversations_sap_user
    ON conversations (sap_user_id, updated_at DESC);
