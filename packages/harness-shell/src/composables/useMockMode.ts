/**
 * Mock-mode detection from the URL query string.
 *
 * `?mock=1` (or any truthy value) enables mock-transport mode. An
 * explicit `?mock=<key>` selects which model to pretend to be, where
 * `<key>` is one of the keys in the active adapter's `mockTargets`
 * (or any `aliases[]` entry, case-insensitive).
 *
 * Gated to dev builds (`import.meta.env.DEV === true`). Production
 * bundles published to `thermal-label.github.io/harness/<driver>/`
 * ignore `?mock=` entirely — public users don't need it, and a
 * silently-mocked report submission is a footgun (per plan-06 + the
 * recent dev-only gate commit).
 *
 * The query is read on first call (lazy memoisation) so adapter
 * mockTargets are visible by the time `parseFromAdapter` runs.
 */
import { useAdapter } from '../state/adapterContext';
import type { MockSpec } from '../types';

export interface MockMode<TDevice> {
  /** True when the harness is running in mock-transport mode. */
  isMock: boolean;
  /** Which mock-target key the URL resolved to (when `isMock`). */
  target: string | null;
  /** The resolved mock spec (when `isMock`). */
  spec: MockSpec<TDevice> | null;
}

/**
 * Bare boolean — does the URL ask for mock mode? Used by
 * `useCapabilities` to bypass the WebUSB gate before the adapter is
 * available. Still respects the `import.meta.env.DEV` gate.
 */
export function isMockMode(): boolean {
  if (typeof window === 'undefined') return false;
  if (!import.meta.env.DEV) return false;
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('mock');
  if (raw === null) return false;
  const lowered = raw.toLowerCase();
  return lowered !== '' && lowered !== '0' && lowered !== 'false';
}

export function useMockMode<TDevice>(): MockMode<TDevice> {
  if (!isMockMode()) {
    return { isMock: false, target: null, spec: null };
  }
  const adapter = useAdapter<TDevice, never, never>();
  const params = new URLSearchParams(window.location.search);
  const raw = (params.get('mock') ?? '').toLowerCase();
  const targets = adapter.mockTargets;

  // Match either the canonical key or any alias (case-insensitive).
  let resolved: string | null = null;
  for (const [key, spec] of Object.entries(targets)) {
    if (key.toLowerCase() === raw) {
      resolved = key;
      break;
    }
    const aliases = spec.aliases ?? [];
    if (aliases.some(a => a.toLowerCase() === raw)) {
      resolved = key;
      break;
    }
  }
  // `?mock=1` (or any truthy value with no matching alias) falls back
  // to the adapter's defaultMockTarget, or the first declared target
  // when no default is set.
  resolved ??= adapter.defaultMockTarget ?? Object.keys(targets)[0] ?? null;
  if (resolved === null) {
    return { isMock: false, target: null, spec: null };
  }
  const spec = targets[resolved];
  if (!spec) {
    return { isMock: false, target: null, spec: null };
  }
  return {
    isMock: true,
    target: resolved,
    spec,
  };
}
