import type { NetatmoClient } from '../netatmo/client.js';
import type { Clock } from '../utils/clock.js';
import { AnalyticsService } from './analytics-service.js';
import type { AuditLog } from './audit-log.js';
import { ControlService } from './control-service.js';
import { EnergyService } from './energy-service.js';
import { HistoryService } from './history/history-service.js';
import type { WriteLimits } from './write-limits.js';

export interface Services {
  history: HistoryService;
  service: EnergyService;
  analytics: AnalyticsService;
  control: ControlService;
}

/** The application services around one Netatmo client, shared by the local and remote shells. */
export function createServices(
  client: NetatmoClient,
  clock: Clock,
  limits: WriteLimits,
  audit: AuditLog,
): Services {
  const history = new HistoryService(client);
  const service = new EnergyService(client, history, clock);
  const analytics = new AnalyticsService(client, history, service, clock);
  const control = new ControlService(client, limits, audit, clock);
  return { history, service, analytics, control };
}
