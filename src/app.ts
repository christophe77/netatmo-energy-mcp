import path from 'node:path';
import { CredentialStore, type StoredCredentials } from './auth/credential-store.js';
import type { FetchFn } from './auth/oauth.js';
import { TokenManager } from './auth/token-manager.js';
import type { AppConfig } from './config/loader.js';
import { FileAuditLog } from './local/file-audit-log.js';
import { createServices, type Services } from './domain/services.js';
import { NetatmoClient, type NetatmoClientOptions } from './netatmo/client.js';
import { RateLimiter, type RateWindow } from './netatmo/rate-limiter.js';
import { WRITE_SCOPE } from './netatmo/write-endpoints.js';
import { systemClock, type Clock } from './utils/clock.js';
import type { Logger } from './utils/logger.js';

export interface Runtime extends Services {
  store: CredentialStore;
  tokens: TokenManager;
  client: NetatmoClient;
  clock: Clock;
}

export interface RuntimeOverrides {
  fetch?: FetchFn;
  clock?: Clock;
  rateWindows?: readonly RateWindow[];
  onExchange?: NetatmoClientOptions['onExchange'];
  /** Allow write endpoints (opt-in write mode, ADR-0012). Default false. */
  allowWrites?: boolean;
}

/**
 * Write mode is on only when the stored token was granted `write_thermostat` (login --write)
 * and it was not switched off with NETATMO_MCP_WRITE=0 (ADR-0012).
 */
export function isWriteModeEnabled(
  config: AppConfig,
  stored: StoredCredentials | undefined,
): boolean {
  return config.write !== 'off' && (stored?.tokens?.scope.includes(WRITE_SCOPE) ?? false);
}

/** Composition root: wires configuration, auth, the Netatmo client and domain services. */
export function createRuntime(
  config: AppConfig,
  logger: Logger,
  overrides: RuntimeOverrides = {},
): Runtime {
  const clock = overrides.clock ?? systemClock;
  const store = new CredentialStore(config.paths, logger, clock);
  const tokens = new TokenManager({
    store,
    envClient: config.envClient,
    logger,
    clock,
    ...(overrides.fetch && { fetch: overrides.fetch }),
  });
  const client = new NetatmoClient({
    tokens,
    logger,
    clock,
    allowWrites: overrides.allowWrites === true,
    rateLimiter: new RateLimiter({
      clock,
      ...(overrides.rateWindows && { windows: overrides.rateWindows }),
    }),
    ...(overrides.fetch && { fetch: overrides.fetch }),
    ...(overrides.onExchange && { onExchange: overrides.onExchange }),
  });
  const audit = new FileAuditLog(path.join(config.paths.dir, 'changes.log'), logger);
  const services = createServices(client, clock, config.limits, audit);
  return { store, tokens, client, ...services, clock };
}
