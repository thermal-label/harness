/**
 * Build-time version constants for the harness app.
 *
 * `HARNESS_VERSION` is this app's package version; `DRIVER_VERSION`
 * is the niimbot-core version we built against. CI will inject real
 * strings via `vite.config.ts` define so issue bodies report actual
 * versions; locally these fall back to "0.0.0-dev".
 */
export const HARNESS_VERSION = '0.0.0-dev';
export const DRIVER_VERSION = '0.0.0';
