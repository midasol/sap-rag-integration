function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  get GEMINI_API_KEY() { return requireEnv('GEMINI_API_KEY'); },
  get DATABASE_URL() { return requireEnv('DATABASE_URL'); },
  get GCS_BUCKET_NAME() { return requireEnv('GCS_BUCKET_NAME'); },
  get GCS_PROJECT_ID() { return requireEnv('GCS_PROJECT_ID'); },
  get GOOGLE_APPLICATION_CREDENTIALS() { return process.env.GOOGLE_APPLICATION_CREDENTIALS; },
  get GEMINI_EMBEDDING_MODEL() { return process.env.GEMINI_EMBEDDING_MODEL ?? 'gemini-embedding-2-preview'; },
  get GEMINI_CHAT_MODEL() { return process.env.GEMINI_CHAT_MODEL ?? 'gemini-3.1-pro-preview'; },
  get SAP_SESSION_SECRET() { return requireEnv('SAP_SESSION_SECRET'); },
};
