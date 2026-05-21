import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    pool: 'forks',
    testTimeout: 15000,
    hookTimeout: 15000,
    include: ['tests/**/*.test.js'],
    globalSetup: ['./tests/setup/globalSetup.js'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      exclude: [
        'src/views/**',
        'src/public/**',
        'src/assets/**',
        'src/config/loadEnv.js',
      ],
    },
    // Run test files sequentially since they share DB state
    fileParallelism: false,
    sequence: {
      setupFiles: 'list',
    },
  },
});
