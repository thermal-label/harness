import type { TransportType } from '@thermal-label/contracts';

/**
 * One transport's connect-step instruction surface.
 *
 * `inline` is a short blurb shown in the harness's connect panel — what the
 * operator does to surface their device. `docsLink` points to the canonical
 * walkthrough on thermal-label.github.io for the elaborate cases (WebUSB
 * platform setup, BLE pairing on Linux, etc.); the harness UI renders it as
 * a "More help →" link.
 */
export interface TransportInstruction {
  inline: string;
  docsLink?: string;
}

/**
 * Per-transport connect instructions, keyed by `TransportType`. Cross-driver
 * concern (Web Bluetooth onboarding is the same regardless of printer), so
 * it lives in `harness-core/shared` rather than per-driver in each app.
 *
 * Keep blurbs short: one or two sentences fit in the connect panel without
 * scrolling. Anything longer goes behind `docsLink`. Update this registry
 * here, not by patching driver repos — drivers stay unaware of the harness.
 */
export const transportInstructions: Readonly<
  Record<TransportType, TransportInstruction>
> = {
  usb: {
    inline:
      'Plug the printer in over USB and click "Connect" — the browser prompt picks the device. Linux may need a udev rule or sudo for first-time access.',
    docsLink: 'https://thermal-label.github.io/guides/webusb-setup',
  },
  tcp: {
    inline:
      'Make sure the printer is on the same network and reachable on TCP/9100. Enter its IP address (or hostname) when prompted.',
    docsLink: 'https://thermal-label.github.io/guides/tcp-9100',
  },
  serial: {
    inline:
      'Connect over USB-serial or RS-232 and pick the port from the Web Serial prompt. Match the baud rate the printer documents.',
    docsLink: 'https://thermal-label.github.io/guides/web-serial',
  },
  'bluetooth-spp': {
    inline:
      'Pair the printer in your OS Bluetooth settings first, then click "Connect" so the harness can open the SPP serial channel.',
    docsLink: 'https://thermal-label.github.io/guides/bluetooth-spp',
  },
  'bluetooth-gatt': {
    inline:
      'No OS-level pairing is required — click "Connect" and pick the printer in the Web Bluetooth chooser. Keep the printer awake during the handshake.',
    docsLink: 'https://thermal-label.github.io/guides/web-bluetooth',
  },
};
