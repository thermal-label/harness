import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// No `@thermal-label/*` aliases — Waves 1-3 published every consumed
// package to npm, so the harness root's pnpm override pins one registry
// copy and the test run resolves it like any other dependency.

export default defineConfig({
  plugins: [vue()],
  test: {
    // The adapter diagnostics test is pure logic — no DOM needed, so
    // the default `node` environment keeps this app free of a
    // `happy-dom` devDependency. A Vue-component test, if one is
    // added later, would switch this to `happy-dom`.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
