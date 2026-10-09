import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { serverOrigin } from '../../src/cli/commands/remote.js';
import { runCli } from '../../src/cli/index.js';
import type { Output } from '../../src/cli/output.js';

function capture(): Output & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, line: (t = '') => lines.push(t), error: (t) => errors.push(t) };
}

const TOKEN = 'test-setup-token-123';
let server: http.Server | undefined;
const seen: { auth?: string | undefined; path?: string | undefined }[] = [];

/** A stand-in for the remote server's /admin endpoints. */
async function fakeRemote(status: Record<string, unknown>, httpStatus = 200): Promise<string> {
  server = http.createServer((req, res) => {
    seen.push({ auth: req.headers.authorization, path: req.url });
    const ok = req.headers.authorization === `Bearer ${TOKEN}`;
    res.writeHead(ok ? httpStatus : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? status : { error: 'invalid_setup_token' }));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(() => {
  server?.close();
  server = undefined;
  seen.length = 0;
});

describe('remote', () => {
  it('accepts https URLs, and http only on loopback; strips paths', () => {
    expect(serverOrigin('https://x.workers.dev/mcp')).toBe('https://x.workers.dev');
    expect(serverOrigin('http://localhost:8787/')).toBe('http://localhost:8787');
    expect(serverOrigin('http://example.com')).toBeUndefined();
    expect(serverOrigin('https://user:pw@example.com')).toBeUndefined();
    expect(serverOrigin('not a url')).toBeUndefined();
  });

  it('status prints the link state and sends the setup token as a bearer header', async () => {
    const url = await fakeRemote({
      version: '0.3.0',
      linked: true,
      scopes: ['read_thermostat', 'write_thermostat'],
      writeMode: true,
      linkedAt: '2026-10-09T08:00:00.000Z',
    });
    const out = capture();
    const code = await runCli(['remote', 'status', url], { NETATMO_MCP_SETUP_TOKEN: TOKEN }, out);
    expect(code).toBe(0);
    const text = out.lines.join('\n');
    expect(text).toContain('linked on 2026-10-09T08:00:00.000Z');
    expect(text).toContain('Write mode:    on');
    expect(text).not.toContain(TOKEN);
    expect(seen[0]).toEqual({ auth: `Bearer ${TOKEN}`, path: '/admin/status' });
  });

  it('explains a wrong setup token without printing it', async () => {
    const url = await fakeRemote({ linked: false, scopes: [], writeMode: false });
    const out = capture();
    const code = await runCli(
      ['remote', 'status', url],
      { NETATMO_MCP_SETUP_TOKEN: 'wrong-token-xyz' },
      out,
    );
    expect(code).toBe(1);
    expect(out.errors.join('\n')).toMatch(/refused the setup token/);
    expect(out.errors.join('\n')).not.toContain('wrong-token-xyz');
  });

  it('refuses plain http to a remote host and bad usage', async () => {
    const out = capture();
    expect(
      await runCli(
        ['remote', 'status', 'http://example.com'],
        { NETATMO_MCP_SETUP_TOKEN: TOKEN },
        out,
      ),
    ).toBe(2);
    expect(await runCli(['remote', 'frobnicate'], {}, capture())).toBe(2);
  });
});

describe('remote invite', () => {
  it('prints a new invite code', async () => {
    const url = await fakeRemote({ code: 'abc123XYZ', expires_at: '2026-10-16T00:00:00.000Z' });
    const out = capture();
    expect(await runCli(['remote', 'invite', url], { NETATMO_MCP_SETUP_TOKEN: TOKEN }, out)).toBe(
      0,
    );
    expect(out.lines.join('\n')).toContain('Invite code: abc123XYZ');
    expect(seen.map((s) => s.path)).toEqual(['/admin/status', '/admin/invite']);
  });
});

describe('remote accounts, revoke, remove', () => {
  it('lists accounts with their connectors', async () => {
    const url = await fakeRemote({
      linked: true,
      scopes: [],
      writeMode: false,
      accounts: [
        {
          account: 'owner',
          linked: true,
          writeMode: true,
          scopes: [],
          connectors: [
            { client_id: 'https://claude.ai/x', created_at: '2026-10-09T00:00:00.000Z' },
          ],
        },
      ],
    });
    const out = capture();
    expect(await runCli(['remote', 'accounts', url], { NETATMO_MCP_SETUP_TOKEN: TOKEN }, out)).toBe(
      0,
    );
    expect(out.lines.join('\n')).toContain('owner  read + write  1 connector(s)');
  });

  it('requires --account for remove', async () => {
    const out = capture();
    expect(
      await runCli(
        ['remote', 'remove', 'https://x.workers.dev'],
        { NETATMO_MCP_SETUP_TOKEN: TOKEN },
        out,
      ),
    ).toBe(2);
    expect(out.errors.join('\n')).toContain('--account');
  });

  it('revokes connectors', async () => {
    const url = await fakeRemote({ linked: true, scopes: [], writeMode: false, revoked: 3 });
    const out = capture();
    expect(await runCli(['remote', 'revoke', url], { NETATMO_MCP_SETUP_TOKEN: TOKEN }, out)).toBe(
      0,
    );
    expect(out.lines.join('\n')).toContain('Revoked 3 connector authorization(s)');
    expect(seen.map((s) => s.path)).toEqual(['/admin/status', '/admin/revoke']);
  });
});
