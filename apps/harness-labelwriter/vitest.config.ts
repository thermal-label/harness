import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// No `@thermal-label/*` aliases — Waves 1-3 published every consumed
// package to npm, so the harness root's pnpm override pins one registry
// copy and the test run resolves it like any other dependency.

export default defineConfig({
  // `@vitejs/plugin-vue` compiles the `.vue` files pulled in transitively
  // via the `@thermal-label/harness-shell` barrel import — the test
  // itself never mounts a component, so the lighter `node` environment
  // is enough.
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
