import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// `@thermal-label/contracts` is no longer aliased — Wave 1 published it
// to npm, so the harness root's pnpm override pins it to `^0.6.0` and
// every importer (the app and the linked letratag-core/-web siblings)
// resolves the one registry copy. No per-repo `node_modules/.pnpm/`
// copy can win during bundling anymore.

export default defineConfig({
  plugins: [vue()],
  // Static-bundle output: relative asset paths so the bundle works
  // when served from a sub-path (docs site mounts at /harness/letratag/).
  base: './',
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
