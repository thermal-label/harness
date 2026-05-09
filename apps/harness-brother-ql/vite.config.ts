import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

// Sibling-checkout layout: `link:../contracts` in this app's package.json
// covers the harness's direct dep, but linked sibling packages
// (`@thermal-label/transport`, `@thermal-label/brother-ql-core`) carry
// their own pre-installed `@thermal-label/contracts` in their per-repo
// `node_modules/.pnpm/` stores at whatever version they pinned. Without
// this alias, Vite picks up one of the transitive copies and a freshly-
// added export on the local checkout (e.g. `getPrintableArea`) shows up
// as missing at module-load time.
//
// Force every import of `@thermal-label/contracts` to resolve to the
// sibling-checkout's built `dist/index.js`. Single canonical path,
// matches what the link override intends.
const contractsDist = fileURLToPath(new URL('../../../contracts/dist/index.js', import.meta.url));

// Same trick for `@thermal-label/brother-ql-core` — the harness app
// imports it directly, and Vite would otherwise pick up the copy
// nested under brother-ql-core's `node_modules/.pnpm/` store via the
// `link:` override rather than the sibling-checkout's freshly-built
// dist.
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
      '@thermal-label/contracts': contractsDist,
      '@thermal-label/brother-ql-core': brotherQlCoreDist,
    },
  },
  optimizeDeps: {
    // Re-bundle `@thermal-label/contracts` whenever the local dist
    // changes. Without this Vite caches the pre-bundled deps and
    // updates to the contracts source don't propagate until you
    // delete `node_modules/.vite/` by hand.
    force: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
});
