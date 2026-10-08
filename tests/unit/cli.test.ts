import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import type { Output } from '../../src/cli/output.js';
import { VERSION } from '../../src/version.js';

function capture(): Output & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, line: (t = '') => lines.push(t), error: (t) => errors.push(t) };
}

describe('runCli', () => {
  it('prints the version', async () => {
    const out = capture();
    expect(await runCli(['--version'], {}, out)).toBe(0);
    expect(out.lines).toEqual([VERSION]);
  });

  it('prints help listing every command', async () => {
    const out = capture();
    expect(await runCli(['--help'], {}, out)).toBe(0);
    for (const cmd of ['login', 'logout', 'status', 'doctor', 'probe', 'serve']) {
      expect(out.lines.join('\n')).toContain(`  ${cmd}`);
    }
  });

  it('rejects unknown commands with exit code 2', async () => {
    const out = capture();
    expect(await runCli(['frobnicate'], {}, out)).toBe(2);
    expect(out.errors[0]).toContain('Unknown command "frobnicate"');
  });

  it('reports invalid environment configuration with exit code 2', async () => {
    const out = capture();
    expect(await runCli(['status'], { NETATMO_MCP_LOG_LEVEL: 'loud' }, out)).toBe(2);
    expect(out.errors[0]).toContain('NETATMO_MCP_LOG_LEVEL');
  });
});
