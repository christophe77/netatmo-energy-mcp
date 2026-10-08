import type { Command } from '../index.js';

export const serveCommand: Command = {
  name: 'serve',
  summary: 'Not implemented yet.',
  usage: 'netatmo-energy-mcp serve',
  run: ({ out }) => {
    out.error('The "serve" command is not implemented yet. See the README for development status.');
    return Promise.resolve(1);
  },
};
