#!/usr/bin/env node
import { runCli } from './cli/index.js';
import { redactText } from './utils/logger.js';

runCli().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`netatmo-energy-mcp: ${redactText(message)}\n`);
    process.exitCode = 1;
  },
);
