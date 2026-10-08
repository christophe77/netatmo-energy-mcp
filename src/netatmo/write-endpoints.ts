/**
 * Netatmo Energy write endpoints (OAuth scope `write_thermostat`).
 *
 * Only reachable in opt-in write mode (ADR-0012): the client refuses them unless it was
 * constructed with `allowWrites`, and the MCP write tools are registered only when the stored
 * token was granted the write scope. Read endpoints stay in `endpoints.ts`.
 */
export const WRITE_SCOPE = 'write_thermostat';

export const WRITE_ENDPOINTS = {
  /** Documented: room setpoint (manual / max / home). */
  setroomthermpoint: '/setroomthermpoint',
  /** Documented: home mode (schedule / away / hg). `schedule_id` is undocumented. */
  setthermmode: '/setthermmode',
  /** Documented: activate a weekly schedule. */
  switchhomeschedule: '/switchhomeschedule',
  /** Documented: create a weekly schedule. */
  createnewhomeschedule: '/createnewhomeschedule',
  /** Documented: replace the content of a weekly schedule. */
  synchomeschedule: '/synchomeschedule',
  /** Undocumented (used by other client libraries): rename a schedule. Experimental. */
  renamehomeschedule: '/renamehomeschedule',
} as const;

export type WriteEndpoint = keyof typeof WRITE_ENDPOINTS;
