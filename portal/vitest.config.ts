import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'loom-portal',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/components/**', 'src/pages/**'],
      exclude: [
        '**/__mocks__/**',
        '**/dist/**',
        '**/build/**',
        '**/coverage/**',
        '**/*.d.ts'
      ],
    },
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
      'recharts': path.resolve(__dirname, 'node_modules/recharts'),
    },
  },
});
