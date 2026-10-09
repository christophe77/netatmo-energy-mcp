import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import {
  DEFAULT_WRITE_LIMITS,
  type ConfirmMode,
  type WriteLimits,
} from '../../src/domain/write-limits.js';
import type { Account } from './account.js';

/** Bindings, variables and secrets of the remote server (see remote/README.md). */
export interface Env {
  OAUTH_KV: KVNamespace;
  ACCOUNTS: DurableObjectNamespace<Account>;
  OAUTH_PROVIDER: OAuthHelpers;

  /** Public https origin of this Worker, e.g. https://netatmo-energy-mcp.<account>.workers.dev */
  PUBLIC_URL: string;
  /** Owner sign-in on the consent page (secret, 12+ characters). */
  OWNER_PASSWORD?: string;
  /** Authenticates `netatmo-energy-mcp remote setup` (secret, 12+ characters). */
  SETUP_TOKEN?: string;
  /** 32 random bytes, base64: encrypts Netatmo secrets at rest (secret). */
  DATA_KEY?: string;

  /** off | invite | open (ADR-0014). Only "off" is implemented in this version. */
  ONBOARDING?: string;
  NETATMO_MCP_WRITE?: string;
  NETATMO_MCP_CONFIRM?: string;
  NETATMO_MCP_MIN_TEMP?: string;
  NETATMO_MCP_MAX_TEMP?: string;
  NETATMO_MCP_MAX_SETPOINT_HOURS?: string;
  LOG_LEVEL?: string;
  /** Tests only: loopback base URL standing in for https://api.netatmo.com. */
  NETATMO_API_BASE?: string;
}

function numberVar(
  value: string | undefined,
  min: number,
  max: number,
  name: string,
): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}.`);
  }
  return n;
}

/** Same limits and validation as the local server's environment variables (ADR-0012). */
export function writeLimits(env: Env): WriteLimits {
  const minTemp =
    numberVar(env.NETATMO_MCP_MIN_TEMP, 5, 30, 'NETATMO_MCP_MIN_TEMP') ??
    DEFAULT_WRITE_LIMITS.minTemp;
  const maxTemp =
    numberVar(env.NETATMO_MCP_MAX_TEMP, 5, 30, 'NETATMO_MCP_MAX_TEMP') ??
    DEFAULT_WRITE_LIMITS.maxTemp;
  if (minTemp >= maxTemp)
    throw new Error('NETATMO_MCP_MIN_TEMP must be lower than NETATMO_MCP_MAX_TEMP.');
  const maxSetpointHours =
    numberVar(env.NETATMO_MCP_MAX_SETPOINT_HOURS, 0.25, 720, 'NETATMO_MCP_MAX_SETPOINT_HOURS') ??
    DEFAULT_WRITE_LIMITS.maxSetpointHours;
  return {
    minTemp,
    maxTemp,
    maxSetpointHours,
    defaultSetpointHours: Math.min(DEFAULT_WRITE_LIMITS.defaultSetpointHours, maxSetpointHours),
  };
}

/** Remote default is "token": ChatGPT shows no MCP dialogs; Claude asks per tool itself. */
export function confirmMode(env: Env): ConfirmMode {
  const mode = env.NETATMO_MCP_CONFIRM ?? 'token';
  if (mode !== 'auto' && mode !== 'elicitation' && mode !== 'token') {
    throw new Error('NETATMO_MCP_CONFIRM must be auto, elicitation or token.');
  }
  return mode;
}
