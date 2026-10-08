import type { Command } from '../index.js';

export const loginCommand: Command = {
  name: 'login',
  summary: 'Not implemented yet.',
  usage: 'netatmo-energy-mcp login',
  run: ({ out }) => {
    out.error('The "login" command is not implemented yet. See the README for development status.');
    return Promise.resolve(1);
  },
};
