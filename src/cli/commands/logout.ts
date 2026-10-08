import type { Command } from '../index.js';

export const logoutCommand: Command = {
  name: 'logout',
  summary: 'Not implemented yet.',
  usage: 'netatmo-energy-mcp logout',
  run: ({ out }) => {
    out.error(
      'The "logout" command is not implemented yet. See the README for development status.',
    );
    return Promise.resolve(1);
  },
};
