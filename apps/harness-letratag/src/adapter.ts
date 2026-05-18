/**
 * Letratag `DriverAdapter` — wires letratag-core + letratag-web into
 * the shared harness shell.
 *
 * Single-engine BLE-only driver. LT-200B is the only model in the
 * registry; every cassette is 12 mm and 30 printable dots @ 200 dpi.
 * The harness-shell renders a single "Connect via Bluetooth" button
 * (plan 11 `<TransportButtons>` driven off the registry's lone
 * `bluetooth-gatt` transport).
 *
 * Connect path:
 *  - Real: calls `requestPrinter()` from letratag-web (the singular
 *    debug factory). The LT-200B exposes no out-of-job telemetry, so
 *    the §1 status pill stays at the post-print value (or the default
 *    idle status before the first print).
 *  - Mock: `new LetraTagPrinter(DEVICES.LT_200B, MockTransport.open())`
 *    wrapped in the per-engine map — the mock printer reflects an
 *    idle device.
 *
 * Plan 12 deliberately omits Node CLI plumbing (no Node BLE transport
 * exists in `@thermal-label/transport`); the adapter inlines its own
 * `diagnostic-print.ts` rather than sharing one across runtimes.
 */
import type { DriverAdapter, MockSpec } from '@thermal-label/harness-shell';
import { buildReportDiagnostics } from '@thermal-label/harness-shell';
import type {
  HardwareReport,
  IdentitySnapshot,
  TransportReport,
} from '@thermal-label/harness-core/shared';
import {
  DEVICES,
  MEDIA_LIST,
  type LetraTagDevice,
  type LetraTagMedia,
} from '@thermal-label/letratag-core';
import { LetraTagPrinter, requestPrinter } from '@thermal-label/letratag-web';
import type { MediaGroupKey, MediaSwatch } from '@thermal-label/harness-components/types';
import { MockTransport, type MockTarget } from './transport/mock';
import { buildDiagnosticImage } from './diagnostic-print';
import { HARNESS_VERSION, DRIVER_VERSION } from './version';

const DRIVER_KEY = 'letratag';
const TARGET_REPO = 'thermal-label/letratag';

// LT-200B BLE service descriptor — lifted from the registry so the
// MockSpec filter mirrors what the real picker would constrain on.
const LT_200B_SERVICE_UUID = 'be3dd650-2b3d-42f1-99c1-f0f749dd0678';
const LT_200B_NAME_PREFIX = 'Letratag ';

// ─── Mock targets ────────────────────────────────────────────────

function buildMockTargets(): Record<string, MockSpec<LetraTagDevice>> {
  return {
    lt_200b: {
      displayName: 'LetraTag LT-200B',
      device: DEVICES.LT_200B,
      transport: 'bluetooth-gatt',
      filter: {
        serviceUuid: LT_200B_SERVICE_UUID,
        namePrefix: LT_200B_NAME_PREFIX,
      },
      aliases: ['lt200b', 'lt_200b', 'letratag'],
    },
  };
}

// ─── Media-picker bindings ───────────────────────────────────────

/**
 * Every entry in `MEDIA_LIST` targets `letratag` (single-model
 * driver). Filter is a trivial pass-through, but we still honour
 * `targetModels` so any future registry expansion that adds a
 * model-restricted cassette gets filtered correctly.
 */
function filterByDeviceEngine(
  media: readonly LetraTagMedia[],
): readonly LetraTagMedia[] {
  return media.filter(m => (m.targetModels ?? []).includes('letratag'));
}

function groupBy(): MediaGroupKey {
  // Every cassette is 12 mm — single primary group. Sort key 12
  // keeps the group ordering stable if a 9 mm or 19 mm variant ever
  // joins the registry.
  return {
    key: '12mm',
    label: '12 mm cassettes',
    priority: 'primary',
    sort: 12,
  };
}

function swatch(m: LetraTagMedia): MediaSwatch | null {
  // Every cassette declares text + background — render both.
  const out: MediaSwatch = {};
  if (m.text !== undefined) out.fg = m.text;
  if (m.background !== undefined) out.bg = m.background;
  return out;
}

// ─── Mock connect helper ─────────────────────────────────────────

/**
 * Build the per-engine printer map for a mock connect. LT-200B is
 * single-engine, so this is a 1-key record keyed by the engine's
 * own role (`primary`).
 *
 * The LT-200B exposes no battery / cassette / live-status telemetry
 * over BLE, so the mock printer simply reflects an idle device — its
 * only real status is the post-print `[1B 52 code]` notification.
 */
function buildMockPrinterMap(
  device: LetraTagDevice,
  transport: MockTransport,
): Record<string, LetraTagPrinter> {
  const engine = device.engines[0];
  if (!engine) {
    throw new Error(`LetraTag device ${device.key} has no engines — registry is malformed.`);
  }
  const printer = new LetraTagPrinter(device, transport);
  return { [engine.role]: printer };
}

