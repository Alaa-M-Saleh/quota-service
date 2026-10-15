import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    fileParallelism: false, // all test files share one database
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
