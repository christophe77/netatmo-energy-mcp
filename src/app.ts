import { CredentialStore } from './auth/credential-store.js';
import type { FetchFn } from './auth/oauth.js';
import { TokenManager } from './auth/token-manager.js';
import type { AppConfig } from './config/loader.js';
import { HistoryService } from './domain/history/history-service.js';
import { NetatmoClient, type NetatmoClientOptions } from './netatmo/client.js';
import { RateLimiter, type RateWindow } from './netatmo/rate-limiter.js';
import { systemClock, type Clock } from './utils/clock.js';
import type { Logger } from './utils/logger.js';

export interface Runtime {
  store: CredentialStore;
  tokens: TokenManager;
  client: NetatmoClient;
  history: HistoryService;
  clock: Clock;
}

export interface RuntimeOverrides {
  fetch?: FetchFn;
  clock?: Clock;
  rateWindows?: readonly RateWindow[];
  onExchange?: NetatmoClientOptions['onExchange'];
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
    rateLimiter: new RateLimiter({
      clock,
      ...(overrides.rateWindows && { windows: overrides.rateWindows }),
    }),
    ...(overrides.fetch && { fetch: overrides.fetch }),
    ...(overrides.onExchange && { onExchange: overrides.onExchange }),
  });
  return { store, tokens, client, history: new HistoryService(client), clock };
}
