import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

// Mirror `vite.config.ts`'s sibling-checkout aliases so the test run
// resolves `@thermal-label/contracts` / `@thermal-label/d1-core` to the
// canonical sibling-checkout `dist/` rather than a transitive copy
// nested under a linked package's pnpm store.
const contractsDist = fileURLToPath(new URL('../../../contracts/dist/index.js', import.meta.url));
const d1CoreDist = fileURLToPath(new URL('../../../d1-core/dist/index.js', import.meta.url));

export default defineConfig({
  // `@vitejs/plugin-vue` compiles the `.vue` files pulled in transitively
  // via the `@thermal-label/harness-shell` barrel import — the test
  // itself never mounts a component, so the lighter `node` environment
  // is enough.
  plugins: [vue()],
  resolve: {
    alias: {
      '@thermal-label/contracts': contractsDist,
      '@thermal-label/d1-core': d1CoreDist,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
