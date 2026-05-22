import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// ── Build-time version injection ─────────────────────────────────
// `src/version.ts` reads the `__HARNESS_VERSION__` / `__DRIVER_VERSION__`
// constants `define`d below so every HardwareReport carries the real
// versions. `HARNESS_VERSION` is this app's own package version;
// `DRIVER_VERSION` is the `marklife-core` version actually resolved
// into `node_modules` — read from its `package.json` directly, because
// the package's `exports` field blocks a plain `require` of that path.
const appDir = fileURLToPath(new URL('.', import.meta.url));
const versionOf = (pkgPath: string): string =>
  (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
const HARNESS_VERSION = versionOf(`${appDir}package.json`);
const DRIVER_VERSION = versionOf(`${appDir}node_modules/@thermal-label/marklife-core/package.json`);

// `@thermal-label/contracts` is no longer aliased — Wave 1 published it
// to npm, so the harness root's pnpm override pins it to `^0.6.0` and
// every importer (the app and the linked marklife-core/-web siblings)
// resolves the one registry copy. The marklife-core/-web packages are
// still unpublished, so the harness root's pnpm override redirects
// `@thermal-label/marklife-core` / `-web` to `link:../marklife/packages/*`
// instead — the linked `dist/` must be built before this app's build.

export default defineConfig({
  plugins: [vue()],
  define: {
    __HARNESS_VERSION__: JSON.stringify(HARNESS_VERSION),
    __DRIVER_VERSION__: JSON.stringify(DRIVER_VERSION),
  },
  // Static-bundle output: relative asset paths so the bundle works
  // when served from a sub-path (docs site mounts at /harness/marklife/).
  base: './',
  resolve: {
    alias: {
      // `marklife-core/src/zlib.ts` (its `marklife-yxq` compressor)
      // hard-imports `deflateSync` / `inflateSync` from `node:zlib`,
      // a Node builtin Vite externalises for the browser — which
      // breaks rollup's named-import resolution. Redirect `node:zlib`
      // to a `pako`-backed shim (the browser path `marklife-core`'s
      // own source comment intends). The P12 is a `marklife-l11`
      // engine — its encoder emits an uncompressed raster, so the
      // shim is never executed at runtime in this app.
      'node:zlib': resolve(appDir, 'src/shims/node-zlib.ts'),
    },
  },
  server: {
    fs: {
      // marklife-core/-web are `link:`-overridden to the sibling
      // checkout (outside the harness root) — they are unpublished.
      // Vite's dev server refuses to serve files outside its
      // allow-list, so widen it to the ~/thermal-label workspace
      // parent. Inert once the override returns to a registry pin.
      allow: ['../../..'],
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
