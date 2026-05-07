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
    console.log('0. Checking whether sap_user_id already exists...');
    const existing = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'conversations'
          AND column_name = 'sap_user_id'
      ) AS exists
    `;
    if (existing[0]?.exists) {
      console.log('   sap_user_id already exists — migration is a no-op. Exiting.');
      return;
    }
    console.log('   not present yet, proceeding.');

    console.log('1. Truncating conversations (no recoverable owner; messages cascade)...');
    await sql`TRUNCATE TABLE conversations CASCADE`;
    console.log('   tables truncated.');

    console.log('2. Adding sap_user_id column to conversations...');
    await sql`
      ALTER TABLE conversations
        ADD COLUMN IF NOT EXISTS sap_user_id VARCHAR(255) NOT NULL
    `;
    console.log('   column added.');

    console.log('3. Creating idx_conversations_sap_user...');
    await sql`
      CREATE INDEX IF NOT EXISTS idx_conversations_sap_user
        ON conversations (sap_user_id, updated_at DESC)
    `;
    console.log('   index created.');

    console.log('\nMigration complete.');
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

main();
