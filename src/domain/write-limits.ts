/** Limits applied to every heating change (ADR-0012). */
export interface WriteLimits {
  minTemp: number;
  maxTemp: number;
  maxSetpointHours: number;
  defaultSetpointHours: number;
}

/** Default write limits chosen by the maintainer (ADR-0012). */
export const DEFAULT_WRITE_LIMITS: WriteLimits = {
  minTemp: 7,
  maxTemp: 28,
  maxSetpointHours: 24,
  defaultSetpointHours: 3,
};

/**
 * How changes are confirmed: 'auto' (the client's dialog when it has one, else preview + token),
 * 'elicitation' (the client's dialog only), 'token' (preview + token only, for clients that
 * advertise elicitation without showing it).
 */
export type ConfirmMode = 'auto' | 'elicitation' | 'token';
