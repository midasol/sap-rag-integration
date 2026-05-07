import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to define mocks before vi.mock
const { embedContentMock, generateContentMock } = vi.hoisted(() => ({
  embedContentMock: vi.fn(),
  generateContentMock: vi.fn(),
}));

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class {
      models: { embedContent: typeof embedContentMock; generateContent: typeof generateContentMock };
      constructor() {
        this.models = {
          embedContent: embedContentMock,
          generateContent: generateContentMock,
        };
      }
    },
  };
});

// Import AFTER vi.mock so the module picks up the mocked constructor.
import { generateEmbedding, translateQueryToEnglish } from '../gemini';

describe('generateEmbedding', () => {
  beforeEach(() => {
    embedContentMock.mockReset();
  });

  it('returns the first embedding values from the response', async () => {
    embedContentMock.mockResolvedValue({ embeddings: [{ values: [0.1, 0.2, 0.3] }] });
    const vec = await generateEmbedding('hello', 'RETRIEVAL_QUERY');
    expect(vec).toEqual([0.1, 0.2, 0.3]);
  });

  it('throws when the response has no embedding values', async () => {
    embedContentMock.mockResolvedValue({ embeddings: [] });
    await expect(generateEmbedding('hello')).rejects.toThrow(
      /Embedding response did not contain values/,
    );
  });
});

describe('translateQueryToEnglish', () => {
  beforeEach(() => {
    generateContentMock.mockReset();
  });

  it('returns null without calling the LLM when text is ≥95% ASCII', async () => {
    expect(await translateQueryToEnglish('Hello, how are you today?')).toBeNull();
    expect(generateContentMock).not.toHaveBeenCalled();
  });

  it('returns null when the model responds with __SAME__ (non-English path)', async () => {
    generateContentMock.mockResolvedValue({ text: '__SAME__' });
    expect(await translateQueryToEnglish('한국어 query 입력')).toBeNull();
    expect(generateContentMock).toHaveBeenCalledOnce();
  });

  it('returns the trimmed translation when the model responds with text', async () => {
    generateContentMock.mockResolvedValue({ text: '  Hello world\n' });
    expect(await translateQueryToEnglish('안녕하세요')).toBe('Hello world');
    expect(generateContentMock).toHaveBeenCalledOnce();
  });

  it('treats empty string as English (no LLM call)', async () => {
    expect(await translateQueryToEnglish('')).toBeNull();
    expect(generateContentMock).not.toHaveBeenCalled();
  });
});
