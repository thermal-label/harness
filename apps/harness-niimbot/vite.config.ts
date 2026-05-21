import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

// Sibling-checkout layout: same alias trick as the other harness
// apps. Force every import of `@thermal-label/contracts` to resolve
// to the sibling-checkout's built `dist/index.js` so a freshly-added
// export on the local checkout doesn't get masked by a transitively-
// installed copy in any driver-core's `.pnpm/` store.
const contractsDist = fileURLToPath(
  new URL('../../../contracts/dist/index.js', import.meta.url),
);

export default defineConfig({
  plugins: [vue()],
  // Static-bundle output: relative asset paths so the bundle works
  // when served from a sub-path (docs site mounts at /harness/niimbot/).
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
