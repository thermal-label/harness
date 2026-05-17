import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// `@thermal-label/contracts` and `@thermal-label/brother-ql-core` are no
// longer aliased — Waves 1-3 published every consumed package to npm, so
// the harness root's pnpm override pins each to `^0.6.0` and every
// importer resolves the one registry copy. No per-repo
// `node_modules/.pnpm/` copy can win during bundling anymore.

export default defineConfig({
  plugins: [vue()],
  // Static-bundle output: relative asset paths so the bundle works
  // when served from a sub-path (docs site mounts at /harness/brother-ql/).
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
