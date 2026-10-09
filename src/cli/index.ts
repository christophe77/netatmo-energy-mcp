import { parseArgs } from 'node:util';
import { ConfigError, loadConfig, type AppConfig } from '../config/loader.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import { consoleOutput, type Output } from './output.js';

export interface CommandContext {
  config: AppConfig;
  out: Output;
  logger: Logger;
  argv: string[];
}

export interface Command {
  name: string;
  summary: string;
  usage: string;
  run(ctx: CommandContext): Promise<number>;
}

/** Commands are loaded lazily so `serve` does not pay for CLI-only code and vice versa. */
const COMMANDS: Record<string, () => Promise<Command>> = {
  login: async () => (await import('./commands/login.js')).loginCommand,
  logout: async () => (await import('./commands/logout.js')).logoutCommand,
  status: async () => (await import('./commands/status.js')).statusCommand,
  doctor: async () => (await import('./commands/doctor.js')).doctorCommand,
  probe: async () => (await import('./commands/probe.js')).probeCommand,
  serve: async () => (await import('./commands/serve.js')).serveCommand,
  remote: async () => (await import('./commands/remote.js')).remoteCommand,
};

const SUMMARIES: Record<string, string> = {
  login: 'Authorize access to your Netatmo account (OAuth2, browser-based)',
  logout: 'Delete locally stored tokens and client credentials',
  status: 'Show authentication status without revealing secrets',
  doctor: 'Check configuration, credentials and API connectivity',
  probe: 'Record sanitized API responses for validation and compatibility reports',
  serve: 'Start the MCP server on stdio (default when no command is given)',
};

export function helpText(): string {
  const width = Math.max(...Object.keys(SUMMARIES).map((n) => n.length));
  const rows = Object.entries(SUMMARIES)
    .map(([name, summary]) => `  ${name.padEnd(width)}  ${summary}`)
    .join('\n');
  return `${PACKAGE_NAME} ${VERSION}
Read-only MCP server for Netatmo thermostats and radiator valves.

Usage:
  ${PACKAGE_NAME} [command] [options]

Commands:
${rows}

Options:
  -h, --help     Show help (also: <command> --help)
  -v, --version  Show version

Environment:
  NETATMO_CLIENT_ID, NETATMO_CLIENT_SECRET  Netatmo app credentials (override stored ones)
  NETATMO_REDIRECT_URI                      OAuth redirect URI (default http://localhost:8977/callback)
  NETATMO_MCP_CONFIG_DIR                    Override the configuration directory
  NETATMO_MCP_LOG_LEVEL                     debug | info | warn | error | silent

Docs: https://github.com/christophe77/netatmo-energy-mcp`;
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  out: Output = consoleOutput,
): Promise<number> {
  const [first, ...rest] = argv;
  if (first === '-v' || first === '--version') {
    out.line(VERSION);
    return 0;
  }
  if (first === '-h' || first === '--help' || first === 'help') {
    out.line(helpText());
    return 0;
  }

  const name = first === undefined || first.startsWith('-') ? 'serve' : first;
  const commandArgs = first === undefined || first.startsWith('-') ? argv : rest;
  const load = COMMANDS[name];
  if (!load) {
    out.error(`Unknown command "${name}". Run "${PACKAGE_NAME} --help".`);
    return 2;
  }

  let config: AppConfig;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      out.error(error.message);
      return 2;
    }
    throw error;
  }

  const command = await load();
  if (commandArgs.includes('--help') || commandArgs.includes('-h')) {
    out.line(`${command.summary}\n\nUsage:\n  ${command.usage}`);
    return 0;
  }
  const logger = createLogger({ level: config.logLevel });
  return command.run({ config, out, logger, argv: commandArgs });
}

/** Shared parseArgs wrapper that turns unknown options into a readable error. */
export function parseCommandArgs<T extends NonNullable<Parameters<typeof parseArgs>[0]>['options']>(
  argv: string[],
  options: T,
) {
  return parseArgs({ args: argv, options, allowPositionals: false, strict: true });
}
