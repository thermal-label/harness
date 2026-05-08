/**
 * Build-time version constants for the harness app.
 *
 * `HARNESS_VERSION` is this app's package version (rolled by Vite at
 * build via `define`); `DRIVER_VERSION` is the labelmanager-core
 * version we built against.
 *
 * For local dev these fall back to "0.0.0-dev"; CI will inject the
 * real strings via `vite.config.ts` define so issue bodies report
 * actual versions. We keep both behind a single module so callers
 * (PrintSection / SubmitSection / report-builder) don't sprinkle
 * `import.meta.env` reads everywhere.
 */
export const HARNESS_VERSION = '0.0.0-dev';
export const DRIVER_VERSION = '0.5.1';
