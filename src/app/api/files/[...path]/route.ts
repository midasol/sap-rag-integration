import { NextRequest, NextResponse } from 'next/server';
import { downloadFromGCS } from '@/lib/gcs';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: pathSegments } = await params;
  const gcsPath = pathSegments.join('/');

  try {
    const { buffer, contentType } = await downloadFromGCS(gcsPath);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}
