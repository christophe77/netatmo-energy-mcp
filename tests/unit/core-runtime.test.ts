import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0014: the Netatmo client, domain, analytics and MCP tools are a runtime-neutral core,
 * bundled both into the local Node.js server and into the Cloudflare Worker. They must not load
 * Node-only modules or globals, nor import the Node-only shells at runtime.
 */
const SRC = path.join(import.meta.dirname, '..', '..', 'src');
const CORE_DIRS = ['analytics', 'domain', 'mcp', 'netatmo', 'utils'];
const CORE_FILES = ['errors.ts', 'version.ts', 'auth/oauth.ts'];
/** Node-only parts of src/: the CLI, the local shell, file storage, config and process entry. */
const NODE_ONLY = [
  'cli/',
  'local/',
  'probe/',
  'config/',
  'app.ts',
  'index.ts',
  'auth/callback-server.ts',
  'auth/credential-store.ts',
  'auth/lock.ts',
  'auth/secure-fs.ts',
  'auth/token-manager.ts',
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const coreFiles = [
  ...CORE_DIRS.flatMap((d) => walk(path.join(SRC, d))),
  ...CORE_FILES.map((f) => path.join(SRC, f)),
];

/** Runtime import specifiers (type-only imports are erased and allowed). */
function runtimeImports(source: string): string[] {
  const specs: string[] = [];
  const re = /^\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s+['"]([^'"]+)['"]/gm;
  for (const m of source.matchAll(re)) {
    if (m[2]) continue; // import type / export type
    const clause = m[3] ?? '';
    // `import { type A, type B } from` is erased too.
    const names = /^\{([^}]*)\}$/.exec(clause.trim())?.[1];
    if (names && names.split(',').every((n) => n.trim() === '' || n.trim().startsWith('type '))) {
      continue;
    }
    specs.push(m[4] ?? '');
  }
  for (const m of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1] ?? '');
  return specs;
}

describe('runtime-neutral core (ADR-0014)', () => {
  it('covers the expected modules', () => {
    expect(coreFiles.length).toBeGreaterThan(30);
  });

  it.each(coreFiles.map((f) => [path.relative(SRC, f).replaceAll('\\', '/'), f]))(
    '%s uses no Node-only modules or globals',
    (_name, file) => {
      const source = readFileSync(file, 'utf8');
      for (const spec of runtimeImports(source)) {
        expect(spec, `imports ${spec}`).not.toMatch(/^node:|^(fs|os|path|child_process|net|http)$/);
        if (spec.startsWith('.')) {
          const target = path
            .relative(SRC, path.resolve(path.dirname(file), spec))
            .replaceAll('\\', '/')
            .replace(/\.js$/, '.ts');
          expect(
            NODE_ONLY.some((n) => target === n || target.startsWith(n)),
            `imports Node-only ${target}`,
          ).toBe(false);
        }
      }
      // Code only, not comments.
      const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code).not.toMatch(/\bprocess\.|\bBuffer\.|\b__dirname\b|\brequire\(/);
    },
  );
});
