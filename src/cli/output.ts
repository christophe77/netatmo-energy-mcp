/**
 * Human-facing CLI output. Only interactive commands (login, status, doctor, probe) use this.
 * `serve` must never write to stdout, which belongs to the MCP JSON-RPC stream.
 */
export interface Output {
  line(text?: string): void;
  error(text: string): void;
}

export const consoleOutput: Output = {
  line: (text = '') => process.stdout.write(`${text}\n`),
  error: (text) => process.stderr.write(`${text}\n`),
};
