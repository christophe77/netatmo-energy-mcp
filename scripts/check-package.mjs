#!/usr/bin/env node
/**
 * Package validation (CI + release): packs the npm tarball, checks its contents, installs it
 * into a temporary directory and talks MCP to the installed binary over stdio.
 *
 * Usage: node scripts/check-package.mjs   (run after `pnpm build`)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const EXPECTED_TOOLS = 14;
const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
// On Windows npm is a .cmd shim, which Node only runs through a shell. All arguments here are
// fixed or temp paths created by this script; CI runs this check on Linux.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const work = mkdtempSync(path.join(tmpdir(), 'nem-pack-'));
const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

try {
  // 1. Pack.
  const [packed] = JSON.parse(
    execFileSync(npm, ['pack', '--json', '--pack-destination', work], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }),
  );
  const files = packed.files.map((f) => f.path.replaceAll('\\', '/'));
  console.log(`Packed ${packed.filename}: ${files.length} files, ${packed.size} bytes`);

  // 2. Contents: only the build, docs and metadata; never sources, tests or secrets.
  const allowed = /^(package\.json|README(\.fr)?\.md|LICENSE|CHANGELOG\.md|dist\/.+)$/;
  const unexpected = files.filter((f) => !allowed.test(f));
  check(
    unexpected.length === 0,
    `tarball contains only allowed files${unexpected.length ? `: unexpected ${unexpected.join(', ')}` : ''}`,
  );
  check(files.includes('dist/index.js'), 'dist/index.js is included');
  check(
    files.includes('LICENSE') && files.includes('README.md'),
    'LICENSE and README.md are included',
  );
  const credentialLike = (f) =>
    f.toLowerCase().includes('credentials') ||
    path.posix.basename(f).startsWith('.env') ||
    /\.(pem|key)$/i.test(f);
  check(!files.some(credentialLike), 'no credential-like files');
  check(packed.size < 500_000, `tarball is small (${packed.size} bytes)`);
  check(pkg.bin?.['netatmo-energy-mcp'] === 'dist/index.js', 'bin points to dist/index.js');
  // MCP Registry metadata must match the published package.
  const server = JSON.parse(readFileSync(path.join(root, 'server.json'), 'utf8'));
  check(
    server.name === pkg.mcpName,
    `server.json name equals package.json mcpName (${pkg.mcpName})`,
  );
  check(
    server.version === pkg.version && server.packages?.[0]?.version === pkg.version,
    `server.json versions equal package.json version (${pkg.version})`,
  );
  check(
    server.packages?.[0]?.identifier === pkg.name,
    'server.json package identifier is the npm name',
  );
  check(
    readFileSync(path.join(root, 'dist', 'index.js'), 'utf8').startsWith('#!/usr/bin/env node'),
    'dist/index.js has a node shebang',
  );

  // 3. Install the tarball like a user would.
  const app = path.join(work, 'app');
  execFileSync(npm, ['init', '-y'], {
    cwd: work,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  execFileSync(
    npm,
    ['install', '--prefix', app, '--no-audit', '--no-fund', path.join(work, packed.filename)],
    {
      cwd: work,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );
  const entry = path.join(app, 'node_modules', pkg.name, 'dist', 'index.js');
  check(existsSync(entry), 'package installs from the tarball');
  const version = execFileSync(process.execPath, [entry, '--version'], { encoding: 'utf8' }).trim();
  check(version === pkg.version, `--version prints ${pkg.version} (got ${version})`);

  // 4. Speak MCP to the installed binary over stdio, with an empty config folder.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...process.env,
      NETATMO_MCP_CONFIG_DIR: path.join(work, 'cfg'),
      NETATMO_MCP_LOG_LEVEL: 'warn',
    },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'check-package', version: '0.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();
  check(
    tools.length === EXPECTED_TOOLS,
    `server lists ${EXPECTED_TOOLS} tools (got ${tools.length})`,
  );
  check(
    tools.every((t) => t.annotations?.readOnlyHint === true),
    'all tools are annotated read-only',
  );
  const res = await client.callTool({ name: 'netatmo_list_homes', arguments: {} });
  const body = JSON.parse(res.content?.[0]?.text ?? '{}');
  check(
    res.isError === true && body.error?.code === 'AUTH_REQUIRED',
    'unauthenticated call returns AUTH_REQUIRED',
  );
  const { resources } = await client.listResources().catch(() => ({ resources: [] }));
  check(Array.isArray(resources), 'resources/list responds');
  const { prompts } = await client.listPrompts();
  check(prompts.length === 4, `server lists 4 prompts (got ${prompts.length})`);
  await client.close();
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} package check(s) failed.`);
  process.exit(1);
}
console.log('\nPackage checks passed.');
