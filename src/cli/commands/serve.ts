import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createRuntime, isWriteModeEnabled } from '../../app.js';
import { CredentialStore } from '../../auth/credential-store.js';
import { createMcpServer } from '../../mcp/server.js';
import type { Command } from '../index.js';

export const serveCommand: Command = {
  name: 'serve',
  summary: 'Start the MCP server on stdio (default when no command is given).',
  usage: 'netatmo-energy-mcp [serve]',
  run: async ({ config, logger, argv }) => {
    if (argv.length > 0) {
      process.stderr.write(`Unexpected arguments: ${argv.join(' ')}\n`);
      return 2;
    }
    // stdout carries the MCP protocol; everything else goes to stderr through the logger.
    const stored = await new CredentialStore(config.paths, logger).read().catch(() => undefined);
    const writeMode = isWriteModeEnabled(config, stored);
    const runtime = createRuntime(config, logger, { allowWrites: writeMode });

    // serveStdio negotiates the protocol era per connection (2025 initialize handshake or
    // 2026-07-28 server/discover) and builds the server from this factory.
    const handle = serveStdio(
      () =>
        createMcpServer(runtime.service, runtime.analytics, logger, {
          control: runtime.control,
          writeMode,
          requireElicitation: config.confirm === 'elicitation',
        }),
      {
        onerror: (error) => {
          logger.error('MCP transport error', { error });
        },
      },
    );
    logger.info(
      `netatmo-energy-mcp MCP server running on stdio (${writeMode ? 'WRITE MODE' : 'read-only'})`,
      { configDir: config.paths.dir },
    );

    await new Promise<void>((resolve) => {
      const stop = () => {
        void handle.close().finally(resolve);
      };
      // The spec asks stdio servers to exit promptly when stdin ends.
      process.stdin.once('end', stop);
      process.stdin.once('close', stop);
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, stop);
    });
    return 0;
  },
};
