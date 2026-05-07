import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import postgres from 'postgres';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL is not set in .env.local');
    process.exit(1);
  }

  console.log('Connecting to PostgreSQL...');
  const sql = postgres(databaseUrl);

  try {
    // Step 1: Create pgvector extension
    console.log('1. Creating pgvector extension...');
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
    console.log('   pgvector extension created.');

    // Step 2: Create tables
    console.log('2. Creating tables...');

    await sql`
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
      )
    `;
    console.log('   embeddings table created.');

    await sql`
      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        sap_user_id VARCHAR(255) NOT NULL,
        title VARCHAR(200) NOT NULL DEFAULT 'New Chat',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('   conversations table created.');

    await sql`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE NOT NULL,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        file_name VARCHAR(500),
        attachments JSONB DEFAULT '[]',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `;
    console.log('   messages table created.');

    // Step 3: Create indexes
    console.log('3. Creating indexes...');

    console.log('   Dropping legacy IVFFlat index (if present)...');
    await sql`DROP INDEX IF EXISTS idx_embeddings_vector`;

    console.log('   Creating HNSW index on halfvec(3072)...');
    await sql`
      CREATE INDEX IF NOT EXISTS idx_embeddings_halfvec_hnsw
        ON embeddings USING hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_embeddings_file_name
        ON embeddings (file_name)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages (conversation_id, created_at)
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS idx_conversations_sap_user
        ON conversations (sap_user_id, updated_at DESC)
    `;
    console.log('   indexes created.');

    console.log('\nDatabase setup complete!');
  } catch (err) {
    console.error('Database setup failed:', err);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
