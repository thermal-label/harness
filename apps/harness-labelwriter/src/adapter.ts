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
import type {
  ConnectResult,
  DriverAdapter,
  MockSpec,
  CustomMediaInput,
} from '@thermal-label/harness-shell';
import { buildReportDiagnostics } from '@thermal-label/harness-shell';
import type { PrintEngine, PrinterAdapter } from '@thermal-label/contracts';
import {
  toHex,
  type EngineVersionSnapshot,
  type HardwareReport,
  type IdentitySnapshot,
  type EngineReport,
  type SkuInfoSnapshot,
  type TransportReport,
} from '@thermal-label/harness-core/shared';
import {
  DEVICES,
  MEDIA,
  type EngineVersion,
  type LabelWriterAnyMedia,
  type LabelWriterDevice,
  type LabelWriterMedia,
  type LabelWriterTapeMedia,
  type SkuInfo,
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
  // LW 550 reporting an NFC SKU absent from the media registry — the
  // `detected-unrecognized` walk-through URL for the 550 retester.
  lw_550_unknown_media: {
    vid: 0x0922,
    pid: 0x0028,
    key: 'LW_550',
    name: 'LabelWriter 550 (unknown media)',
    aliases: ['550-unknown'],
  },
};

function buildMockTargets(): Record<string, MockSpec<LabelWriterDevice>> {
  const out: Record<string, MockSpec<LabelWriterDevice>> = {};
  for (const [key, meta] of Object.entries(MOCK_TARGETS)) {
    const device = findDeviceByVidPid(meta.vid, meta.pid);
    if (!device) {
      throw new Error(`Mock target ${key} has no matching DEVICES entry — fix mock.ts`);
    }
    // Plan 11 MockSpec discriminated-union shape — LabelWriter is
    // USB-only.
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

/** Sentinel `id` marking a media synthesised by the custom-media flow. */
const CUSTOM_MEDIA_ID = 'custom';

/**
 * Build a printable `LabelWriterMedia` from operator-confirmed
 * dimensions, for the `detected-unrecognized` flow (an NFC SKU not in
 * the catalogue — exactly what walls the LW 550 retester).
 *
 * The 550 encoder (`encode550Label`) derives all geometry from the
 * engine's `headDots` and the bitmap; the media only feeds
 * `getPrintableArea` and the diagnostic-image sizing. So a synthetic
 * `LabelWriterMedia` needs no driver-private fields beyond the base
 * `MediaDescriptor` shape — `widthMm` / `heightMm` / `type` plus a
 * derived `name`, the sentinel `id`, and `skus: [identifier]` when the
 * operator named the roll (so the identifier rides into the report via
 * the media object).
 */
function buildCustomLabelMedia(input: CustomMediaInput): LabelWriterMedia {
  const { widthMm, heightMm, type, identifier } = input;
  const derivedName =
    identifier.trim() ||
    (type === 'die-cut' && heightMm !== undefined
      ? `Custom ${String(widthMm)} × ${String(heightMm)} mm die-cut`
      : `Custom ${String(widthMm)} mm continuous`);
  return {
    id: CUSTOM_MEDIA_ID,
    name: derivedName,
    widthMm,
    type,
    ...(type === 'die-cut' && heightMm !== undefined ? { heightMm } : {}),
    ...(identifier.trim() ? { skus: [identifier.trim()] } : {}),
  };
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

/** Per-engine connect diagnostics surfaced to the harness shell. */
type EngineDiagnostics = NonNullable<ConnectResult<LabelWriterDevice>['engineDiagnostics']>;

/** Project a driver `EngineVersion` into the JSON-safe report snapshot. */
function toEngineVersionSnapshot(v: EngineVersion): EngineVersionSnapshot {
  return {
    hwVersion: v.hwVersion,
    fwKind: v.fwKind,
    // Join the 4-char major/minor into one human-formatted string —
    // the driver owns the format, the report carries it verbatim.
    fwVersion: `${v.fwMajor}.${v.fwMinor}`.trim(),
    fwReleaseDate: v.fwReleaseDate,
    pid: v.pid,
    // Verbatim `ESC V` response — hex so it survives JSON.stringify.
    rawBytes: toHex(v.rawBytes),
  };
}

/**
 * Project a driver `SkuInfo` into the JSON-safe report snapshot. The
 * full structure has ~30 fields; the snapshot carries the
 * roll-instance forensics a triage reader needs, all primitives.
 */
function toSkuInfoSnapshot(sku: SkuInfo): SkuInfoSnapshot {
  return {
    sku: sku.sku.trim(),
    brand: sku.brand,
    material: sku.material,
    labelType: sku.labelType,
    labelColor: sku.labelColor,
    contentColor: sku.contentColor,
    labelWidthMm: sku.labelWidthMm,
    labelLengthMm: sku.labelLengthMm,
    totalLabelCount: sku.totalLabelCount,
    counterStrategy: sku.counterStrategy,
    productionDate: sku.productionDate.trim(),
    productionTime: sku.productionTime.trim(),
    // Verbatim `ESC U` response — hex so it survives JSON.stringify.
    rawBytes: toHex(sku.rawBytes),
  };
}

/**
 * Eagerly capture LW 5xx connect diagnostics — prime media detection
 * (`ESC U`) and read the engine version (`ESC V`).
 *
 * The 550-family polled status frame (`parseStatus550`) never carries
 * `detectedMedia` — only `getMedia()` (the `ESC U` NFC SKU dump) does.
 * `getMedia()` caches the result into the printer's `lastStatus`, and
 * subsequent `getStatus()` calls (which the harness shell polls via
 * `onStatus`) preserve it. So a one-shot `getMedia()` here is what
 * surfaces the loaded SKU to the harness — including an uncatalogued
 * SKU, which is what drives the `detected-unrecognized` panel.
 *
 * Both `getMedia()` and `getEngineVersion()` are LabelWriter-web
 * specific methods (not part of the cross-driver `PrinterAdapter`
 * contract), so this driver-specific adapter is the right place to
 * call them. Capturing them eagerly here (plan 13 §E.1) guarantees
 * roll + firmware data reaches the report even if the tester never
 * reaches MediaSection or the print fails.
 *
 * Best-effort throughout ("rails not walls"): a printer with no NFC
 * tag, a malformed dump, or a failed version read just leaves that
 * field empty — the operator still picks media manually and the
 * connect summary still appears.
 */
async function captureConnectDiagnostics(
  printers: Record<string, PrinterAdapter>,
): Promise<EngineDiagnostics> {
  const out: EngineDiagnostics = {};
  await Promise.all(
    Object.entries(printers).map(async ([role, printer]) => {
      const engine = (printer as { engine?: PrintEngine }).engine;
      if (engine?.protocol !== 'lw5-raster') return;
      const entry: EngineDiagnostics[string] = {};

      const getMedia = (printer as { getMedia?: () => Promise<SkuInfo | undefined> }).getMedia;
      if (typeof getMedia === 'function') {
        try {
          const sku = await getMedia.call(printer);
          if (sku) entry.skuInfo = toSkuInfoSnapshot(sku);
        } catch {
          // Best-effort — no NFC tag / malformed dump → manual picker.
        }
      }

      const getEngineVersion = (
        printer as { getEngineVersion?: () => Promise<EngineVersion | undefined> }
      ).getEngineVersion;
      if (typeof getEngineVersion === 'function') {
        try {
          const version = await getEngineVersion.call(printer);
          if (version) entry.engineVersion = toEngineVersionSnapshot(version);
        } catch {
          // Best-effort — ESC V unsupported / no reply.
        }
      }

      if (Object.keys(entry).length > 0) out[role] = entry;
    }),
  );
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
      const printers = buildMockPrinterMap(device, transport);
      const engineDiagnostics = await captureConnectDiagnostics(printers);
      return { printers, device, mocked: true, engineDiagnostics };
    }

    // Real connect: `requestPrinters({ transport: 'usb' })` pops the
    // WebUSB picker, opens one transport per engine on multi-interface
    // composites (Duo — `label` on IF 0, `tape` on IF 1), and returns
    // a per-engine adapter map. Single-interface devices (3xx/4xx/5xx
    // + Twin Turbo) come back with one entry per engine sharing a
    // single transport — same record shape, fewer USB claims.
    // LabelWriter is USB-only, so `opts.transport` is always `'usb'`.
    const printers = await requestPrinters({ transport: 'usb' });
    const first = Object.values(printers)[0];
    if (!first?.device) {
      throw new Error(
        'requestPrinters() returned no engines — driver-web reports the picked device has no drivable engines.',
      );
    }
    const engineDiagnostics = await captureConnectDiagnostics(printers);
    return {
      printers,
      device: first.device,
      mocked: false,
      engineDiagnostics,
    };
  },

  mockTargets: buildMockTargets(),
  defaultMockTarget: 'lw330turbo',

  mediaPicker: {
    filterByDeviceEngine,
    groupBy,
    swatch,
    describe: m => m.name,
    // LW 5xx detects media from an NFC SKU tag; a SKU not yet in the
    // registry would otherwise wall the operator on the media step.
    // The build hook synthesises a printable media from the
    // operator-confirmed dimensions so an unknown roll is a registry
    // contribution, not a stuck screen.
    customMedia: { build: buildCustomLabelMedia },
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
    // detected-unrecognized flow: when the chosen media is a synthetic
    // custom one (sentinel id), record the operator-confirmed geometry
    // + identifier explicitly so the report is a registry contribution.
    const media = primarySession.media;
    const customMedia =
      media.id === CUSTOM_MEDIA_ID
        ? {
            ...(media.skus?.[0] ? { identifier: media.skus[0] } : {}),
            widthMm: media.widthMm,
            ...(media.heightMm !== undefined ? { heightMm: media.heightMm } : {}),
            type: media.type === 'die-cut' ? ('die-cut' as const) : ('continuous' as const),
          }
        : null;

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
    // Fold the captured live device-state (the pre/post-print `ESC A`
    // pair, plus ESC V / ESC U) into the report diagnostics block
    // (plan 13 §E).
    const diagnostics = buildReportDiagnostics({
      session: primarySession,
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
          ...(customMedia ? { customMedia } : {}),
        },
      },
      transports: [transportReport],
      ...(multiEngine && engineReports.length > 0 ? { engines: engineReports } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      submittedAt: new Date().toISOString(),
    } satisfies HardwareReport;
  },
};
