/**
 * Brother-QL `DriverAdapter` — wires brother-ql-core + brother-ql-web
 * into the shared harness shell.
 *
 * Single-engine driver: every brother-ql device declares exactly one
 * `PrintEngine`. The shell hides the engine-tabs strip when
 * `device.engines.length <= 1`.
 *
 * USB-only transport: brother-ql declares `usb`, `tcp`, and (on
 * QL_820NWBc / PT_P910BT) `bluetooth-spp` transports in the registry.
 * The browser can't reach raw TCP-9100 sockets and can't open RFCOMM
 * SPP, so this adapter only exposes the WebUSB path.
 *
 * Push status: brother-ql web printer streams unsolicited status
 * frames (lid open/close, media insert, end-of-job, errors) and
 * implements `printer.onStatus`. The shell subscribes automatically
 * so the §1 / §3 pills update in real time without polling cost.
 *
 * Auto-locked media picker: every QL_700+ class engine declares
 * `engine.capabilities.mediaDetection === true`. The shell pulls
 * `printer.getStatus().detectedMedia` from the polled status frame
 * and surfaces it as the auto-locked entry — no per-driver detection
 * callback needed.
 */
import type { DriverAdapter, MockSpec } from '@thermal-label/harness-shell';
import type { PrintEngine } from '@thermal-label/contracts';
import type {
  HardwareReport,
  IdentitySnapshot,
  TransportReport,
} from '@thermal-label/harness-core/shared';
import {
  DEVICES,
  MEDIA,
  type BrotherQLDevice,
  type BrotherQLMedia,
} from '@thermal-label/brother-ql-core';
import { WebBrotherQLPrinter, requestPrinters } from '@thermal-label/brother-ql-web';
import type { MediaGroupKey, MediaSwatch } from '@thermal-label/harness-components/types';
import { MockTransport, type MockTarget } from './transport/mock';
import { findDeviceByVidPid } from './transport/webusb-filters';
import { buildDiagnosticImage } from './diagnostic-print';
import { HARNESS_VERSION, DRIVER_VERSION } from './version';

const DRIVER_KEY = 'brother-ql';
const TARGET_REPO = 'thermal-label/brother-ql';

// ─── Mock targets ────────────────────────────────────────────────

interface MockMeta {
  vid: number;
  pid: number;
  key: string;
  name: string;
  aliases: readonly string[];
}

const MOCK_TARGETS: Record<MockTarget, MockMeta> = {
  ql_820nwbc: {
    vid: 0x04f9,
    pid: 0x209d,
    key: 'QL_820NWBc',
    name: 'QL-820NWBc',
    aliases: ['ql820', 'ql_820', 'ql-820nwbc'],
  },
  ql_810w: { vid: 0x04f9, pid: 0x209c, key: 'QL_810W', name: 'QL-810W', aliases: ['ql810', 'ql_810'] },
  ql_700: { vid: 0x04f9, pid: 0x2042, key: 'QL_700', name: 'QL-700', aliases: ['ql700'] },
  ql_1100: { vid: 0x04f9, pid: 0x20a7, key: 'QL_1100', name: 'QL-1100', aliases: ['ql1100'] },
};

function buildMockTargets(): Record<string, MockSpec<BrotherQLDevice>> {
  const out: Record<string, MockSpec<BrotherQLDevice>> = {};
  for (const [key, meta] of Object.entries(MOCK_TARGETS)) {
    const device = findDeviceByVidPid(meta.vid, meta.pid);
    if (!device) {
      throw new Error(`Mock target ${key} has no matching DEVICES entry — fix mock.ts`);
    }
    out[key] = {
      displayName: meta.name,
      device,
      vid: meta.vid,
      pid: meta.pid,
      aliases: meta.aliases,
    };
  }
  return out;
}

// ─── Media-picker bindings ───────────────────────────────────────

function filterByDeviceEngine(
  media: readonly BrotherQLMedia[],
  _device: BrotherQLDevice,
  engine: PrintEngine,
): readonly BrotherQLMedia[] {
  const compat = engine.mediaCompatibility ?? [];
  return media.filter(m => {
    const targets = m.targetModels ?? [];
    return targets.some(t => compat.includes(t));
  });
}

