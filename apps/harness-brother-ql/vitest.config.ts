import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// No `@thermal-label/*` aliases — Waves 1-3 published every consumed
// package to npm, so the harness root's pnpm override pins one registry
// copy and the test run resolves it like any other dependency.

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
});
