/**
 * Minimal stderr logger with secret redaction.
 *
 * stdout is reserved for the MCP JSON-RPC stream, so this logger never writes there.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogMeta = Record<string, unknown>;

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const SENSITIVE_KEY =
  /^(access_?token|refresh_?token|client_?secret|authorization|password|code_?verifier|auth_?code|token)$/i;

/** Netatmo tokens look like `<24 hex>|<32 hex>`. */
const TOKEN_PATTERN = /\b[0-9a-f]{24}\|[0-9a-f]{32}\b/gi;
const BEARER_PATTERN = /Bearer\s+[^\s"']+/gi;

export const REDACTED = '[REDACTED]';

/** Redact token-shaped substrings from free text. */
export function redactText(text: string): string {
  return text.replace(TOKEN_PATTERN, REDACTED).replace(BEARER_PATTERN, `Bearer ${REDACTED}`);
}

/** Deep-copy `value` with sensitive keys and token-shaped strings redacted. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[…]';
  if (typeof value === 'string') return redactText(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) && v != null && v !== '' ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Line sink. Defaults to stderr. */
  write?: (line: string) => void;
  now?: () => Date;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = RANK[options.level ?? 'info'];
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = options.now ?? (() => new Date());

  const log = (level: Exclude<LogLevel, 'silent'>, message: string, meta?: LogMeta) => {
    if (RANK[level] < threshold) return;
    let line = `${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${redactText(message)}`;
    if (meta && Object.keys(meta).length > 0) {
      line += ` ${JSON.stringify(redact(meta))}`;
    }
    write(line);
  };

  return {
    debug: (m, meta) => {
      log('debug', m, meta);
    },
    info: (m, meta) => {
      log('info', m, meta);
    },
    warn: (m, meta) => {
      log('warn', m, meta);
    },
    error: (m, meta) => {
      log('error', m, meta);
    },
  };
}

export const silentLogger: Logger = createLogger({ level: 'silent' });
