/**
 * LabelWriter `DriverAdapter` — wires labelwriter-core + labelwriter-web
 * into the shared harness shell.
 *
 * Multi-engine model (plan-09): Twin Turbo + 450 Twin (`left` /
 * `right` roles, in-band roll-select on a single USB endpoint) and
 * 450 Duo + Duo 96 / Duo 128 (`label` / `tape` roles) all declare
 * more than one `PrintEngine`. The shell renders engine tabs iff
 * `device.engines.length > 1` — single-engine LWs (3xx/4xx/5xx) skip
 * the strip entirely.
 *
 * Per-engine routing happens inside the driver — `requestPrinters()`
 * returns a `Record<role, WebLabelWriterPrinter>` covering every
 * drivable engine on the picked device. Each printer instance is
 * scoped to one engine (single transport, single protocol). The
 * harness shell flips the active printer when the operator changes
 * engine tabs; no facade or duck-typed `setActiveEngine` involved.
 */
import type { DriverAdapter, MockSpec } from '@thermal-label/harness-shell';
import type { PrintEngine, PrinterAdapter } from '@thermal-label/contracts';
import type {
  HardwareReport,
  IdentitySnapshot,
  EngineReport,
  TransportReport,
} from '@thermal-label/harness-core/shared';
import {
  DEVICES,
  MEDIA,
  type LabelWriterAnyMedia,
  type LabelWriterDevice,
  type LabelWriterMedia,
  type LabelWriterTapeMedia,
} from '@thermal-label/labelwriter-core';
import { WebLabelWriterPrinter, requestPrinters } from '@thermal-label/labelwriter-web';
import type { MediaGroupKey, MediaSwatch } from '@thermal-label/harness-components/types';
import { MockTransport, type MockTarget } from './transport/mock';
import { findDeviceByVidPid } from './transport/webusb-filters';
import { buildDiagnosticImage } from './diagnostic-print';
import { HARNESS_VERSION, DRIVER_VERSION } from './version';

const DRIVER_KEY = 'labelwriter';
const TARGET_REPO = 'thermal-label/labelwriter';

// ─── Mock targets ────────────────────────────────────────────────

interface MockMeta {
  vid: number;
  pid: number;
  key: string;
  name: string;
  aliases: readonly string[];
}

const MOCK_TARGETS: Record<MockTarget, MockMeta> = {
  lw330turbo: {
    vid: 0x0922,
    pid: 0x0008,
    key: 'LW_330_TURBO',
    name: 'LabelWriter 330 Turbo',
    aliases: ['LW_330_TURBO'],
  },
  lw550: { vid: 0x0922, pid: 0x0028, key: 'LW_550', name: 'LabelWriter 550', aliases: ['LW_550'] },
  lw5xl: { vid: 0x0922, pid: 0x002a, key: 'LW_5XL', name: 'LabelWriter 5XL', aliases: ['LW_5XL'] },
  lw_450_duo: {
    vid: 0x0922,
    pid: 0x0023,
    key: 'LW_450_DUO',
    name: 'LabelWriter 450 Duo',
    aliases: ['duo', 'LW_450_DUO'],
  },
};

function buildMockTargets(): Record<string, MockSpec<LabelWriterDevice>> {
  const out: Record<string, MockSpec<LabelWriterDevice>> = {};
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

function isLabelMedia(m: unknown): m is LabelWriterMedia {
  if (typeof m !== 'object' || m === null) return false;
  const t = (m as { type?: string }).type;
  return t === 'die-cut' || t === 'continuous';
}

function isTapeMedia(m: unknown): m is LabelWriterTapeMedia {
  if (typeof m !== 'object' || m === null) return false;
  return (m as { type?: string }).type === 'tape';
}

function filterByDeviceEngine(
  media: readonly LabelWriterAnyMedia[],
  _device: LabelWriterDevice,
  engine: PrintEngine,
): readonly LabelWriterAnyMedia[] {
  const isTape = engine.protocol === 'd1-tape';
  const all = media as readonly unknown[];
  const byType = isTape ? all.filter(isTapeMedia) : all.filter(isLabelMedia);
  const compat = engine.mediaCompatibility;
  if (compat === undefined) return byType;
  return byType.filter(m => {
    const targets = m.targetModels ?? [];
    return targets.some(t => compat.includes(t));
  });
}

const PRIMARY_LABEL_CATEGORIES = new Set(['address', 'shipping', 'multi-purpose']);

function groupBy(m: LabelWriterAnyMedia): MediaGroupKey {
  if (isTapeMedia(m)) {
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
      key: `tape-${String(m.tapeWidthMm)}mm`,
      label: `${String(m.tapeWidthMm)} mm tape`,
      priority: 'primary',
      sort: m.tapeWidthMm,
    };
  }
  const cat = m.category ?? 'other';
  const isPrimary = PRIMARY_LABEL_CATEGORIES.has(cat);
  return {
    key: `cat-${cat}`,
    label: cat
      .split('-')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' '),
    priority: isPrimary ? 'primary' : 'secondary',
  };
}