// ─── DriverAdapter ───────────────────────────────────────────────

export const adapter: DriverAdapter<LetraTagDevice, LetraTagMedia> = {
  driverKey: DRIVER_KEY,
  driverDisplayName: 'LetraTag',
  targetRepo: TARGET_REPO,
  harnessVersion: HARNESS_VERSION,
  driverVersion: DRIVER_VERSION,

  devices: Object.values(DEVICES),
  media: MEDIA_LIST,
  deviceKey: d => d.key,
  deviceName: d => d.name,

  connect: async opts => {
    // LT-200B is BLE-only — `opts.transport` is always
    // `'bluetooth-gatt'` (the only key the shell exposes a button
    // for; see plan 11 §Connect-section UI). Hardcoded below for
    // clarity.
    if (opts.mock && opts.mockTarget) {
      const target = opts.mockTarget as MockTarget;
      // identityFor is consulted for symmetry with sibling apps;
      // every value is the same LT_200B today.
      MockTransport.identityFor(target);
      const device = DEVICES.LT_200B;
      const transport = MockTransport.open(target);
      return {
        printers: buildMockPrinterMap(device, transport),
        device,
        mocked: true,
      };
    }

    // Real connect: `requestPrinter()` (singular, debug factory)
    // opens the Web Bluetooth picker, pairs, derives the per-unit
    // characteristic UUIDs by tail-matching the observed service
    // UUID, and returns a `PairResult`. The LT-200B exposes no
    // out-of-job telemetry, so the §1 status pill stays at the
    // post-print value between print jobs.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- requestPrinter is preserved as the BLE-debug escape hatch (carries observed UUIDs / link MTU); the deprecation tag is generic guidance for callers that don't need that surface
    const result = await requestPrinter();
    const printer = result.printer;
    const device = printer.device;
    const engine = device.engines[0];
    if (!engine) {
      throw new Error(`LetraTag device ${device.key} has no engines — registry is malformed.`);
    }

    return {
      printers: { [engine.role]: printer },
      device,
      mocked: false,
    };
  },

  mockTargets: buildMockTargets(),
  defaultMockTarget: 'lt_200b',

  mediaPicker: {
    filterByDeviceEngine,
    groupBy,
    swatch,
    describe: m => m.name,
  },

  buildDiagnosticImage: ({ device, media, harnessVersion, driverVersion }) =>
    buildDiagnosticImage({ device, media, harnessVersion, driverVersion }),

  buildReport: ({ device, identity, primarySession, mocked }) => {
    if (primarySession.rung === null || primarySession.media === null) {
      throw new Error('buildReport: primary session must have rung and media set.');
    }
    const gatt = device.transports['bluetooth-gatt'];
    const transportReport: TransportReport = {
      name: 'bluetooth-gatt',
      patterns: { diagnostic: 'pass' },
      rung: primarySession.rung,
      ...(primarySession.notes.trim() ? { notes: primarySession.notes.trim() } : {}),
    };
    // Surface the GATT service UUID on `detected` rather than
    // `confirmed` — `DeviceIdentity.confirmed` doesn't carry a
    // BLE-shape field today (the operator can't usefully override
    // a service UUID). `IdentitySnapshot.serviceUuid` was added in
    // plan 11; ConnectSection populates it on GATT connect from
    // the registry. If the shell didn't populate it (older
    // builds), fall back to the registry value here so triage
    // always sees a service identifier.
    const detected: IdentitySnapshot = {
      ...identity,
      ...(identity.serviceUuid === undefined && gatt
        ? { serviceUuid: gatt.serviceUuid }
        : {}),
      extra: { ...identity.extra, ...(mocked ? { mocked: true } : {}) },
    };
    const media = primarySession.media;
    // Fold the shell-captured live device-state (the post-print
    // status snapshots) into the report diagnostics block (plan 13
    // §E). LetraTag has no `ESC V` engine version and no `ESC U` SKU
    // dump, so `engineVersion` / `skuInfo` stay unset — the session
    // never populates them and `buildReportDiagnostics` simply omits
    // them. The LT-200B exposes no battery / cassette telemetry over
    // BLE, so the captured `PrinterStatus` carries only the post-print
    // `ready` / `errors` shape.
    const diagnostics = buildReportDiagnostics({
      session: primarySession,
    });
    const report: HardwareReport = {
      schemaVersion: 1,
      driver: DRIVER_KEY,
      driverVersion: DRIVER_VERSION,
      harnessVersion: HARNESS_VERSION,
      device: {
        detected,
        confirmed: {
          model: device.name,
          // LT-200B has no USB transport — no vid/pid here.
          overrides: {
            media: String(media.id),
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
