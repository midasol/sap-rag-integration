import { describe, it, expect, vi, beforeEach } from 'vitest';

const { insertValuesMock, insertMock, generateEmbeddingMock, generateContentSummaryMock } = vi.hoisted(() => {
  const insertValuesMock = vi.fn().mockResolvedValue(undefined);
  const insertMock = vi.fn(() => ({ values: insertValuesMock }));
  const generateEmbeddingMock = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
  const generateContentSummaryMock = vi.fn().mockResolvedValue('summary');
  return { insertValuesMock, insertMock, generateEmbeddingMock, generateContentSummaryMock };
});

vi.mock('@/lib/db', () => ({
  db: { insert: insertMock },
}));

vi.mock('../gcs', () => ({
  uploadToGCS: vi.fn().mockResolvedValue('/api/files/test'),
}));

vi.mock('../gemini', () => ({
  generateEmbedding: generateEmbeddingMock,
  generateContentSummary: generateContentSummaryMock,
}));

vi.mock('../file-parser', async () => {
  const actual =
    await vi.importActual<typeof import('../file-parser')>('../file-parser');
  return {
    ...actual,
    extractTextFromPDF: vi.fn().mockResolvedValue('extracted text'),
    getPDFPageCount: vi.fn().mockResolvedValue(8),
  };
});

vi.mock('pdf-lib', () => {
  const fakeSavedBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  return {
    PDFDocument: {
      load: vi.fn().mockResolvedValue({
        getPageCount: () => 8,
        copyPages: vi.fn().mockResolvedValue([{}, {}, {}, {}, {}, {}]),
      }),
      create: vi.fn().mockResolvedValue({
        copyPages: vi.fn().mockResolvedValue([]),
        addPage: vi.fn(),
        save: vi.fn().mockResolvedValue(fakeSavedBytes),
      }),
    },
  };
});

import { embedFile } from '../embedding-ingest';

describe('embedFile — text branch', () => {
  beforeEach(() => {
    insertMock.mockClear();
    insertValuesMock.mockClear();
    generateEmbeddingMock.mockClear();
  });

  it('chunks text and creates one embedding per chunk', async () => {
    const buffer = Buffer.from('a'.repeat(2500));
    const result = await embedFile(buffer, 'doc.txt');
    expect(result.fileName).toBe('doc.txt');
    expect(result.chunksCreated).toBeGreaterThan(1);
    expect(generateEmbeddingMock).toHaveBeenCalledTimes(result.chunksCreated);
  });

  it('inserts each chunk into the embeddings table', async () => {
    const buffer = Buffer.from('a'.repeat(2500));
    const result = await embedFile(buffer, 'doc.txt');
    expect(insertValuesMock).toHaveBeenCalledTimes(result.chunksCreated);
  });
});

describe('embedFile — multimodal branch', () => {
  beforeEach(() => {
    insertMock.mockClear();
    insertValuesMock.mockClear();
    generateEmbeddingMock.mockClear();
    generateContentSummaryMock.mockClear();
  });

  it('embeds an image with one embedding + content summary', async () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const result = await embedFile(buffer, 'pic.png');
    expect(result.chunksCreated).toBe(1);
    expect(generateEmbeddingMock).toHaveBeenCalledOnce();
    expect(generateContentSummaryMock).toHaveBeenCalledOnce();
    expect(insertValuesMock).toHaveBeenCalledOnce();
  });

  it('embeds an audio file with one embedding + content summary', async () => {
    const buffer = Buffer.from([0xff, 0xfb]);
    const result = await embedFile(buffer, 'sound.mp3');
    expect(result.chunksCreated).toBe(1);
  });
});

describe('embedFile — PDF branch', () => {
  beforeEach(() => {
    insertMock.mockClear();
    insertValuesMock.mockClear();
    generateEmbeddingMock.mockClear();
  });

  it('splits an 8-page PDF into 2 chunks of <=6 pages each', async () => {
    const buffer = Buffer.from([0x25, 0x50, 0x44, 0x46]);
    const result = await embedFile(buffer, 'doc.pdf');
    expect(result.chunksCreated).toBe(2);
    expect(generateEmbeddingMock).toHaveBeenCalledTimes(2);
  });

  it('inserts pageRange metadata for each PDF chunk', async () => {
    const buffer = Buffer.from([0x25, 0x50, 0x44, 0x46]);
    await embedFile(buffer, 'doc.pdf');
    const calls = insertValuesMock.mock.calls.map((c) => c[0]);
    expect(calls[0].metadata).toMatchObject({
      pageRange: '1-6',
      mimeType: 'application/pdf',
    });
    expect(calls[1].metadata).toMatchObject({ pageRange: '7-8' });
  });
});

describe('embedFile — concurrency', () => {
  beforeEach(() => {
    insertMock.mockClear();
    insertValuesMock.mockClear();
    generateEmbeddingMock.mockClear();
  });

  it('processes chunks concurrently with limit ≤ 3', async () => {
    let inFlight = 0;
    let maxObserved = 0;
    generateEmbeddingMock.mockImplementation(async () => {
      inFlight++;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return [0.1, 0.2, 0.3];
    });
    // ~7000 chars of text → 4 chunks at chunkText defaults (2000 size, 200 overlap)
    const buffer = Buffer.from('a'.repeat(7000));
    await embedFile(buffer, 'doc.txt');
    expect(maxObserved).toBeLessThanOrEqual(3);
    expect(maxObserved).toBeGreaterThan(1); // proves they ARE running concurrently
  });
});
