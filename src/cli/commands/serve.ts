import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createRuntime } from '../../app.js';
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
    const runtime = createRuntime(config, logger);
    const server = createMcpServer(runtime.service, logger);
    const transport = new StdioServerTransport();

    const closed = new Promise<void>((resolve) => {
      transport.onclose = () => {
        resolve();
      };
      // The spec asks stdio servers to exit promptly when stdin ends.
      process.stdin.once('end', () => {
        void server.close().finally(resolve);
      });
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
          void server.close().finally(resolve);
        });
      }
    });

    await server.connect(transport);
    logger.info('netatmo-energy-mcp MCP server running on stdio (read-only)', {
      configDir: config.paths.dir,
    });
    await closed;
    return 0;
  },
};
