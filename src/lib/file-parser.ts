const TEXT_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.xml', '.html'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a'];
const VIDEO_EXTENSIONS = ['.mp4', '.mpeg', '.webm', '.avi', '.mov'];
const PDF_EXTENSIONS = ['.pdf'];

export type FileCategory = 'text' | 'pdf' | 'image' | 'audio' | 'video';

// Gemini Embedding API restrictions
// https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/embedding-2
export const EMBEDDING_LIMITS = {
  image: {
    formats: ['.png', '.jpg', '.jpeg'] as string[],
    maxPerRequest: 6,
    description: 'PNG, JPEG',
  },
  audio: {
    formats: ['.mp3', '.wav'] as string[],
    maxDurationSec: 80,
    description: 'MP3, WAV (max 80 seconds)',
  },
  video: {
    formats: ['.mp4', '.mpeg'] as string[],
    maxDurationSecWithAudio: 80,
    maxDurationSecWithoutAudio: 120,
    description: 'MP4, MPEG (max 80s with audio / 120s without audio)',
  },
  pdf: {
    maxPages: 6,
    description: 'PDF (max 6 pages for direct multimodal embedding)',
  },
  text: {
    maxTokens: 8192,
    description: 'Up to 8,192 tokens',
  },
  maxInputTokens: 8192,
};

export function getFileCategory(fileName: string): FileCategory {
  const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
  if (TEXT_EXTENSIONS.includes(ext)) return 'text';
  if (PDF_EXTENSIONS.includes(ext)) return 'pdf';
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  throw new Error(`Unsupported file type: ${ext}`);
}

/**
 * Validates file format against Gemini Embedding API restrictions.
 * Throws if the format is not supported by the embedding model.
 */
export function validateForEmbedding(fileName: string): void {
  const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
  const category = getFileCategory(fileName);

  if (category === 'image' && !EMBEDDING_LIMITS.image.formats.includes(ext)) {
    throw new Error(
      `Unsupported image format for embedding: ${ext}. ` +
      `Gemini Embedding API supports: ${EMBEDDING_LIMITS.image.description}`
    );
  }
  if (category === 'audio' && !EMBEDDING_LIMITS.audio.formats.includes(ext)) {
    throw new Error(
      `Unsupported audio format for embedding: ${ext}. ` +
      `Gemini Embedding API supports: ${EMBEDDING_LIMITS.audio.description}`
    );
  }
  if (category === 'video' && !EMBEDDING_LIMITS.video.formats.includes(ext)) {
    throw new Error(
      `Unsupported video format for embedding: ${ext}. ` +
      `Gemini Embedding API supports: ${EMBEDDING_LIMITS.video.description}`
    );
  }
}

export function getMimeType(fileName: string): string {
  const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'));
  const mimeMap: Record<string, string> = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
    '.json': 'application/json', '.xml': 'application/xml', '.html': 'text/html',
    '.pdf': 'application/pdf',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.flac': 'audio/flac', '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4', '.mpeg': 'video/mpeg', '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
  };
  return mimeMap[ext] ?? 'application/octet-stream';
}

/**
 * Returns the page count of a PDF buffer.
 */
export async function getPDFPageCount(buffer: Buffer): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { PDFParse } = await import('pdf-parse') as { PDFParse: any };
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  await parser.load();
  const result = await parser.getText();
  return result.total;
}

export async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { PDFParse } = await import('pdf-parse') as { PDFParse: any };
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  await parser.load();
  const result = await parser.getText();
  return result.text ?? '';
}

export function chunkText(text: string, maxChunkSize = 2000, overlap = 200): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChunkSize, text.length);
    chunks.push(text.slice(start, end));
    start = end - overlap;
    if (start + overlap >= text.length) break;
  }
  return chunks;
}
