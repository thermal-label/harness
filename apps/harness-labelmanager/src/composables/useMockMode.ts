/**
 * Mock-mode detection from the URL query string.
 *
 * `?mock=1` (or any truthy value) enables mock-transport mode. An
 * explicit `?mock=lm280` etc. selects which model to pretend to be.
 *
 * Gated to dev builds (`import.meta.env.DEV === true`). Production
 * bundles published to `thermal-label.github.io/harness/labelmanager/`
 * ignore `?mock=` entirely — public users don't need it, and a
 * silently-mocked report submission is a footgun.
 *
 * Read once at module load — the URL doesn't change during the
 * session, so we don't need reactivity.
 */
import type { MockTarget } from '../transport/mock';

function parseQuery(): { mock: boolean; target: MockTarget } {
  if (typeof window === 'undefined') return { mock: false, target: 'lm_pnp' };
  if (!import.meta.env.DEV) return { mock: false, target: 'lm_pnp' };
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('mock');
  if (raw === null) return { mock: false, target: 'lm_pnp' };

  // Truthy values enable mock with the default target (LM PnP — the
  // maintainer's bench unit). String values pick a specific target.
  const lowered = raw.toLowerCase();
  switch (lowered) {
    case 'lm_pnp':
    case 'lmpnp':
    case 'pnp':
      return { mock: true, target: 'lm_pnp' };
    case 'lm280':
    case 'lm_280':
      return { mock: true, target: 'lm_280' };
    case 'lm400':
    case 'lm_400':
      return { mock: true, target: 'lm_400' };
    case 'lm420p':
    case 'lm_420p':
      return { mock: true, target: 'lm_420p' };
    case 'lm_pc':
    case 'lmpc':
      return { mock: true, target: 'lm_pc' };
    case 'lm_wireless_pnp':
    case 'wireless':
      return { mock: true, target: 'lm_wireless_pnp' };
    case 'labelpoint_350':
    case 'lp350':
      return { mock: true, target: 'labelpoint_350' };
    case 'mobile_labeler':
    case 'mobile':
      return { mock: true, target: 'mobile_labeler' };
    case '0':
    case 'false':
    case '':
      return { mock: false, target: 'lm_pnp' };
    default:
      return { mock: true, target: 'lm_pnp' };
  }
}

const { mock, target } = parseQuery();

/** True when the harness is running in mock-transport mode. */
export const IS_MOCK_MODE = mock;

/** Which model the mock transport pretends to be. */
export const MOCK_TARGET = target;
