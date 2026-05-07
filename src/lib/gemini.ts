import { GoogleGenAI } from '@google/genai';
import { env } from './env';

export const genai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

/**
 * Best-effort English detection: ASCII printable ratio ≥ 0.95.
 * Used by translateQueryToEnglish to skip the LLM round-trip for
 * queries that are already English.
 */
function isLikelyEnglish(text: string): boolean {
  if (text.length === 0) return true;
  const ascii = (text.match(/[ -~]/g) ?? []).length;
  return ascii / text.length >= 0.95;
}

export async function generateEmbedding(
  contents: string | Array<{ inlineData: { mimeType: string; data: string } }>,
  taskType?: string
): Promise<number[]> {
  const response = await genai.models.embedContent({
    model: env.GEMINI_EMBEDDING_MODEL,
    contents,
    config: {
      outputDimensionality: 3072,
      ...(taskType && { taskType }),
    },
  });

  const embedding = response.embeddings?.[0]?.values;
  if (!embedding) {
    throw new Error('Embedding response did not contain values');
  }
  return embedding;
}

/**
 * Detect the language of the text and translate to English.
 * Returns null if the text is already in English.
 */
export async function translateQueryToEnglish(text: string): Promise<string | null> {
  if (isLikelyEnglish(text)) return null;
  const response = await genai.models.generateContent({
    model: env.GEMINI_CHAT_MODEL,
    contents: [
      {
        text: `You are a translation assistant. Analyze the following text:
1. If the text is already in English, respond with exactly: __SAME__
2. Otherwise, translate it to English.

Output ONLY the translation or __SAME__, nothing else.

${text}`,
      },
    ],
  });
  const result = response.text?.trim() ?? '';
  if (result === '__SAME__') return null;
  return result;
}

export async function generateContentSummary(
  fileData: string,
  mimeType: string
): Promise<string> {
  const response = await genai.models.generateContent({
    model: env.GEMINI_CHAT_MODEL,
    contents: [
      { text: 'Describe the contents of this file in detail. Include text, colors, shapes, and features.' },
      { inlineData: { mimeType, data: fileData } },
    ],
  });
  return response.text ?? '';
}
