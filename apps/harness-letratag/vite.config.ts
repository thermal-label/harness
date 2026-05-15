import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

// Sibling-checkout layout: `link:` overrides in the harness root's
// pnpm config cover the workspace's direct deps, but linked sibling
// packages (`@thermal-label/transport`, `@thermal-label/letratag-core`,
// `@thermal-label/letratag-web`) carry their own pre-installed
// `@thermal-label/contracts` in their per-repo `node_modules/.pnpm/`
// stores at whatever version they pinned. Without explicit aliasing,
// Vite picks up one of those transitive copies and a freshly-added
// export on the local checkout (e.g. `pollingOnStatus`) shows up as
// missing at module-load time.
//
// Force every import of `@thermal-label/contracts` to resolve to the
// sibling-checkout's built `dist/index.js`. Same trick the other
// harness apps use.
const contractsDist = fileURLToPath(new URL('../../../contracts/dist/index.js', import.meta.url));

export default defineConfig({
  plugins: [vue()],
  // Static-bundle output: relative asset paths so the bundle works
  // when served from a sub-path (docs site mounts at /harness/letratag/).
  base: './',
  resolve: {
    alias: {
      '@thermal-label/contracts': contractsDist,
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
