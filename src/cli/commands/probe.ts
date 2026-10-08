import type { Command } from '../index.js';

export const probeCommand: Command = {
  name: 'probe',
  summary: 'Not implemented yet.',
  usage: 'netatmo-energy-mcp probe',
  run: ({ out }) => {
    out.error('The "probe" command is not implemented yet. See the README for development status.');
    return Promise.resolve(1);
  },
};
