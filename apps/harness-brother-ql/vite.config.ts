import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

// `@thermal-label/contracts` is no longer aliased — Wave 1 published it
// to npm, so the harness root's pnpm override pins it to `^0.6.0` and
// every importer resolves the one registry copy.
//
// `@thermal-label/brother-ql-core` is still a Wave-3 `link:` sibling
// (not yet on npm). The harness app imports it directly; this alias
// forces Vite to resolve it to the sibling-checkout's freshly-built
// `dist/index.js` rather than a copy nested under brother-ql-core's
// per-repo `node_modules/.pnpm/` store.
const brotherQlCoreDist = fileURLToPath(
  new URL('../../../brother-ql/packages/core/dist/index.js', import.meta.url),
);

export default defineConfig({
  plugins: [vue()],
  // Static-bundle output: relative asset paths so the bundle works
  // when served from a sub-path (docs site mounts at /harness/brother-ql/).
  base: './',
  resolve: {
    alias: {
      '@thermal-label/brother-ql-core': brotherQlCoreDist,
    },
  },
  optimizeDeps: {
    force: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
});
