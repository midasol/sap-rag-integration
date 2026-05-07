import { describe, it, expect, vi, beforeEach } from 'vitest';

const { embedFileMock, fsAccessMock, fsReaddirMock, fsReadFileMock, gcsGetFilesMock } = vi.hoisted(() => {
  const embedFileMock = vi.fn().mockResolvedValue({ fileName: 'x', chunksCreated: 1 });
  const fsAccessMock = vi.fn().mockResolvedValue(undefined);
  const fsReaddirMock = vi.fn().mockResolvedValue([]);
  const fsReadFileMock = vi.fn().mockResolvedValue(Buffer.from('x'));
  const gcsGetFilesMock = vi.fn().mockResolvedValue([[]]);
  return { embedFileMock, fsAccessMock, fsReaddirMock, fsReadFileMock, gcsGetFilesMock };
});

vi.mock('@/lib/embedding', () => ({
  embedFile: embedFileMock,
}));

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...actual,
    default: {
      ...actual,
      access: fsAccessMock,
      readdir: fsReaddirMock,
      readFile: fsReadFileMock,
    },
    access: fsAccessMock,
    readdir: fsReaddirMock,
    readFile: fsReadFileMock,
  };
});

vi.mock('@google-cloud/storage', () => ({
  Storage: vi.fn().mockImplementation(() => ({
    bucket: () => ({ getFiles: gcsGetFilesMock }),
  })),
}));

import { POST } from '../route';

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/pipeline/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/pipeline/start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsAccessMock.mockResolvedValue(undefined);
    fsReaddirMock.mockResolvedValue([]);
    fsReadFileMock.mockResolvedValue(Buffer.from('x'));
    gcsGetFilesMock.mockResolvedValue([[]]);
    embedFileMock.mockResolvedValue({ fileName: 'x', chunksCreated: 1 });
  });

  it('400 when sourcePath is missing', async () => {
    const res = await POST(jsonRequest({}) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: /sourcePath is required/ });
  });

  it('400 when body is invalid JSON', async () => {
    const req = new Request('http://localhost/api/pipeline/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{nope',
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  it('403 when local path is outside ALLOWED_BASE_DIRS', async () => {
    const res = await POST(jsonRequest({ sourcePath: '/etc/passwd' }) as never);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: /Access denied/ });
  });

  it('200 with started:true when local path is inside ./data', async () => {
    const res = await POST(jsonRequest({ sourcePath: './data' }) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ started: true });
  });

  it('200 with started:true when sourcePath is a gs:// URI (bypasses local allow-list)', async () => {
    const res = await POST(
      jsonRequest({ sourcePath: 'gs://test-bucket/prefix' }) as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ started: true });
  });

  it('404 when local path does not exist on disk', async () => {
    fsAccessMock.mockRejectedValueOnce(new Error('ENOENT'));
    const res = await POST(jsonRequest({ sourcePath: './data/missing' }) as never);
    expect(res.status).toBe(404);
  });
});
