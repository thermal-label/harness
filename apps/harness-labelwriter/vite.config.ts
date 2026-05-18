import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// ── Build-time version injection ─────────────────────────────────
// `src/version.ts` reads the `__HARNESS_VERSION__` / `__DRIVER_VERSION__`
// constants `define`d below so every HardwareReport carries the real
// versions. `HARNESS_VERSION` is this app's own package version;
// `DRIVER_VERSION` is the `labelwriter-core` version actually resolved
// into `node_modules` — read from its `package.json` directly, because
// the package's `exports` field blocks a plain `require` of that path.
const appDir = fileURLToPath(new URL('.', import.meta.url));
const versionOf = (pkgPath: string): string =>
  (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
const HARNESS_VERSION = versionOf(`${appDir}package.json`);
const DRIVER_VERSION = versionOf(
  `${appDir}node_modules/@thermal-label/labelwriter-core/package.json`,
);

// `@thermal-label/contracts` and `@thermal-label/d1-core` are no longer
// aliased — Waves 1-2 published them to npm, so the harness root's pnpm
// override pins both to `^0.6.0` and every importer (the app and the
// linked labelwriter-core sibling) resolves the one registry copy. No
// per-repo `node_modules/.pnpm/` copy can win during bundling anymore.

export default defineConfig({
  plugins: [vue()],
  define: {
    __HARNESS_VERSION__: JSON.stringify(HARNESS_VERSION),
    __DRIVER_VERSION__: JSON.stringify(DRIVER_VERSION),
  },
  // Static-bundle output: relative asset paths so the bundle works
  // when served from a sub-path (docs site mounts at /harness/labelwriter/).
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