function swatch(m: LabelWriterAnyMedia): MediaSwatch | null {
  if (!isTapeMedia(m)) return null;
  const out: MediaSwatch = {};
  if (m.text !== undefined) out.fg = m.text;
  if (m.background !== undefined) out.bg = m.background;
  return out;
}

// ─── Mock connect helper ─────────────────────────────────────────

/**
 * Build the per-engine printer map for a mock connect. Single-engine
 * mocks return a 1-key record; the Duo mock returns two adapters
 * sharing one MockTransport (good enough for dev — real-hardware
 * smoke-tests catch the per-interface routing). The encoder
 * dispatches by `engine.protocol` regardless of transport identity,
 * so each adapter still emits the right protocol bytes; they just
 * land on the same captured stream.
 */
function buildMockPrinterMap(
  device: LabelWriterDevice,
  transport: ReturnType<typeof MockTransport.open>,
): Record<string, PrinterAdapter> {
  const out: Record<string, PrinterAdapter> = {};
  for (const engine of device.engines) {
    out[engine.role] = new WebLabelWriterPrinter(device, transport, { engine });
  }
  return out;
}

// ─── DriverAdapter ───────────────────────────────────────────────

export const adapter: DriverAdapter<LabelWriterDevice, LabelWriterAnyMedia> = {
  driverKey: DRIVER_KEY,
  driverDisplayName: 'LabelWriter',
  targetRepo: TARGET_REPO,
  harnessVersion: HARNESS_VERSION,
  driverVersion: DRIVER_VERSION,

  devices: Object.values(DEVICES),
  media: Object.values(MEDIA),
  deviceKey: d => d.key,
  deviceName: d => d.name,

  connect: async opts => {
    if (opts.mock) {
      const target = (opts.mockTarget ?? 'lw330turbo') as MockTarget;
      const meta = MockTransport.identityFor(target);
      const device = findDeviceByVidPid(meta.vid, meta.pid);
      if (!device) {
        throw new Error(`Mock target ${target} has no matching DEVICES entry — fix mock.ts`);
      }
      const transport = MockTransport.open(target);
      return { printers: buildMockPrinterMap(device, transport), device, mocked: true };
    }

    // Real connect: `requestPrinters()` pops the WebUSB picker, opens
    // one transport per engine on multi-interface composites (Duo —
    // `label` on IF 0, `tape` on IF 1), and returns a per-engine
    // adapter map. Single-interface devices (3xx/4xx/5xx + Twin
    // Turbo) come back with one entry per engine sharing a single
    // transport — same record shape, fewer USB claims.
    const printers = await requestPrinters();
    const first = Object.values(printers)[0];
    if (!first) {
      throw new Error(
        'requestPrinters() returned no engines — driver-web reports the picked device has no drivable engines.',
      );
    }
    return {
      printers,
      device: first.device as LabelWriterDevice,
      mocked: false,
    };
  },

  mockTargets: buildMockTargets(),
  defaultMockTarget: 'lw330turbo',

  mediaPicker: {
    filterByDeviceEngine,
    groupBy,
    swatch,
    describe: m => m.name,
  },

  buildDiagnosticImage: ({ device, engine, media, harnessVersion, driverVersion }) =>
    buildDiagnosticImage({ device, engine, media, harnessVersion, driverVersion }),

  buildReport: ({
    device,
    identity,
    primarySession,
    allSessions,
    multiEngine,
    mocked,
    reporter,
  }) => {
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
    const engineReports: EngineReport[] = allSessions.flatMap<EngineReport>(s => {
      if (s.rung === null || s.media === null) return [];
      return [
        {
          role: s.engine.role,
          mediaKey: String(s.media.id),
          rung: s.rung,
          ...(s.notes.trim() ? { notes: s.notes.trim() } : {}),
        },
      ];
    });
    return {
      schemaVersion: 1,
      driver: DRIVER_KEY,
      driverVersion: DRIVER_VERSION,
      harnessVersion: HARNESS_VERSION,
      device: {
        detected,
        confirmed: {
          model: device.name,
          ...(usb ? { vid: parseInt(usb.vid, 16), pid: parseInt(usb.pid, 16) } : {}),
          overrides: { label: String(primarySession.media.id) },
        },
      },
      transports: [transportReport],
      ...(multiEngine && engineReports.length > 0 ? { engines: engineReports } : {}),
      submittedAt: new Date().toISOString(),
      ...(reporter ? { reporter: { handle: reporter } } : {}),
    } satisfies HardwareReport;
  },
};
