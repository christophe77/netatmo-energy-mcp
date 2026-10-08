import type { Command } from '../index.js';

export const doctorCommand: Command = {
  name: 'doctor',
  summary: 'Not implemented yet.',
  usage: 'netatmo-energy-mcp doctor',
  run: ({ out }) => {
    out.error(
      'The "doctor" command is not implemented yet. See the README for development status.',
    );
    return Promise.resolve(1);
  },
};
