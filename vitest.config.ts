import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'apps/collector/src/**/*.test.ts',
      'tools/**/src/**/*.test.ts'
    ],
    environment: 'node',
    globals: false,
    testTimeout: 15000
  }
});
