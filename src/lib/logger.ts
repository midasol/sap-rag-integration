import { mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import pino, { type Logger, type LoggerOptions, type DestinationStream } from 'pino';

const SENSITIVE_PATHS = [
  'Authorization',
  'authorization',
  'Cookie',
  'cookie',
  'password',
  'secret',
  'apiKey',
  'api_key',
  'client_secret',
  'access_token',
  'refresh_token',
  'code_verifier',
  'X-Api-Key',
  'x-api-key',
  '*.password',
  '*.Authorization',
  '*.access_token',
  '*.refresh_token',
];

function resolveLevel(): string {
  return (process.env.LOG_LEVEL ?? 'info').toLowerCase();
}

function resolveLogDir(): string {
  return process.env.LOG_DIR ?? './logs';
}

function baseOptions(): LoggerOptions {
  return {
    level: resolveLevel(),
    base: undefined,
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: SENSITIVE_PATHS,
      censor: '[REDACTED]',
    },
  };
}

function fileDestination(serviceName: string): DestinationStream {
  const dir = resolveLogDir();
  mkdirSync(dir, { recursive: true });
  return createWriteStream(join(dir, `${serviceName}.log`), { flags: 'a' });
}

export interface CreateLoggerOptions {
  serviceName?: string;
  destination?: DestinationStream;
}

/**
 * Create a pino logger. Used in tests with an in-memory destination, and
 * by `getLogger()` for the singleton process logger.
 */
export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const { serviceName = 'nextjs', destination } = opts;
  const target = destination ?? fileDestination(serviceName);

  if (process.env.LOG_FORMAT === 'pretty' && destination === undefined) {
    const pretty = pino.transport({
      targets: [
        { target: 'pino-pretty', level: resolveLevel(), options: { destination: 1 } },
        { target: 'pino/file', level: resolveLevel(), options: { destination: join(resolveLogDir(), `${serviceName}.log`), mkdir: true } },
      ],
    });
    return pino(baseOptions(), pretty);
  }

  return pino(baseOptions(), target);
}

let _singleton: Logger | null = null;

export function getLogger(): Logger {
  if (_singleton === null) {
    _singleton = createLogger({ serviceName: 'nextjs' });
  }
  return _singleton;
}

export function logPayloadFull(): boolean {
  return (process.env.LOG_PAYLOAD ?? 'meta').toLowerCase() === 'full';
}
