/**
 * Build-time version constants for the harness app.
 *
 * Both values are injected by `vite.config.ts` via `define` (see its
 * `__HARNESS_VERSION__` / `__DRIVER_VERSION__` block):
 *  - `HARNESS_VERSION` — this app's own `package.json` version.
 *  - `DRIVER_VERSION`  — the `<driver>-core` version actually resolved
 *    into `node_modules` and bundled.
 *
 * `define` applies to both `vite dev` and `vite build`, so dev and
 * production reports alike carry real versions. Vitest runs from a
 * separate config with no `define`; the `typeof` guard makes the
 * module fall back to `'0.0.0-dev'` under test.
 */
declare const __HARNESS_VERSION__: string | undefined;
declare const __DRIVER_VERSION__: string | undefined;

export const HARNESS_VERSION =
  typeof __HARNESS_VERSION__ === 'string' ? __HARNESS_VERSION__ : '0.0.0-dev';

export const DRIVER_VERSION =
  typeof __DRIVER_VERSION__ === 'string' ? __DRIVER_VERSION__ : '0.0.0-dev';
