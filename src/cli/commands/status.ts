import type { Command } from '../index.js';

export const statusCommand: Command = {
  name: 'status',
  summary: 'Not implemented yet.',
  usage: 'netatmo-energy-mcp status',
  run: ({ out }) => {
    out.error(
      'The "status" command is not implemented yet. See the README for development status.',
    );
    return Promise.resolve(1);
  },
};
