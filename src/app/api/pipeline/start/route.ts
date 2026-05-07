import { NextRequest, NextResponse } from 'next/server';
import { embedFile } from '@/lib/embedding-ingest';
import { getFileCategory } from '@/lib/file-parser';
import { resetStatus, updateStatus, addLog, getStatus } from '@/lib/pipeline-state';
import fs from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import { Storage } from '@google-cloud/storage';
import { env } from '@/lib/env';

export const maxDuration = 300;

// Allowed base directories for local pipeline processing
const ALLOWED_BASE_DIRS = [
  path.resolve('./data'),
  path.resolve('./uploads'),
];

function isPathAllowed(sourcePath: string): boolean {
  const resolved = path.resolve(sourcePath);
  return ALLOWED_BASE_DIRS.some((base) => resolved.startsWith(base + path.sep) || resolved === base);
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

function createStorage() {
  const keyFilePath = env.GOOGLE_APPLICATION_CREDENTIALS
    ? path.resolve(env.GOOGLE_APPLICATION_CREDENTIALS)
    : undefined;

  if (keyFilePath) {
    try {
      const credentials = JSON.parse(readFileSync(keyFilePath, 'utf-8'));
      return new Storage({ projectId: env.GCS_PROJECT_ID, credentials });
    } catch {
      return new Storage({ projectId: env.GCS_PROJECT_ID });
    }
  }
  return new Storage({ projectId: env.GCS_PROJECT_ID });
}

async function listGCSFiles(gcsPath: string): Promise<FileEntry[]> {
  const storage = createStorage();
  const { bucket, prefix } = parseGCSPath(gcsPath);
  const [files] = await storage.bucket(bucket).getFiles({
    prefix: prefix ? `${prefix}/` : undefined,
  });

  return files
    .filter((f) => !f.name.endsWith('/'))
    .map((f) => ({
      name: path.basename(f.name),
      read: async () => {
        const [buffer] = await f.download();
        return Buffer.from(buffer);
      },
    }));
}

async function listLocalFiles(dirPath: string): Promise<FileEntry[]> {
  const resolved = path.resolve(dirPath);
  const files = await fs.readdir(resolved);
  return files.map((f) => ({
    name: f,
    read: () => fs.readFile(path.join(resolved, f)),
  }));
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { sourcePath } = body;

    if (!sourcePath || typeof sourcePath !== 'string') {
      return NextResponse.json({ error: 'sourcePath is required and must be a string' }, { status: 400 });
    }

    if (isGCSPath(sourcePath)) {
      processFiles(sourcePath).catch((err) => {
        console.error('Pipeline failed:', err instanceof Error ? err.message : 'Unknown error');
        updateStatus({ running: false, currentFile: '' });
      });
      return NextResponse.json({ started: true });
    }

    // Local path
    if (!isPathAllowed(sourcePath)) {
      return NextResponse.json(
        { error: 'Access denied: sourcePath is not in an allowed directory' },
        { status: 403 }
      );
    }

    const resolved = path.resolve(sourcePath);
    try {
      await fs.access(resolved);
    } catch {
      return NextResponse.json({ error: 'sourcePath does not exist' }, { status: 404 });
    }

    processFiles(resolved).catch((err) => {
      console.error('Pipeline failed:', err instanceof Error ? err.message : 'Unknown error');
      updateStatus({ running: false, currentFile: '' });
    });

    return NextResponse.json({ started: true });
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
}

async function processFiles(sourcePath: string) {
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

  resetStatus(supportedFiles.length);

  const concurrency = 3;
  for (let i = 0; i < supportedFiles.length; i += concurrency) {
    const batch = supportedFiles.slice(i, i + concurrency);
    await Promise.allSettled(
      batch.map(async (file) => {
        updateStatus({ currentFile: file.name });
        const start = Date.now();

        let retries = 3;
        while (retries > 0) {
          try {
            const buffer = await file.read();
            await embedFile(buffer, file.name);
            const duration = Date.now() - start;
            const current = getStatus();
            updateStatus({ completed: current.completed + 1, succeeded: current.succeeded + 1 });
            addLog({ fileName: file.name, status: 'success', duration });
            return;
          } catch (err) {
            retries--;
            if (retries === 0) {
              const duration = Date.now() - start;
              const current = getStatus();
              updateStatus({ completed: current.completed + 1, failed: current.failed + 1 });
              addLog({ fileName: file.name, status: 'error', message: String(err), duration });
            }
          }
        }
      })
    );
  }

  updateStatus({ running: false, currentFile: '' });
}
