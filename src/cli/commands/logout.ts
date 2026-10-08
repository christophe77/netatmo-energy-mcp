import { CredentialStore } from '../../auth/credential-store.js';
import type { Command } from '../index.js';

export const logoutCommand: Command = {
  name: 'logout',
  summary: 'Delete the locally stored tokens and Netatmo app credentials.',
  usage: 'netatmo-energy-mcp logout',
  run: async ({ config, out, logger }) => {
    const store = new CredentialStore(config.paths, logger);
    const removed = await store.clear();
    out.line(
      removed
        ? `Removed ${config.paths.credentials}.`
        : 'No stored credentials found; nothing to remove.',
    );
    out.line(
      "Netatmo has no token revocation endpoint. To revoke access on Netatmo's side as well, delete your app at https://dev.netatmo.com/apps (or regenerate its client secret).",
    );
    if (config.envClient.clientId || config.envClient.clientSecret) {
      out.line(
        'Note: NETATMO_CLIENT_ID / NETATMO_CLIENT_SECRET are still set in your environment or MCP client configuration.',
      );
    }
    return 0;
  },
};
