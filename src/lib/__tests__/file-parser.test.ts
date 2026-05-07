import { describe, it, expect } from 'vitest';
import {
  getFileCategory,
  validateForEmbedding,
  chunkText,
  getMimeType,
} from '../file-parser';

describe('getFileCategory', () => {
  it('returns "text" for .txt, .md, .csv, .json, .xml, .html', () => {
    for (const name of ['a.txt', 'a.md', 'a.csv', 'a.json', 'a.xml', 'a.html']) {
      expect(getFileCategory(name)).toBe('text');
    }
  });

  it('returns "pdf" for .pdf', () => {
    expect(getFileCategory('doc.pdf')).toBe('pdf');
  });

  it('returns "image" for png/jpg/jpeg/gif/webp/bmp', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']) {
      expect(getFileCategory(`img.${ext}`)).toBe('image');
    }
  });

  it('returns "audio" / "video" for known extensions', () => {
    expect(getFileCategory('a.mp3')).toBe('audio');
    expect(getFileCategory('v.mp4')).toBe('video');
  });

  it('throws "Unsupported file type" for unknown extensions', () => {
    expect(() => getFileCategory('weird.xyz')).toThrow(/Unsupported file type: \.xyz/);
  });
});

describe('validateForEmbedding', () => {
  it('rejects images outside the embedding API allow-list', () => {
    expect(() => validateForEmbedding('a.gif')).toThrow(/Unsupported image format/);
  });

  it('rejects videos outside the embedding API allow-list', () => {
    expect(() => validateForEmbedding('v.mov')).toThrow(/Unsupported video format/);
  });
});

describe('chunkText', () => {
  it('splits with overlap and respects maxChunkSize boundary', () => {
    const text = 'a'.repeat(2500);
    const chunks = chunkText(text, 1000, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toHaveLength(1000);
    expect(chunks[1].slice(0, 200)).toBe(chunks[0].slice(-200));
  });
});

describe('getMimeType', () => {
  it('maps known extensions and falls back to application/octet-stream', () => {
    expect(getMimeType('a.png')).toBe('image/png');
    expect(getMimeType('a.pdf')).toBe('application/pdf');
    expect(getMimeType('weird.qq')).toBe('application/octet-stream');
  });
});
