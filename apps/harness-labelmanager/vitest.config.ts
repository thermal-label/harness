import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

// Mirror `vite.config.ts`'s sibling-checkout aliasing so the test run
// resolves `@thermal-label/contracts` / `@thermal-label/labelmanager-core`
// / `@thermal-label/labelmanager-web` to the canonical sibling-checkout
// `dist/` rather than a transitive copy nested under a linked
// package's pnpm store. Same trick the brother-ql harness app uses.
const contractsDist = fileURLToPath(new URL('../../../contracts/dist/index.js', import.meta.url));
const lmCoreDist = fileURLToPath(
  new URL('../../../labelmanager/packages/core/dist/index.js', import.meta.url),
);
const lmWebDist = fileURLToPath(
  new URL('../../../labelmanager/packages/web/dist/index.js', import.meta.url),
);

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@thermal-label/contracts': contractsDist,
      '@thermal-label/labelmanager-core': lmCoreDist,
      '@thermal-label/labelmanager-web': lmWebDist,
    },
  },
  test: {
    // The adapter diagnostics test is pure logic — no DOM needed.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
