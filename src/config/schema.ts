import * as z from 'zod';
import { LOG_LEVELS } from '../utils/logger.js';

export const DEFAULT_REDIRECT_URI = 'http://localhost:8977/callback';

const optionalString = z
  .string()
  .transform((s) => s.trim())
  .transform((s) => (s === '' ? undefined : s))
  .optional();

/** Environment variables understood by netatmo-energy-mcp. Everything is optional. */
export const envSchema = z.object({
  NETATMO_CLIENT_ID: optionalString,
  NETATMO_CLIENT_SECRET: optionalString,
  NETATMO_REDIRECT_URI: optionalString.pipe(z.url().optional()),
  NETATMO_MCP_CONFIG_DIR: optionalString,
  NETATMO_MCP_LOG_LEVEL: optionalString.pipe(z.enum(LOG_LEVELS).optional()),
});

export type EnvConfig = z.infer<typeof envSchema>;
