import type { LogLevel } from '../utils/logger.js';
import { configPaths, resolveConfigDir, type ConfigPaths } from './paths.js';
import {
  DEFAULT_WRITE_LIMITS,
  type ConfirmMode,
  type WriteLimits,
} from '../domain/write-limits.js';
import { DEFAULT_REDIRECT_URI, envSchema } from './schema.js';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface AppConfig {
  paths: ConfigPaths;
  /** Client credentials from the environment. They take precedence over stored ones. */
  envClient: { clientId?: string; clientSecret?: string };
  redirectUri: string;
  logLevel: LogLevel;
  /** "off" when NETATMO_MCP_WRITE=0; otherwise write mode follows the granted token scope. */
  write: 'auto' | 'off';
  /** How changes are confirmed: 'auto' (elicitation, else a preview token) or 'elicitation' only. */
  confirm: ConfirmMode;
  limits: WriteLimits;
  /** Remote server SETUP_TOKEN for `remote setup|status` (never printed). */
  setupToken?: string;
}

// Runtime-neutral types, shared with the remote server (ADR-0014).
export type { ConfirmMode, WriteLimits } from '../domain/write-limits.js';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;
  const envClient: AppConfig['envClient'] = {};
  if (e.NETATMO_CLIENT_ID) envClient.clientId = e.NETATMO_CLIENT_ID;
  if (e.NETATMO_CLIENT_SECRET) envClient.clientSecret = e.NETATMO_CLIENT_SECRET;

  return {
    paths: configPaths(
      resolveConfigDir({ ...env, NETATMO_MCP_CONFIG_DIR: e.NETATMO_MCP_CONFIG_DIR }),
    ),
    envClient,
    redirectUri: e.NETATMO_REDIRECT_URI ?? DEFAULT_REDIRECT_URI,
    logLevel: e.NETATMO_MCP_LOG_LEVEL ?? 'info',
    write: e.NETATMO_MCP_WRITE === '0' ? 'off' : 'auto',
    confirm: e.NETATMO_MCP_CONFIRM ?? 'auto',
    limits: writeLimits(e),
    ...(e.NETATMO_MCP_SETUP_TOKEN !== undefined && { setupToken: e.NETATMO_MCP_SETUP_TOKEN }),
  };
}

function writeLimits(e: {
  NETATMO_MCP_MIN_TEMP?: number | undefined;
  NETATMO_MCP_MAX_TEMP?: number | undefined;
  NETATMO_MCP_MAX_SETPOINT_HOURS?: number | undefined;
}): WriteLimits {
  const minTemp = e.NETATMO_MCP_MIN_TEMP ?? DEFAULT_WRITE_LIMITS.minTemp;
  const maxTemp = e.NETATMO_MCP_MAX_TEMP ?? DEFAULT_WRITE_LIMITS.maxTemp;
  if (minTemp >= maxTemp) {
    throw new ConfigError('NETATMO_MCP_MIN_TEMP must be lower than NETATMO_MCP_MAX_TEMP.');
  }
  const maxSetpointHours =
    e.NETATMO_MCP_MAX_SETPOINT_HOURS ?? DEFAULT_WRITE_LIMITS.maxSetpointHours;
  return {
    minTemp,
    maxTemp,
    maxSetpointHours,
    defaultSetpointHours: Math.min(DEFAULT_WRITE_LIMITS.defaultSetpointHours, maxSetpointHours),
  };
}
