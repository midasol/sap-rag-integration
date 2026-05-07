import { generateEmbedding, generateContentSummary } from './gemini';
import { uploadToGCS } from './gcs';
import { mapWithLimit } from './concurrency';
import {
  getFileCategory,
  getMimeType,
  extractTextFromPDF,
  chunkText,
  validateForEmbedding,
  getPDFPageCount,
  EMBEDDING_LIMITS,
} from './file-parser';
import { db } from './db';
import { embeddings } from './schema';

export interface EmbedResult {
  fileName: string;
  chunksCreated: number;
}

export async function embedFile(
  fileBuffer: Buffer,
  fileName: string
): Promise<EmbedResult> {
  const category = getFileCategory(fileName);
  const mimeType = getMimeType(fileName);

  // Validate format against Gemini Embedding API restrictions
  validateForEmbedding(fileName);

  // Upload to GCS
  const gcsUrl = await uploadToGCS(fileBuffer, fileName, mimeType);

  if (category === 'text') {
    const text = fileBuffer.toString('utf-8');
    const chunks = chunkText(text);

    await mapWithLimit(chunks, 3, async (chunk, i) => {
      const vector = await generateEmbedding(chunk, 'RETRIEVAL_DOCUMENT');
      await db.insert(embeddings).values({
        fileName,
        fileType: category,
        filePath: gcsUrl,
        chunkIndex: i,
        chunkText: chunk,
        embedding: vector,
        metadata: { totalChunks: chunks.length },
      });
    });

    return { fileName, chunksCreated: chunks.length };
  }

  if (category === 'pdf') {
    return embedPDF(fileBuffer, fileName, gcsUrl);
  }

  // Multimodal: image, audio, video
  const base64 = fileBuffer.toString('base64');
  const vector = await generateEmbedding(
    [{ inlineData: { mimeType, data: base64 } }],
    'RETRIEVAL_DOCUMENT'
  );
  const summary = await generateContentSummary(base64, mimeType);

  await db.insert(embeddings).values({
    fileName,
    fileType: category,
    filePath: gcsUrl,
    chunkIndex: 0,
    contentSummary: summary,
    embedding: vector,
    metadata: { mimeType },
  });

  return { fileName, chunksCreated: 1 };
}

/**
 * Split a PDF into chunks of maxPages pages using pdf-lib.
 * Returns an array of PDF buffers, each containing up to maxPages pages.
 */
async function splitPDF(
  fileBuffer: Buffer,
  maxPages: number
): Promise<Buffer[]> {
  const { PDFDocument } = await import('pdf-lib');
  const srcDoc = await PDFDocument.load(fileBuffer);
  const totalPages = srcDoc.getPageCount();
  const chunks: Buffer[] = [];

  for (let start = 0; start < totalPages; start += maxPages) {
    const end = Math.min(start + maxPages, totalPages);
    const newDoc = await PDFDocument.create();
    const pages = await newDoc.copyPages(
      srcDoc,
      Array.from({ length: end - start }, (_, i) => start + i)
    );
    for (const page of pages) {
      newDoc.addPage(page);
    }
    const pdfBytes = await newDoc.save();
    chunks.push(Buffer.from(pdfBytes));
  }

  return chunks;
}

/**
 * Embed a PDF file by splitting into 6-page chunks and embedding each
 * via the Gemini multimodal embedding API (application/pdf inlineData).
 *
 * Each chunk gets its own embedding vector. Extracted text per chunk
 * is stored as chunkText for RAG context.
 */
async function embedPDF(
  fileBuffer: Buffer,
  fileName: string,
  gcsUrl: string
): Promise<EmbedResult> {
  const pageCount = await getPDFPageCount(fileBuffer);
  const maxPages = EMBEDDING_LIMITS.pdf.maxPages;

  // Split PDF into chunks of up to 6 pages each
  const pdfChunks = pageCount <= maxPages
    ? [fileBuffer]
    : await splitPDF(fileBuffer, maxPages);

  await mapWithLimit(pdfChunks, 3, async (chunkBuffer, i) => {
    const base64 = chunkBuffer.toString('base64');

    // Multimodal PDF embedding (captures visual + text content)
    const vector = await generateEmbedding(
      [{ inlineData: { mimeType: 'application/pdf', data: base64 } }],
      'RETRIEVAL_DOCUMENT'
    );

    // Extract text for RAG context
    let contextText: string | null = null;
    try {
      const extracted = await extractTextFromPDF(chunkBuffer);
      if (extracted.trim()) {
        contextText = extracted;
      }
    } catch {
      // text extraction failed, will rely on AI summary
    }

    // Always generate AI visual summary for PDF chunks
    // This captures images, diagrams, screenshots that text extraction misses
    const summary = await generateContentSummary(base64, 'application/pdf');

    const startPage = i * maxPages + 1;
    const endPage = Math.min((i + 1) * maxPages, pageCount);

    await db.insert(embeddings).values({
      fileName,
      fileType: 'pdf',
      filePath: gcsUrl,
      chunkIndex: i,
      chunkText: contextText,
      contentSummary: summary,
      embedding: vector,
      metadata: {
        totalPages: pageCount,
        totalChunks: pdfChunks.length,
        pageRange: `${startPage}-${endPage}`,
        mimeType: 'application/pdf',
      },
    });
  });

  return { fileName, chunksCreated: pdfChunks.length };
}
