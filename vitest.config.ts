import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'arachne',
    globals: true,
    environment: 'node',
    exclude: ['portal/**', 'cli/**', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'tests/**',
        '**/*.config.*',
        'vitest.workspace.ts',
        '**/node_modules/**',
        '**/dist/**',
        'dist/**',
        'migrations/**',
        'scripts/**',
        'dashboard/**',
        '**/__mocks__/**',
        '**/build/**',
        '**/coverage/**',
        '**/*.d.ts'
      ]
    },
    testTimeout: 10000,
    hookTimeout: 10000
  }
});