function groupBy(m: BrotherQLMedia): MediaGroupKey {
  if (m.tapeSystem === 'tze') {
    return {
      key: `tze-${String(m.widthMm)}mm`,
      label: `TZe — ${String(m.widthMm)} mm`,
      priority: 'primary',
      sort: m.widthMm,
    };
  }
  if (m.tapeSystem === 'hse-2to1' || m.tapeSystem === 'hse-3to1') {
    const ratio = m.tapeSystem === 'hse-2to1' ? '2:1' : '3:1';
    return {
      key: `hse-${ratio}-${String(m.widthMm)}mm`,
      label: `HSe ${ratio} heat-shrink — ${String(m.widthMm)} mm`,
      priority: 'secondary',
      sort: m.widthMm,
    };
  }
  // DK family.
  const isWide = (m.targetModels ?? []).includes('dk-wide');
  if (m.palette !== undefined) {
    return { key: 'dk-two-color', label: 'DK two-color', priority: 'primary', sort: 0 };
  }
  if (m.type === 'continuous') {
    return {
      key: isWide ? 'dk-continuous-wide' : 'dk-continuous',
      label: isWide ? 'DK continuous (wide)' : 'DK continuous',
      priority: isWide ? 'secondary' : 'primary',
      sort: m.widthMm,
    };
  }
  return {
    key: isWide ? 'dk-die-cut-wide' : 'dk-die-cut',
    label: isWide ? 'DK die-cut (wide)' : 'DK die-cut',
    priority: isWide ? 'secondary' : 'primary',
    sort: m.widthMm,
  };
}

function swatch(m: BrotherQLMedia): MediaSwatch | null {
  if (m.palette === undefined) return null;
  return { fg: 'red', bg: 'white' };
}

// ─── Mock connect helper ─────────────────────────────────────────

/**
 * Build the per-engine printer map for a mock connect. brother-ql is
 * always single-engine, so this returns a 1-key record keyed by the
 * device's `engines[0].role` (typically `'primary'`). Real connects go
 * through `requestPrinters()` from brother-ql-web — same shape,
 * different source.
 */
function buildMockPrinterMap(
  device: BrotherQLDevice,
  transport: ReturnType<typeof MockTransport.open>,
): Record<string, WebBrotherQLPrinter> {
  const engine = device.engines[0];
  if (!engine) {
    throw new Error(`Brother-QL device ${device.key} has no engines — registry is malformed.`);
  }
  return { [engine.role]: new WebBrotherQLPrinter(device, transport) };
}

// ─── DriverAdapter ───────────────────────────────────────────────

export const adapter: DriverAdapter<BrotherQLDevice, BrotherQLMedia> = {
  driverKey: DRIVER_KEY,
  driverDisplayName: 'Brother QL',
  targetRepo: TARGET_REPO,
  harnessVersion: HARNESS_VERSION,
  driverVersion: DRIVER_VERSION,

  devices: Object.values(DEVICES),
  media: Object.values(MEDIA),
  deviceKey: d => d.key,
  deviceName: d => d.name,

  connect: async opts => {
    // brother-ql is single-engine — the connect-result map is
    // 1-keyed by the engine's own role. Shell binds the active
    // printer via `printers[selectedRole]`.
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

    // Real connect: `requestPrinters()` pops the WebUSB picker, opens
    // IF 0 on the picked device, and returns a 1-key adapter map keyed
    // by the device's `engines[0].role`.
    const printers = await requestPrinters();
    const first = Object.values(printers)[0];
    if (!first) {
      throw new Error(
        'requestPrinters() returned no engines — driver-web reports the picked device has no drivable engines.',
      );
    }
    return {
      printers,
      device: first.device,
      mocked: false,
    };
  },

  mockTargets: buildMockTargets(),
  defaultMockTarget: 'ql_820nwbc',

  mediaPicker: {
    filterByDeviceEngine,
    groupBy,
    swatch,
    describe: m => m.name,
  },

  buildDiagnosticImage: ({ device, engine, media, harnessVersion, driverVersion }) =>
    buildDiagnosticImage({ device, engine, media, harnessVersion, driverVersion }),

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
    const media = primarySession.media;
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
            media: String(media.id),
            tapeWidthMm: String(media.widthMm),
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
