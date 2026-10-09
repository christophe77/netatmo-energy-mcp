import * as z from 'zod';
import { LOG_LEVELS } from '../utils/logger.js';

export const DEFAULT_REDIRECT_URI = 'http://localhost:8977/callback';

const optionalString = z
  .string()
  .transform((s) => s.trim())
  .transform((s) => (s === '' ? undefined : s))
  .optional();

/** Optional numeric variable within [min, max]. */
const optionalNumber = (min: number, max: number) =>
  optionalString
    .transform((v) => (v === undefined ? undefined : Number(v)))
    .pipe(z.number().min(min).max(max).optional());

/** Environment variables understood by netatmo-energy-mcp. Everything is optional. */
export const envSchema = z.object({
  NETATMO_CLIENT_ID: optionalString,
  NETATMO_CLIENT_SECRET: optionalString,
  NETATMO_REDIRECT_URI: optionalString.pipe(z.url().optional()),
  NETATMO_MCP_CONFIG_DIR: optionalString,
  NETATMO_MCP_LOG_LEVEL: optionalString.pipe(z.enum(LOG_LEVELS).optional()),
  /** '0' forces read-only operation even with a write-capable token (ADR-0012). */
  NETATMO_MCP_WRITE: optionalString.pipe(z.enum(['0', '1']).optional()),
  /** 'elicitation': client dialog only; 'token': preview + token only (see ConfirmMode). */
  /** CLI only: authenticates `remote setup|status` against the remote server (ADR-0014). */
  NETATMO_MCP_SETUP_TOKEN: optionalString,
  NETATMO_MCP_CONFIRM: optionalString.pipe(z.enum(['auto', 'elicitation', 'token']).optional()),
  NETATMO_MCP_MIN_TEMP: optionalNumber(5, 30),
  NETATMO_MCP_MAX_TEMP: optionalNumber(5, 30),
  NETATMO_MCP_MAX_SETPOINT_HOURS: optionalNumber(0.25, 720),
});

export { DEFAULT_WRITE_LIMITS } from '../domain/write-limits.js';

export type EnvConfig = z.infer<typeof envSchema>;
