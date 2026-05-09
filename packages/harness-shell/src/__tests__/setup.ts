/**
 * Vitest setup — runs before any test file's imports resolve.
 *
 * happy-dom doesn't ship `navigator.usb`. The shell's
 * `useCapabilities` composable snapshots `'usb' in navigator` once at
 * module-load time, so the polyfill must be in place BEFORE any test
 * imports `HarnessShell.vue` (which transitively imports
 * `useCapabilities`). Vitest's `setupFiles` runs before test imports
 * — that's where this lives.
 */
if (typeof navigator !== 'undefined' && !('usb' in navigator)) {
  Object.defineProperty(navigator, 'usb', {
    configurable: true,
    value: {
      // eslint-disable-next-line @typescript-eslint/require-await -- mock surface; the real WebUSB methods return Promises so the type contract demands async, but the smoke test never invokes either fn.
      getDevices: async (): Promise<unknown[]> => [],
      // eslint-disable-next-line @typescript-eslint/require-await -- mock surface; see above.
      requestDevice: async (): Promise<unknown> => {
        throw new Error('not implemented in smoke test');
      },
    },
  });
}
