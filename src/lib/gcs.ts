import { Storage } from '@google-cloud/storage';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { env } from './env';

function createStorage() {
  const keyFilePath = env.GOOGLE_APPLICATION_CREDENTIALS
    ? path.resolve(env.GOOGLE_APPLICATION_CREDENTIALS)
    : undefined;

  if (keyFilePath && fs.existsSync(keyFilePath)) {
    let credentials;
    try {
      credentials = JSON.parse(fs.readFileSync(keyFilePath, 'utf-8'));
    } catch (err) {
      throw new Error(`Failed to parse service account JSON at ${keyFilePath}: ${err}`);
    }
    return new Storage({
      projectId: env.GCS_PROJECT_ID,
      credentials,
    });
  }

  return new Storage({
    projectId: env.GCS_PROJECT_ID,
  });
}

const storage = createStorage();
const bucketName = env.GCS_BUCKET_NAME;
const bucket = storage.bucket(bucketName);

const ALLOWED_GCS_PREFIX = 'uploads/';

export async function uploadToGCS(
  fileBuffer: Buffer,
  originalName: string,
  mimeType: string
): Promise<string> {
  const ext = path.extname(originalName);
  const gcsPath = `${ALLOWED_GCS_PREFIX}${uuidv4()}${ext}`;
  const file = bucket.file(gcsPath);

  await file.save(fileBuffer, {
    metadata: { contentType: mimeType },
  });

  return `/api/files/${encodeURIComponent(gcsPath)}`;
}

export async function downloadFromGCS(gcsPath: string): Promise<{ buffer: Buffer; contentType: string }> {
  // Path traversal prevention: only allow files under uploads/
  const normalized = path.posix.normalize(gcsPath);
  if (!normalized.startsWith(ALLOWED_GCS_PREFIX) || normalized.includes('..')) {
    throw new Error('Access denied: invalid file path');
  }

  const file = bucket.file(normalized);
  const [buffer] = await file.download();
  const [metadata] = await file.getMetadata();
  return {
    buffer: Buffer.from(buffer),
    contentType: (metadata.contentType as string) ?? 'application/octet-stream',
  };
}
