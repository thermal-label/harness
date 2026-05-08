/**
 * Browser capability detection.
 *
 * Feature-tests the Web APIs the harness needs (today: WebUSB), so the
 * UI can refuse to start in browsers where it can't possibly work and
 * give the operator a useful pointer instead of a cryptic stack trace
 * on the first connect attempt.
 *
 * Detection is **capability-based, not user-agent-based.** A future
 * Firefox build that ships WebUSB unlocks this harness for free; a
 * Chromium fork that disabled WebUSB for some reason is correctly
 * locked out. Mock mode (`?mock=…`) bypasses the gate entirely so the
 * harness can be visually walked from any browser.
 *
 * Mirror this composable in sibling harnesses (brother-ql, niimbot,
 * ...) but extend the `required` set with `serial`, `bluetooth`, etc.
 * as those harnesses' transports demand.
 */
import { IS_MOCK_MODE } from './useMockMode';

export interface BrowserCapabilities {
  /** `navigator.usb` (WebUSB) — required by labelwriter. */
  webusb: boolean;
  /** `navigator.serial` (Web Serial) — not used today; surfaced for debugging. */
  webserial: boolean;
  /** `navigator.bluetooth` (Web Bluetooth) — not used today; surfaced for debugging. */
  webbluetooth: boolean;
}

function detect(): BrowserCapabilities {
  if (typeof navigator === 'undefined') {
    return { webusb: false, webserial: false, webbluetooth: false };
  }
  return {
    webusb: 'usb' in navigator,
    webserial: 'serial' in navigator,
    webbluetooth: 'bluetooth' in navigator,
  };
}

export const CAPABILITIES: BrowserCapabilities = detect();

/**
 * Required capabilities for this harness app. Today the labelwriter
 * harness only needs WebUSB; broaden as transports are added.
 */
export const REQUIRED_CAPABILITIES = [
  'webusb',
] as const satisfies readonly (keyof BrowserCapabilities)[];

/**
 * True when every required capability is present (or mock-mode is on,
 * which short-circuits the check so the maintainer can self-walk in
 * any browser).
 */
export function canRunOnThisBrowser(): boolean {
  if (IS_MOCK_MODE) return true;
  return REQUIRED_CAPABILITIES.every(cap => CAPABILITIES[cap]);
}

/** Names of required capabilities the current browser does NOT have. */
export function missingCapabilities(): readonly (keyof BrowserCapabilities)[] {
  return REQUIRED_CAPABILITIES.filter(cap => !CAPABILITIES[cap]);
}

/**
 * One-line human-readable summary for the unsupported-browser banner.
 * Doesn't name specific browsers — capability-based, not UA-based —
 * but mentions WebUSB so the operator knows what to look up.
 */
export function summariseMissing(): string {
  const missing = missingCapabilities();
  if (missing.length === 0) return 'All required browser capabilities are available.';
  const labels: Record<keyof BrowserCapabilities, string> = {
    webusb: 'WebUSB (navigator.usb)',
    webserial: 'Web Serial (navigator.serial)',
    webbluetooth: 'Web Bluetooth (navigator.bluetooth)',
  };
  return missing.map(c => labels[c]).join(', ');
}
