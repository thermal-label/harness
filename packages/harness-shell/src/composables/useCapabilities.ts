/**
 * Browser capability detection.
 *
 * Feature-tests the Web APIs the harness needs (today: WebUSB), so
 * the UI can refuse to start in browsers where it can't possibly work
 * and give the operator a useful pointer instead of a cryptic stack
 * trace on the first connect attempt.
 *
 * Detection is **capability-based, not user-agent-based.** A future
 * Firefox build that ships WebUSB unlocks every harness app for free;
 * a Chromium fork that disabled WebUSB for some reason is correctly
 * locked out. Mock mode (`?mock=…`) bypasses the gate entirely so the
 * harness can be visually walked from any browser.
 *
 * Today every shipped driver requires WebUSB. When BLE-only drivers
 * (niimbot, letratag) land we'll thread the required-capability list
 * through the adapter and tighten this here; for now we detect all
 * three transports for diagnostic purposes but only enforce
 * `webusb`.
 */
import { isMockMode } from './useMockMode';

export interface BrowserCapabilities {
  /** `navigator.usb` (WebUSB) — required by every driver shipped today. */
  webusb: boolean;
  /** `navigator.serial` (Web Serial) — surfaced for debugging. */
  webserial: boolean;
  /** `navigator.bluetooth` (Web Bluetooth) — surfaced for debugging. */
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

export const REQUIRED_CAPABILITIES = [
  'webusb',
] as const satisfies readonly (keyof BrowserCapabilities)[];

export function canRunOnThisBrowser(): boolean {
  if (isMockMode()) return true;
  return REQUIRED_CAPABILITIES.every(cap => CAPABILITIES[cap]);
}

export function missingCapabilities(): readonly (keyof BrowserCapabilities)[] {
  return REQUIRED_CAPABILITIES.filter(cap => !CAPABILITIES[cap]);
}

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
