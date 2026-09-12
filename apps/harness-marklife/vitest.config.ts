import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

// No `@thermal-label/*` aliases — Waves 1-3 published every consumed
// package to npm, and the marklife-core/-web siblings resolve via the
// harness root's `link:` override, so the test run picks them up like
// any other dependency.

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
