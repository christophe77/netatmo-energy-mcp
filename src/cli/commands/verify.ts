import { createRuntime } from '../../app.js';
import { describeHeatingSetup, summarizeDevices, toHomes } from '../../domain/homes/topology.js';
import { AppError } from '../../errors.js';
import type { CommandContext } from '../index.js';

/** Post-login check: one read-only `homesdata` call, summarised without IDs. */
export async function verifyAccount({
  config,
  out,
  logger,
}: Pick<CommandContext, 'config' | 'out' | 'logger'>): Promise<number> {
  try {
    const { client } = createRuntime(config, logger);
    const homes = toHomes((await client.homesData()).body);
    out.line();
    if (homes.length === 0) {
      out.line('Connected, but no home with Netatmo Energy devices was found in this account.');
      return 0;
    }
    out.line(`Connected. Found ${homes.length} home${homes.length > 1 ? 's' : ''}:`);
    for (const home of homes) {
      const setup = describeHeatingSetup(home);
      out.line(
        `  • ${home.name} (${home.timezone ?? 'unknown time zone'}): ${home.rooms.length} rooms`,
      );
      out.line(`    Devices: ${summarizeDevices(home) || 'none'}`);
      out.line(
        setup.boilerSource
          ? `    Boiler history: available via thermostat type ${setup.boilerSource.thermostatType}`
          : '    Boiler history: not available (no thermostat found)',
      );
    }
    return 0;
  } catch (error) {
    if (error instanceof AppError) {
      out.error(`Logged in, but the first API call failed: ${error.message}`);
      if (error.hint) out.error(error.hint);
      return 1;
    }
    throw error;
  }
}
