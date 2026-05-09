/**
 * Mock-mode detection from the URL query string.
 *
 * `?mock=1` (or any truthy value) enables mock-transport mode. An
 * explicit `?mock=lw550` etc. selects which model to pretend to be.
 *
 * Gated to dev builds (`import.meta.env.DEV === true`). Production
 * bundles published to `thermal-label.github.io/harness/labelwriter/`
 * ignore `?mock=` entirely — public users don't need it, and a
 * silently-mocked report submission is a footgun.
 *
 * Read once at module load — the URL doesn't change during the
 * session, so we don't need reactivity.
 */
import type { MockTarget } from '../transport/mock';

function parseQuery(): { mock: boolean; target: MockTarget } {
  if (typeof window === 'undefined') return { mock: false, target: 'lw330turbo' };
  if (!import.meta.env.DEV) return { mock: false, target: 'lw330turbo' };
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('mock');
  if (raw === null) return { mock: false, target: 'lw330turbo' };

  // Truthy values enable mock with the default target (LW 330 Turbo
  // — the maintainer's bench unit). String values pick a target.
  switch (raw) {
    case 'lw550':
    case 'LW_550':
      return { mock: true, target: 'lw550' };
    case 'lw5xl':
    case 'LW_5XL':
      return { mock: true, target: 'lw5xl' };
    case 'lw330turbo':
    case 'LW_330_TURBO':
      return { mock: true, target: 'lw330turbo' };
    case 'duo':
    case 'lw_450_duo':
    case 'LW_450_DUO':
      return { mock: true, target: 'lw_450_duo' };
    case '0':
    case 'false':
    case '':
      return { mock: false, target: 'lw330turbo' };
    default:
      return { mock: true, target: 'lw330turbo' };
  }
}

const { mock, target } = parseQuery();

/** True when the harness is running in mock-transport mode. */
export const IS_MOCK_MODE = mock;

/** Which model the mock transport pretends to be. */
export const MOCK_TARGET = target;
