import { NextResponse } from 'next/server';
import { getStatus } from '@/lib/pipeline-state';

export async function GET() {
  return NextResponse.json(getStatus());
}
