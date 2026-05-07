import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

import { Storage } from '@google-cloud/storage';
import { embedFile } from '../lib/embedding-ingest';
import { getFileCategory } from '../lib/file-parser';
import { env } from '../lib/env';

function createStorage() {
  const keyFilePath = env.GOOGLE_APPLICATION_CREDENTIALS
    ? path.resolve(env.GOOGLE_APPLICATION_CREDENTIALS)
    : undefined;

  if (keyFilePath) {
    const credentials = JSON.parse(readFileSync(keyFilePath, 'utf-8'));
    return new Storage({ projectId: env.GCS_PROJECT_ID, credentials });
  }
  return new Storage({ projectId: env.GCS_PROJECT_ID });
}

function isGCSPath(p: string): boolean {
  return p.startsWith('gs://');
}

function parseGCSPath(gcsPath: string): { bucket: string; prefix: string } {
  const withoutScheme = gcsPath.replace('gs://', '');
  const slashIndex = withoutScheme.indexOf('/');
  if (slashIndex === -1) {
    return { bucket: withoutScheme, prefix: '' };
  }
  return {
    bucket: withoutScheme.substring(0, slashIndex),
    prefix: withoutScheme.substring(slashIndex + 1).replace(/\/$/, ''),
  };
}

interface FileEntry {
  name: string;
  read: () => Promise<Buffer>;
}

async function listLocalFiles(dirPath: string): Promise<FileEntry[]> {
  const resolvedPath = path.resolve(dirPath);
  const files = await fs.readdir(resolvedPath);
  return files.map((f) => ({
    name: f,
    read: () => fs.readFile(path.join(resolvedPath, f)),
  }));
}

async function listGCSFiles(gcsPath: string): Promise<FileEntry[]> {
  const storage = createStorage();
  const { bucket, prefix } = parseGCSPath(gcsPath);
  const [files] = await storage.bucket(bucket).getFiles({
    prefix: prefix ? `${prefix}/` : undefined,
  });

  return files
    .filter((f) => !f.name.endsWith('/')) // skip directories
    .map((f) => ({
      name: path.basename(f.name),
      read: async () => {
        const [buffer] = await f.download();
        return Buffer.from(buffer);
      },
    }));
}

async function main() {
  const sourcePath = process.argv[2];
  if (!sourcePath) {
    console.error('Usage: npx tsx src/scripts/pipeline.ts <source-path>');
    console.error('  source-path: local directory or gs://bucket/prefix');
    process.exit(1);
  }

  console.log(`Scanning: ${sourcePath}`);

  const allFiles = isGCSPath(sourcePath)
    ? await listGCSFiles(sourcePath)
    : await listLocalFiles(sourcePath);

  const supportedFiles = allFiles.filter((f) => {
    try {
      getFileCategory(f.name);
      return true;
    } catch {
      return false;
    }
  });

  console.log(`Found ${supportedFiles.length} supported files (of ${allFiles.length} total)`);

  let succeeded = 0;
  let failed = 0;
  const concurrency = 3;

  for (let i = 0; i < supportedFiles.length; i += concurrency) {
    const batch = supportedFiles.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        console.log(`⏳ ${file.name} - downloading...`);
        const buffer = await file.read();
        console.log(`⏳ ${file.name} - embedding (${(buffer.length / 1024 / 1024).toFixed(1)}MB)...`);
        const result = await embedFile(buffer, file.name);
        console.log(`✅ ${file.name} (${result.chunksCreated} chunks)`);
        return result;
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') succeeded++;
      else {
        failed++;
        console.error(`❌ ${r.reason}`);
      }
    }
  }

  console.log(`\nDone: ${succeeded} succeeded, ${failed} failed`);
}

main().catch(console.error);
