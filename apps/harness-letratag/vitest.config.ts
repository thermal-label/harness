import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

// Mirror `vite.config.ts`'s sibling-checkout aliasing so the test run
// resolves `@thermal-label/contracts` / `@thermal-label/letratag-core`
// / `@thermal-label/letratag-web` to the canonical sibling-checkout
// `dist/` rather than a transitive copy nested under a linked
// package's pnpm store. Without this a freshly-added or freshly-removed
// export shows up as mismatched at module-load time. Same trick the
// brother-ql harness app uses.
const contractsDist = fileURLToPath(new URL('../../../contracts/dist/index.js', import.meta.url));
const letratagCoreDist = fileURLToPath(
  new URL('../../../letratag/packages/core/dist/index.js', import.meta.url),
);
const letratagWebDist = fileURLToPath(
  new URL('../../../letratag/packages/web/dist/index.js', import.meta.url),
);

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@thermal-label/contracts': contractsDist,
      '@thermal-label/letratag-core': letratagCoreDist,
      '@thermal-label/letratag-web': letratagWebDist,
    },
  },
  test: {
    // The adapter diagnostics test is pure logic — no DOM needed, so
    // the default `node` environment keeps this app free of a
    // `happy-dom` devDependency. A Vue-component test, if one is
    // added later, would switch this to `happy-dom`.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
