/**
 * Marklife `DriverAdapter` — wires marklife-core + marklife-web into
 * the shared harness shell.
 *
 * Catalogue-wide: every marklife chassis the runtime can actually
 * drive and that declares a browser-reachable transport is offered.
 * The registry spans four sub-engines (`marklife-yxq`, `-l11`,
 * `-tspl`, `-escpos`) and three head-size classes, so nothing here
 * may assume a single model.
 *
 * Connect path — the shell renders one button per transport declared
 * across `devices`, and hands the picked one back on `opts.transport`:
 *
 *  - `usb` — WebUSB. vid/pid is a hard identity, so marklife-web
 *    auto-identifies the chassis and no operator choice is needed.
 *  - `bluetooth-gatt` / `bluetooth-spp` / `serial` — the pickers
 *    carry no model identity (Web Serial's is generic; a BLE name
 *    prefix is a hint, not a key). The adapter deliberately omits
 *    `deviceKey` so marklife-web rejects with
 *    `DeviceIdentificationRequiredError`; the shell catches it and
 *    renders its `<DeviceDropdown>` over `err.candidates`, then
 *    resumes through `err.continueWith(key)`.
 *
 * That last point is the whole reason this adapter stays thin: the
 * candidate list is derived per-transport by marklife-web from the
 * registry, so adding a chassis to the registry adds it here for
 * free.
 *
 * The marklife driver exposes no out-of-job telemetry: `getStatus()`
 * synthesises from the transport's `connected` flag rather than
 * reading the wire (the print path is fire-and-forget). So the §1
 * status pill is a plain ready/errors shape with no live battery or
 * cassette signal.
 */
import type { DriverAdapter, MockSpec } from '@thermal-label/harness-shell';
import { buildReportDiagnostics } from '@thermal-label/harness-shell';
import type {
  HardwareReport,
  IdentitySnapshot,
  TransportReport,
} from '@thermal-label/harness-core/shared';
import type { PrintEngine, TransportType } from '@thermal-label/contracts';
import {
  DEVICES,
  MEDIA,
  isEngineDrivable,
  type MarklifeDevice,
  type MarklifeMedia,
} from '@thermal-label/marklife-core';
import { WebMarklifePrinter, requestPrinters } from '@thermal-label/marklife-web';
import type { MediaGroupKey } from '@thermal-label/harness-components/types';
import { MockTransport, MOCK_TARGETS, type MockTarget } from './transport/mock';
import { buildDiagnosticImage } from './diagnostic-print';
import { HARNESS_VERSION, DRIVER_VERSION } from './version';

const DRIVER_KEY = 'marklife';
const TARGET_REPO = 'thermal-label/marklife';

/** Transports the shell can drive from a browser. `tcp` is excluded upstream. */
const BROWSER_TRANSPORTS = ['usb', 'serial', 'bluetooth-spp', 'bluetooth-gatt'] as const;

/**
 * The chassis this harness offers.
 *
 * Two filters, both load-bearing:
 *  - **drivable** — the JBIG-bound chassis (D100/X4/X8/U210/L100)
 *    throw `UnsupportedOperationError` at encode time while the
 *    payload encoder is deferred (marklife DECISIONS.md § D4). They
 *    are already graded `unsupported` in the registry; offering them
 *    would walk the operator to a print that cannot happen.
 *  - **browser-reachable** — a chassis declaring only `tcp` (none
 *    today) could never be picked here.
 */
const CATALOGUE: readonly MarklifeDevice[] = (Object.values(DEVICES) as MarklifeDevice[])
  .filter(d => d.engines.some(e => isEngineDrivable(e as Parameters<typeof isEngineDrivable>[0])))
  .filter(d => BROWSER_TRANSPORTS.some(t => t in d.transports))
  .sort((a, b) => a.name.localeCompare(b.name));

// ─── Media-picker bindings ───────────────────────────────────────

/**
 * `targetModels` in the media catalogue is a head-size class, and the
 * engine's `physicalSizeClass` capability is the same taxonomy
 * expressed in inches. Map one to the other so a 0.5" narrow-tape
 * chassis never offers 100 mm shipping stock.
 */
type TargetModel = MarklifeMedia['targetModels'][number];

