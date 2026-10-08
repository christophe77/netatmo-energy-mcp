import type { CommandContext } from '../index.js';

/** Post-login check. Extended with a read-only API call once the Netatmo client exists. */
export function verifyAccount({
  out,
}: Pick<CommandContext, 'config' | 'out' | 'logger'>): Promise<number> {
  out.line('Run "netatmo-energy-mcp status" to check the stored credentials.');
  return Promise.resolve(0);
}
