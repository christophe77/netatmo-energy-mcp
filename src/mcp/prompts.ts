import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

/**
 * Reusable prompts. Each one asks the assistant to separate observed data, derived metrics,
 * hypotheses and recommendations (ADR-0009), and states the data's limits up front.
 */

const LIMITS = `Important limits of this data:
- Netatmo Energy does not measure gas or energy consumption. Boiler "heat demand" time is when the thermostat requested heat, not gas burned. Do not estimate consumption, cost or CO2.
- heating_demand_percent is the heat a room requests, not boiler power.
- Missing measurements are reported as gaps; do not fill them in.
- Do not diagnose hardware faults (e.g. "the valve is broken"); describe what the data shows and, at most, list possible explanations as hypotheses.`;

const STRUCTURE = `Structure the answer with these sections:
1. Observed data – values returned by the tools (cite times and rooms).
2. Derived metrics – figures you computed from them, with how you computed them.
3. Hypotheses – possible explanations, clearly marked as uncertain.
4. Recommendations – practical, low-risk suggestions. This integration is read-only: the user must make any change in the Netatmo app.`;

const homeArg = z.string().optional().describe('Home ID (optional if the account has one home)');

const text = (body: string) => ({
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text: body } }],
});

const homeClause = (home?: string) => (home ? ` Use home_id "${home}".` : '');

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    'heating_daily_report',
    {
      title: 'Daily heating report',
      description: 'Summarise one day of heating: temperatures, setpoints and boiler activity.',
      argsSchema: z.object({
        home_id: homeArg,
        date: z
          .string()
          .optional()
          .describe('Day to report, YYYY-MM-DD in the home time zone (default: yesterday)'),
      }),
    },
    ({ home_id, date }) => {
      const range = date ? `from "${date}" to "${date}T23:59:59"` : 'period "yesterday"';
      return text(`Write a daily heating report for my Netatmo home.${homeClause(home_id)}

Steps:
1. Call netatmo_list_rooms.
2. For each room, call netatmo_get_temperature_history and netatmo_get_setpoint_history with ${range} and mode "summary".
3. Call netatmo_get_boiler_history with ${range} (if boiler history is unsupported, say so and continue).
4. Optionally call netatmo_get_home_status for current alerts.

Report per room: min/mean/max temperature, typical setpoint, and how far the temperature stayed from the setpoint. Report the total boiler heat-demand time.

${LIMITS}

${STRUCTURE}`);
    },
  );

  server.registerPrompt(
    'heating_anomaly_review',
    {
      title: 'Review unusual heating behaviour',
      description: 'Look for unusual temperatures, gaps or setpoint deviations over a period.',
      argsSchema: z.object({
        home_id: homeArg,
        room_name: z.string().optional().describe('Limit the review to one room'),
        period: z
          .enum(['today', 'yesterday', 'last_24h', 'last_7d'])
          .optional()
          .describe('Period to review (default last_24h)'),
      }),
    },
    ({ home_id, room_name, period }) =>
      text(`Review my Netatmo heating for unusual behaviour over ${period ?? 'last_24h'}${room_name ? ` in the room "${room_name}"` : ' in every room'}.${homeClause(home_id)}

Use netatmo_get_temperature_history and netatmo_get_setpoint_history (mode "aggregated"), netatmo_get_boiler_history and netatmo_get_device_status. Look for:
- sudden temperature jumps or drops while the setpoint was constant,
- long periods far below or above the setpoint,
- suspiciously constant readings,
- missing data (coverage gaps) and unreachable devices or low batteries.

For each finding give the room, the time, the supporting values, and a confidence level (low/medium/high).

${LIMITS}

${STRUCTURE}`),
  );

  server.registerPrompt(
    'room_comparison',
    {
      title: 'Compare rooms',
      description: 'Compare temperatures and setpoint adherence across rooms.',
      argsSchema: z.object({
        home_id: homeArg,
        period: z
          .enum(['yesterday', 'last_24h', 'last_7d', 'last_30d'])
          .optional()
          .describe('Period to compare (default last_7d)'),
      }),
    },
    ({ home_id, period }) =>
      text(`Compare the rooms of my Netatmo home over ${period ?? 'last_7d'}.${homeClause(home_id)}

Call netatmo_list_rooms, then for each room netatmo_get_temperature_history (mode "summary") and netatmo_get_setpoint_history (mode "summary"). Present a table with mean/min/max temperature, temperature variability (stddev), mean setpoint and the mean difference to the setpoint. Rank the rooms (warmest, coolest, most variable, furthest below setpoint).

${LIMITS}

${STRUCTURE}`),
  );

  server.registerPrompt(
    'heating_efficiency_review',
    {
      title: 'Heating pattern review',
      description:
        'Review heating patterns (setpoints, boiler demand time, overheating) for possible optimisation opportunities.',
      argsSchema: z.object({
        home_id: homeArg,
        period: z
          .enum(['last_7d', 'last_30d'])
          .optional()
          .describe('Period to review (default last_7d)'),
      }),
    },
    ({ home_id, period }) =>
      text(`Review the heating patterns of my Netatmo home over ${period ?? 'last_7d'} and identify possible optimisation opportunities.${homeClause(home_id)}

Use netatmo_get_boiler_history (daily buckets), and for each room netatmo_get_setpoint_history and netatmo_get_temperature_history (mode "aggregated"). Consider: setpoints that are high for the room type or time of day, rooms that stay above their setpoint, heat demand at times when rooms are likely unoccupied, and day-to-day changes in boiler heat-demand time.

Without outdoor temperature data, differences between days may simply reflect the weather; say so where relevant. Express any potential savings qualitatively only.

${LIMITS}

${STRUCTURE}`),
  );
}
