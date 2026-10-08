import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
    unstubEnvs: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Thin wrappers around the OS/stdio, exercised by the CLI smoke tests in CI.
      exclude: ['src/index.ts', 'src/cli/browser.ts', 'src/cli/prompt.ts', 'src/cli/output.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { statements: 85, branches: 70, functions: 85, lines: 85 },
    },
  },
});
