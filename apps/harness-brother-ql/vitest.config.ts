import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

// Mirror `vite.config.ts`'s sibling-checkout aliases so the test run
// resolves `@thermal-label/contracts` / `@thermal-label/brother-ql-core`
// to the canonical sibling-checkout `dist/` rather than a transitive
// copy nested under a linked package's pnpm store. Without this a
// freshly-added export (e.g. `StatusDetail`, `parseStatus`'s
// `details[]`) shows up as missing at module-load time.
const contractsDist = fileURLToPath(new URL('../../../contracts/dist/index.js', import.meta.url));
const brotherQlCoreDist = fileURLToPath(
  new URL('../../../brother-ql/packages/core/dist/index.js', import.meta.url),
);

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@thermal-label/contracts': contractsDist,
      '@thermal-label/brother-ql-core': brotherQlCoreDist,
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
});
