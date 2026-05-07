import { NextRequest, NextResponse } from 'next/server';
import { embedFile } from '@/lib/embedding-ingest';
import { getFileCategory } from '@/lib/file-parser';
import { resetStatus, updateStatus, addLog, getStatus } from '@/lib/pipeline-state';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const files = formData.getAll('files') as File[];

    if (files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    const supportedFiles = files.filter((f) => {
      if (f.size > MAX_FILE_SIZE) return false;
      try {
        getFileCategory(f.name);
        return true;
      } catch {
        return false;
      }
    });

    if (supportedFiles.length === 0) {
      return NextResponse.json({ error: 'No supported files found' }, { status: 400 });
    }

    // Read all file buffers upfront before starting background processing
    const fileEntries = await Promise.all(
      supportedFiles.map(async (f) => ({
        name: f.name,
        buffer: Buffer.from(await f.arrayBuffer()),
      }))
    );

    // Start background processing
    processUploadedFiles(fileEntries).catch((err) => {
      console.error('Upload pipeline failed:', err instanceof Error ? err.message : 'Unknown error');
      updateStatus({ running: false, currentFile: '' });
    });

    return NextResponse.json({ started: true, total: fileEntries.length });
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}

async function processUploadedFiles(files: Array<{ name: string; buffer: Buffer }>) {
  resetStatus(files.length);

  const concurrency = 3;
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    await Promise.allSettled(
      batch.map(async (file) => {
        updateStatus({ currentFile: file.name });
        const start = Date.now();

        try {
          await embedFile(file.buffer, file.name);
          const duration = Date.now() - start;
          const current = getStatus();
          updateStatus({ completed: current.completed + 1, succeeded: current.succeeded + 1 });
          addLog({ fileName: file.name, status: 'success', duration });
        } catch (err) {
          const duration = Date.now() - start;
          const current = getStatus();
          updateStatus({ completed: current.completed + 1, failed: current.failed + 1 });
          addLog({ fileName: file.name, status: 'error', message: String(err), duration });
        }
      })
    );
  }

  updateStatus({ running: false, currentFile: '' });
}
