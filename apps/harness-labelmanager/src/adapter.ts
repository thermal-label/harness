/**
 * Labelmanager `DriverAdapter` — wires labelmanager-core + labelmanager-web
 * into the shared harness shell.
 *
 * Post-harness-v2 the adapter contributes only:
 *  - registry imports (DEVICES, MEDIA_LIST, types)
 *  - connect: real path uses `requestPrinter()` from labelmanager-web;
 *    mock path instantiates `WebDymoPrinter` with a `MockTransport`
 *  - mock targets
 *  - diagnostic-image builder (RGBA — driver dithers)
 *  - media-picker bindings (filter, group, swatch, describe)
 *  - report builder
 *
 * Status polling, status pills, identity hex-dumps, manual VID/PID,
 * device-override dropdowns, custom-dimensions drawer — all owned by
 * the shell now.
 */
import type { DriverAdapter, MockSpec } from '@thermal-label/harness-shell';
import type {
  HardwareReport,
  IdentitySnapshot,
  TransportReport,
} from '@thermal-label/harness-core/shared';
import {
  DEVICES,
  MEDIA_LIST,
  type LabelManagerDevice,
  type LabelManagerMedia,
  type TapeWidth,
} from '@thermal-label/labelmanager-core';
import { WebDymoPrinter, requestPrinters } from '@thermal-label/labelmanager-web';
import type { MediaGroupKey, MediaSwatch } from '@thermal-label/harness-components/types';
import { MockTransport, type MockTarget } from './transport/mock';
import { findDeviceByVidPid } from './transport/webusb-filters';
import { buildDiagnosticImage } from './diagnostic-print';
import { HARNESS_VERSION, DRIVER_VERSION } from './version';

const DRIVER_KEY = 'labelmanager';
const TARGET_REPO = 'thermal-label/labelmanager';

const HEAD_DOTS_FOR_TAPE: Record<TapeWidth, number> = {
  6: 32,
  9: 48,
  12: 64,
  19: 64,
};

// ─── Mock targets ────────────────────────────────────────────────

interface MockMeta {
  vid: number;
  pid: number;
  key: string;
  name: string;
  aliases: readonly string[];
}

const MOCK_TARGETS: Record<MockTarget, MockMeta> = {
  lm_pnp: { vid: 0x0922, pid: 0x1002, key: 'LM_PNP', name: 'LabelManager PnP', aliases: ['lmpnp', 'pnp'] },
  lm_280: { vid: 0x0922, pid: 0x1006, key: 'LM_280', name: 'LabelManager 280', aliases: ['lm280'] },
  lm_400: { vid: 0x0922, pid: 0x0013, key: 'LM_400', name: 'LabelManager 400', aliases: ['lm400'] },
  lm_420p: { vid: 0x0922, pid: 0x1004, key: 'LM_420P', name: 'LabelManager 420P', aliases: ['lm420p'] },
  lm_pc: { vid: 0x0922, pid: 0x0011, key: 'LM_PC', name: 'LabelManager PC', aliases: ['lmpc'] },
  lm_wireless_pnp: {
    vid: 0x0922,
    pid: 0x1008,
    key: 'LM_WIRELESS_PNP',
    name: 'LabelManager Wireless PnP',
    aliases: ['wireless'],
  },
  labelpoint_350: {
    vid: 0x0922,
    pid: 0x0015,
    key: 'LABELPOINT_350',
    name: 'LabelPoint 350',
    aliases: ['lp350'],
  },
  mobile_labeler: {
    vid: 0x0922,
    pid: 0x1009,
    key: 'MOBILE_LABELER',
    name: 'Mobile Labeler',
    aliases: ['mobile'],
  },
};

function buildMockTargets(): Record<string, MockSpec<LabelManagerDevice>> {
  const out: Record<string, MockSpec<LabelManagerDevice>> = {};
  for (const [key, meta] of Object.entries(MOCK_TARGETS)) {
    const device = findDeviceByVidPid(meta.vid, meta.pid);
    if (!device) {
      throw new Error(`Mock target ${key} has no matching DEVICES entry — fix mock.ts`);
    }
    // Plan 11 MockSpec discriminated-union shape: USB targets carry
    // `transport: 'usb'` + a `filter: { vid, pid }` block.
    out[key] = {
      displayName: meta.name,
      device,
      transport: 'usb',
      filter: { vid: meta.vid, pid: meta.pid },
      aliases: meta.aliases,
    };
  }
  return out;
}

// ─── Media-picker bindings ───────────────────────────────────────

function groupBy(m: LabelManagerMedia): MediaGroupKey {
  const isRhino = typeof m.material === 'string' && m.material.startsWith('rhino-');
  if (isRhino) {
    return {
      key: `rhino-${String(m.tapeWidthMm)}mm`,
      label: `Rhino industrial — ${String(m.tapeWidthMm)} mm`,
      priority: 'secondary',
      sort: m.tapeWidthMm,
    };
  }
  return {
    key: `${String(m.tapeWidthMm)}mm`,
    label: `${String(m.tapeWidthMm)} mm  ·  head ${String(HEAD_DOTS_FOR_TAPE[m.tapeWidthMm])} dots`,
    priority: 'primary',
    sort: m.tapeWidthMm,
  };
}

