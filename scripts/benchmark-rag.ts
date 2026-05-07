import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import postgres from 'postgres';

const ROW_COUNT = 10_000;
const QUERY_COUNT = 100;
const DIM = 3072;
const BENCH_FILE_PATH = 'bench://noop';

function randomVector(dim: number): number[] {
  const v = new Array<number>(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.random() * 2 - 1;
  return v;
}

function vectorToString(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL is not set in .env.local');
    process.exit(1);
  }

  const sql = postgres(databaseUrl, { max: 4 });

  try {
    console.log(`Inserting ${ROW_COUNT} synthetic embeddings...`);
    const insertStart = Date.now();
    for (let i = 0; i < ROW_COUNT; i++) {
      const vec = randomVector(DIM);
      await sql`
        INSERT INTO embeddings (file_name, file_type, file_path, chunk_index, embedding)
        VALUES (
          ${`bench-${i}.txt`},
          'text',
          ${BENCH_FILE_PATH},
          0,
          ${vectorToString(vec)}::vector(3072)
        )
      `;
      if (i > 0 && i % 1000 === 0) {
        console.log(`  inserted ${i} / ${ROW_COUNT}`);
      }
    }
    console.log(`Insert done in ${((Date.now() - insertStart) / 1000).toFixed(1)}s`);

    console.log(`\nRunning ${QUERY_COUNT} queries...`);
    const latencies: number[] = [];
    for (let i = 0; i < QUERY_COUNT; i++) {
      const queryVec = vectorToString(randomVector(DIM));
      const start = Date.now();
      await sql`
        SELECT id, 1 - (embedding::halfvec(3072) <=> ${queryVec}::halfvec(3072)) AS sim
        FROM embeddings
        ORDER BY embedding::halfvec(3072) <=> ${queryVec}::halfvec(3072)
        LIMIT 5
      `;
      latencies.push(Date.now() - start);
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    const max = latencies[latencies.length - 1];
    console.log(`\nResults (n=${QUERY_COUNT}):`);
    console.log(`  p50: ${p50}ms`);
    console.log(`  p95: ${p95}ms`);
    console.log(`  max: ${max}ms`);

    console.log('\nEXPLAIN ANALYZE on a sample query:');
    const sampleQuery = vectorToString(randomVector(DIM));
    const plan = await sql`
      EXPLAIN ANALYZE
      SELECT id FROM embeddings
      ORDER BY embedding::halfvec(3072) <=> ${sampleQuery}::halfvec(3072)
      LIMIT 5
    `;
    for (const row of plan) {
      console.log(' ', (row as { 'QUERY PLAN': string })['QUERY PLAN']);
    }
  } finally {
    console.log('\nCleaning up benchmark rows...');
    await sql`DELETE FROM embeddings WHERE file_path = ${BENCH_FILE_PATH}`;
    await sql.end();
  }
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
