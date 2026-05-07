import { NextRequest, NextResponse } from 'next/server';
import { embedFile } from '@/lib/embedding-ingest';
import { getFileCategory } from '@/lib/file-parser';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: 'File size exceeds 100MB limit' }, { status: 400 });
    }

    if (!file.name || file.name.length === 0) {
      return NextResponse.json({ error: 'File name is required' }, { status: 400 });
    }

    try {
      getFileCategory(file.name);
    } catch {
      return NextResponse.json({ error: `Unsupported file type: ${file.name}` }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await embedFile(buffer, file.name);

    return NextResponse.json({
      success: true,
      fileName: result.fileName,
      chunksCreated: result.chunksCreated,
    });
  } catch (err) {
    console.error('POST /api/embed error:', err instanceof Error ? err.message : 'Unknown error');
    return NextResponse.json({ error: 'Failed to embed file' }, { status: 500 });
  }
}