const SIZE_CLASS_TO_TARGET: Record<string, TargetModel> = {
  '0.5': 'narrow-tape',
  '2': 'mobile-2in',
  '3': 'desktop-3in',
  '4': 'industrial-4in',
};

const GROUP_LABELS: Partial<Record<TargetModel, { label: string; sort: number }>> = {
  'narrow-tape': { label: 'Narrow continuous rolls (0.5")', sort: 15 },
  'mobile-2in': { label: '2" mobile stock', sort: 50 },
  'desktop-3in': { label: '3" desktop stock', sort: 75 },
  'industrial-4in': { label: '4" industrial stock', sort: 100 },
};

function targetClassFor(engine: PrintEngine | undefined): TargetModel | undefined {
  const raw = (engine?.capabilities as { physicalSizeClass?: number } | undefined)
    ?.physicalSizeClass;
  return raw === undefined ? undefined : SIZE_CLASS_TO_TARGET[String(raw)];
}

/**
 * Narrow the catalogue to the picked chassis' head-size class. Falls
 * back to the whole catalogue when the engine declares no size class
 * — better to over-offer than to hand the operator an empty picker.
 */
function filterByDeviceEngine(
  media: readonly MarklifeMedia[],
  _device: MarklifeDevice,
  engine: PrintEngine,
): readonly MarklifeMedia[] {
  const target = targetClassFor(engine);
  if (target === undefined) return media;
  const matched = media.filter(m => m.targetModels.includes(target));
  return matched.length > 0 ? matched : media;
}

function groupBy(m: MarklifeMedia): MediaGroupKey {
  const target: TargetModel = m.targetModels[0] ?? 'narrow-tape';
  const meta = GROUP_LABELS[target] ?? { label: target, sort: 999 };
  return { key: target, label: meta.label, priority: 'primary', sort: meta.sort };
}

// ─── Mock connect helper ─────────────────────────────────────────

/**
 * Build the per-engine printer map for a mock connect. Every marklife
 * chassis is single-engine, so this is a 1-key record keyed by the
 * engine's own role (`primary`).
 */
function buildMockPrinterMap(
  device: MarklifeDevice,
  transport: MockTransport,
): Record<string, WebMarklifePrinter> {
  const engine = device.engines[0];
  if (!engine) {
    throw new Error(`Marklife device ${device.key} has no engines — registry is malformed.`);
  }
  return { [engine.role]: new WebMarklifePrinter(device, transport) };
}

/**
 * One mock target per representative chassis — one per sub-engine and
 * head-size class, so `?mock=` can walk every distinct code path
 * without hardware. Built off the registry so a rebind cannot leave a
 * stale protocol here.
 */
function buildMockTargets(): Record<string, MockSpec<MarklifeDevice>> {
  const out: Record<string, MockSpec<MarklifeDevice>> = {};
  for (const [key, meta] of Object.entries(MOCK_TARGETS)) {
    const device = DEVICES[meta.key as keyof typeof DEVICES] as MarklifeDevice | undefined;
    if (!device) continue;
    const gatt = device.transports['bluetooth-gatt'];
    const usb = device.transports.usb;
    const base = { displayName: meta.name, device, aliases: meta.aliases };
    // Tag the mock with a transport the chassis actually declares so
    // the mock-mode banner renders the right identity fields.
    if (gatt) {
      out[key] = {
        ...base,
        transport: 'bluetooth-gatt',
        filter: {
          serviceUuid: gatt.serviceUuid,
          ...(gatt.namePrefix ? { namePrefix: gatt.namePrefix } : {}),
        },
      };
    } else if (usb) {
      out[key] = {
        ...base,
        transport: 'usb',
        filter: { vid: parseInt(usb.vid, 16), pid: parseInt(usb.pid, 16) },
      };
    } else {
      out[key] = {
        ...base,
        transport: 'bluetooth-spp',
        ...(device.transports['bluetooth-spp']?.namePrefix
          ? { filter: { name: device.transports['bluetooth-spp'].namePrefix } }
          : { filter: {} }),
      };
    }
  }
  return out;
}

// ─── DriverAdapter ───────────────────────────────────────────────

