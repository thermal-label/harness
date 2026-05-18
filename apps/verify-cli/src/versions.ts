/**
 * Version resolution for verify-cli reports.
 *
 * `HARNESS_VERSION` is verify-cli's own `package.json` version.
 * `driverVersion()` reads the resolved `<driver>-core` package's
 * `package.json` straight from `node_modules` — the package's
 * `exports` field blocks a plain `require` of that subpath, and the
 * CLI runs from source under `tsx`, so there is no bundler `define`
 * step to lean on.
 *
 * Both paths resolve relative to this module, so they work whether the
 * CLI runs from `src/` (tsx) or a built `dist/`.
 */
import { readFileSync } from 'node:fs';

function versionAt(specifier: string): string {
  const url = new URL(specifier, import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version;
}

/** verify-cli's own package version. */
export const HARNESS_VERSION = versionAt('../package.json');

/**
 * Resolve the version of a linked `<driver>-core` package — e.g.
 * `driverVersion('@thermal-label/labelmanager-core')`.
 */
export function driverVersion(driverPackage: string): string {
  return versionAt(`../node_modules/${driverPackage}/package.json`);
}
