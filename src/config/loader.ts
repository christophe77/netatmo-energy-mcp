import type { LogLevel } from '../utils/logger.js';
import { configPaths, resolveConfigDir, type ConfigPaths } from './paths.js';
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
}

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
  };
}