export const adapter: DriverAdapter<MarklifeDevice, MarklifeMedia> = {
  driverKey: DRIVER_KEY,
  driverDisplayName: 'Marklife',
  targetRepo: TARGET_REPO,
  harnessVersion: HARNESS_VERSION,
  driverVersion: DRIVER_VERSION,

  devices: CATALOGUE,
  media: Object.values(MEDIA),
  deviceKey: d => d.key,
  deviceName: d => d.name,

  connect: async opts => {
    if (opts.mock && opts.mockTarget) {
      const target = opts.mockTarget as MockTarget;
      const meta = MockTransport.identityFor(target);
      const device = DEVICES[meta.key as keyof typeof DEVICES] as MarklifeDevice;
      const transport = MockTransport.open(target);
      return { printers: buildMockPrinterMap(device, transport), device, mocked: true };
    }

    // No `deviceKey`: on every transport but USB this makes
    // marklife-web reject with `DeviceIdentificationRequiredError`,
    // which the shell turns into its device dropdown. On USB the
    // driver identifies the chassis from vid/pid and answers
    // directly. Either way the chassis comes back on the result.
    const transport = opts.transport ?? 'bluetooth-gatt';
    const printers = await requestPrinters({ transport });
    const first = Object.values(printers)[0];
    if (!first?.device) {
      throw new Error(
        'requestPrinters() returned no engines — driver-web reports the picked device has no drivable engines.',
      );
    }
    return { printers, device: first.device as MarklifeDevice, mocked: false };
  },

  mockTargets: buildMockTargets(),
  defaultMockTarget: 'p12',

  mediaPicker: {
    filterByDeviceEngine,
    groupBy,
    describe: m => m.name,
  },

  buildDiagnosticImage: ({ device, media, harnessVersion, driverVersion }) =>
    buildDiagnosticImage({ device, media, harnessVersion, driverVersion }),

  buildReport: ({ device, identity, primarySession, mocked, transport }) => {
    if (primarySession.rung === null || primarySession.media === null) {
      throw new Error('buildReport: primary session must have rung and media set.');
    }
    // Report the transport actually exercised, not a hardcoded one —
    // a chassis can be reachable three ways and the verdict only
    // speaks for the one that was driven.
    const transportName = (transport ?? 'bluetooth-gatt') as TransportType;
    const gatt = device.transports['bluetooth-gatt'];
    const usb = device.transports.usb;
    const transportReport: TransportReport = {
      name: transportName,
      patterns: { diagnostic: 'pass' },
      rung: primarySession.rung,
      ...(primarySession.notes.trim() ? { notes: primarySession.notes.trim() } : {}),
    };
    // Surface the GATT service UUID on `detected` rather than
    // `confirmed` — `DeviceIdentity.confirmed` doesn't carry a
    // BLE-shape field today (the operator can't usefully override a
    // service UUID). `IdentitySnapshot.serviceUuid` is populated by
    // ConnectSection on GATT connect from the registry; fall back to
    // the registry value here so triage always sees a service
    // identifier even on older shell builds.
    const detected: IdentitySnapshot = {
      ...identity,
      ...(identity.serviceUuid === undefined && gatt && transportName === 'bluetooth-gatt'
        ? { serviceUuid: gatt.serviceUuid }
        : {}),
      extra: { ...identity.extra, ...(mocked ? { mocked: true } : {}) },
    };
    const media = primarySession.media;
    // Fold the shell-captured live device-state (the pre/post-print
    // status pair) into the report diagnostics block (plan 13 §E).
    // Marklife has no engine-version or SKU-dump opcode, so
    // `engineVersion` / `skuInfo` stay unset and
    // `buildReportDiagnostics` omits them.
    const diagnostics = buildReportDiagnostics({ session: primarySession });
    const report: HardwareReport = {
      schemaVersion: 1,
      driver: DRIVER_KEY,
      driverVersion: DRIVER_VERSION,
      harnessVersion: HARNESS_VERSION,
      device: {
        detected,
        confirmed: {
          model: device.name,
          ...(usb && transportName === 'usb'
            ? { vid: parseInt(usb.vid, 16), pid: parseInt(usb.pid, 16) }
            : {}),
          overrides: {
            media: String(media.id),
            tapeWidthMm: String(media.widthMm),
          },
        },
      },
      transports: [transportReport],
      ...(diagnostics ? { diagnostics } : {}),
      submittedAt: new Date().toISOString(),
    };
    return report;
  },
};
