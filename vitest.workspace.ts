import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  './vitest.config.ts',
  './portal/vitest.config.ts',
  './vitest.smoke.config.ts',
]);