function swatch(m: LabelManagerMedia): MediaSwatch | null {
  const out: MediaSwatch = {};
  if (m.text !== undefined) out.fg = m.text;
  if (m.background !== undefined) out.bg = m.background;
  return out;
}

// ─── Mock connect helper ─────────────────────────────────────────

/**
 * Build the per-engine printer map for a mock connect. LM is always
 * single-engine, so this returns a 1-key record keyed by the device's
 * `engines[0].role` (typically `'primary'`). Real connects go through
 * `requestPrinters()` from labelmanager-web — same shape, different
 * source.
 */
function buildMockPrinterMap(
  device: LabelManagerDevice,
  transport: ReturnType<typeof MockTransport.open>,
): Record<string, WebDymoPrinter> {
  const engine = device.engines[0];
  if (!engine) {
    throw new Error(`LabelManager device ${device.key} has no engines — registry is malformed.`);
  }
  return { [engine.role]: new WebDymoPrinter(device, transport) };
}

// ─── DriverAdapter ───────────────────────────────────────────────

export const adapter: DriverAdapter<LabelManagerDevice, LabelManagerMedia> = {
  driverKey: DRIVER_KEY,
  driverDisplayName: 'LabelManager',
  targetRepo: TARGET_REPO,
  harnessVersion: HARNESS_VERSION,
  driverVersion: DRIVER_VERSION,

  devices: Object.values(DEVICES),
  media: MEDIA_LIST,
  deviceKey: d => d.key,
  deviceName: d => d.name,

  connect: async opts => {
    // LM is single-engine — the connect-result map is always 1-keyed
    // by the engine's own role (`primary`). The shell binds the
    // active printer through `printers[selectedRole]`, which on
    // single-engine devices is just the lone entry.
    if (opts.mock && opts.mockTarget) {
      const target = opts.mockTarget as MockTarget;
      const meta = MockTransport.identityFor(target);
      const device = findDeviceByVidPid(meta.vid, meta.pid);
      if (!device) {
        throw new Error(`Mock target ${target} has no matching DEVICES entry — fix mock.ts`);
      }
      const transport = MockTransport.open(target);
      return { printers: buildMockPrinterMap(device, transport), device, mocked: true };
    }

    // Real connect: `requestPrinters({ transport: 'usb' })` pops the
    // WebUSB picker, opens the LM's IF 0 transport, and returns a
    // 1-key adapter map keyed by the picked device's `engines[0].role`.
    // LM is USB-only, so the transport tag is always `'usb'` — the
    // adapter ignores any other value from `opts.transport`.
    const printers = await requestPrinters({ transport: 'usb' });
    const first = Object.values(printers)[0];
    if (!first || !first.device) {
      throw new Error(
        'requestPrinters() returned no engines — driver-web reports the picked device has no drivable engines.',
      );
    }
    // labelmanager-web always populates `printer.device` with a
    // LabelManagerDevice from its own registry — the contracts-typed
    // `DeviceEntry | undefined` narrows here at the driver boundary.
    return {
      printers,
      device: first.device as LabelManagerDevice,
      mocked: false,
    };
  },

  mockTargets: buildMockTargets(),
  defaultMockTarget: 'lm_pnp',

  mediaPicker: {
    filterByDeviceEngine: (media, device) => {
      const compat = device.engines[0]?.mediaCompatibility ?? [];
      return media.filter(m => {
        const targets = m.targetModels ?? [];
        return targets.some(t => compat.includes(t));
      });
    },
    groupBy,
    swatch,
    describe: m => m.name,
  },

  buildDiagnosticImage: ({ device, media, harnessVersion, driverVersion }) =>
    buildDiagnosticImage({ device, media, harnessVersion, driverVersion }),

  buildReport: ({ device, identity, primarySession, mocked, reporter }) => {
    if (primarySession.rung === null || primarySession.media === null) {
      throw new Error('buildReport: primary session must have rung and media set.');
    }
    const usb = device.transports.usb;
    const transportReport: TransportReport = {
      name: 'usb',
      patterns: { diagnostic: 'pass' },
      rung: primarySession.rung,
      ...(primarySession.notes.trim() ? { notes: primarySession.notes.trim() } : {}),
    };
    const detected: IdentitySnapshot = {
      ...identity,
      extra: { ...identity.extra, ...(mocked ? { mocked: true } : {}) },
    };
    const report: HardwareReport = {
      schemaVersion: 1,
      driver: DRIVER_KEY,
      driverVersion: DRIVER_VERSION,
      harnessVersion: HARNESS_VERSION,
      device: {
        detected,
        confirmed: {
          model: device.name,
          ...(usb ? { vid: parseInt(usb.vid, 16), pid: parseInt(usb.pid, 16) } : {}),
          overrides: {
            media: String(primarySession.media.id),
            tapeWidthMm: String(primarySession.media.tapeWidthMm),
          },
        },
      },
      transports: [transportReport],
      submittedAt: new Date().toISOString(),
      ...(reporter ? { reporter: { handle: reporter } } : {}),
    };
    return report;
  },
};
