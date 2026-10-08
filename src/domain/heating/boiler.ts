/**
 * Boiler activity semantics, as observed on a live NATherm1 installation (2026-10-08) —
 * see docs/api-capabilities.md §6. The official documentation says "minutes"; the API
 * actually returns seconds:
 *
 * - Sub-daily scales (30min, 1hour, 3hours): `boileron` / `boileroff` are the average number
 *   of seconds the boiler was on / off per 600 s sampling interval. on + off ≈ 600 whatever
 *   the bucket length, so on / (on + off) is the fraction of the bucket with heat demand.
 * - Daily and longer scales: `sum_boiler_on` / `sum_boiler_off` are seconds in the bucket
 *   (on + off ≈ 86 400 for a complete day).
 *
 * "On" means the thermostat requested heat. It is not gas consumption, and aggregated
 * values cannot tell how many burner cycles occurred.
 */
import { LARGE_SCALES, SCALE_SECONDS, type Scale } from '../../netatmo/endpoints.js';

export const BOILER_SAMPLE_SECONDS = 600;

/**
 * Seconds of heat demand in one bucket.
 * @param on  `boileron` (sub-daily) or `sum_boiler_on` (daily+)
 * @param off `boileroff` / `sum_boiler_off`, used to normalise sub-daily samples when present
 */
export function boilerOnSeconds(
  scale: Scale,
  on: number | null | undefined,
  off?: number | null,
): number | null {
  if (on == null) return null;
  if (LARGE_SCALES.includes(scale)) return on;
  const total = off == null ? BOILER_SAMPLE_SECONDS : on + off;
  if (total <= 0) return null;
  return (on / total) * SCALE_SECONDS[scale];
}

export const BOILER_CAVEATS = [
  'Boiler "on" time is the time the thermostat requested heat (relay closed), not measured gas or energy consumption.',
  'Values are aggregates: the number of burner cycles cannot be derived from them.',
] as const;
