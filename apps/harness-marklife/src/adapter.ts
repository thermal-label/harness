/**
 * Marklife `DriverAdapter` — wires marklife-core + marklife-web into
 * the shared harness shell.
 *
 * Single-engine BLE-only driver. The P12 is the only model this
 * harness targets; its registry entry declares one engine bound to
 * the `marklife-l11` protocol (203 dpi, 100-dot 0.5" narrow-tape
 * head). The harness-shell renders a single "Connect via Bluetooth"
 * button (plan 11 `<TransportButtons>` driven off the registry's
 * lone `bluetooth-gatt` transport).
 *
 * Connect path:
 *  - Real: calls `requestPrinters({ transport: 'bluetooth-gatt',
 *    deviceKey: 'P12' })` from marklife-web. The `deviceKey` is
 *    mandatory for the GATT path — the registry's per-chassis service
 *    UUID + name prefix drive the Web Bluetooth picker. The call
 *    returns a `PrinterAdapterMap` keyed by engine role.
 *  - Mock: `new WebMarklifePrinter(DEVICES.P12, MockTransport.open())`
 *    wrapped in the per-engine map — the mock printer reflects an
 *    idle device.
 *
 * The marklife driver exposes no out-of-job telemetry: `getStatus()`
 * synthesises its `MarklifeStatus` from the transport's `connected`
 * flag rather than reading from the wire (the L11 print path is
 * fire-and-forget). So the §1 status pill is a plain ready/errors
 * shape and there is no live battery / cassette signal to surface.
 *
 * Marklife is single-engine, so the connect-result map is always a
 * 1-key record and the adapter is simpler than multi-engine drivers
 * (no per-engine tabs).
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
  MEDIA,
  type MarklifeDevice,
  type MarklifeMedia,
} from '@thermal-label/marklife-core';
import { WebMarklifePrinter, requestPrinters } from '@thermal-label/marklife-web';
import type { MediaGroupKey } from '@thermal-label/harness-components/types';
import { MockTransport, type MockTarget } from './transport/mock';
import { buildDiagnosticImage } from './diagnostic-print';
import { HARNESS_VERSION, DRIVER_VERSION } from './version';

const DRIVER_KEY = 'marklife';
const TARGET_REPO = 'thermal-label/marklife';

/** Registry key of the one device this harness targets. */
const P12_DEVICE_KEY = 'P12';

// P12 BLE service descriptor — lifted from the registry so the
// MockSpec filter mirrors what the real picker would constrain on.
const P12_SERVICE_UUID = '0000ff00-0000-1000-8000-00805f9b34fb';
const P12_NAME_PREFIX = 'P12';

/**
 * The P12 registry entry, narrowed to `MarklifeDevice`. `DEVICES`
 * carries the whole marklife catalogue; the harness drives only the
 * P12, so the `devices` catalogue below is a single-entry list.
 */
const P12_DEVICE = DEVICES[P12_DEVICE_KEY] as MarklifeDevice;

// ─── Mock targets ────────────────────────────────────────────────

function buildMockTargets(): Record<string, MockSpec<MarklifeDevice>> {
  return {
    p12: {
      displayName: 'Marklife P12',
      device: P12_DEVICE,
      transport: 'bluetooth-gatt',
      filter: {
        serviceUuid: P12_SERVICE_UUID,
        namePrefix: P12_NAME_PREFIX,
      },
      aliases: ['p12', 'marklife', 'marklife-p12'],
    },
  };
}

// ─── Media-picker bindings ───────────────────────────────────────

/**
 * The marklife media catalogue spans several head-size classes; the
 * P12 is `narrow-tape`, so the picker shows only `narrow-tape` media
 * (the 15 mm continuous roll today). Filtering on `targetModels`
 * keeps the picker correct if a wider-stock entry ever joins the
 * registry.
 */
function filterByDeviceEngine(
  media: readonly MarklifeMedia[],
): readonly MarklifeMedia[] {
  return media.filter(m => m.targetModels.includes('narrow-tape'));
}

function groupBy(): MediaGroupKey {
  // Every P12-compatible media is a narrow continuous roll — single
  // primary group. Sort key 15 keeps the group ordering stable if a
  // narrower or wider continuous variant ever joins the registry.
  return {
    key: 'narrow-tape',
    label: 'Narrow continuous rolls',
    priority: 'primary',
    sort: 15,
  };
}

// ─── Mock connect helper ─────────────────────────────────────────

/**
 * Build the per-engine printer map for a mock connect. The P12 is
 * single-engine, so this is a 1-key record keyed by the engine's own
 * role (`primary`).
 *
 * The marklife driver exposes no battery / cassette / live-status
 * telemetry — `getStatus()` synthesises its status from the
 * transport's `connected` flag, so the mock printer simply reflects
 * an idle device.
 */
function buildMockPrinterMap(
  device: MarklifeDevice,
  transport: MockTransport,
): Record<string, WebMarklifePrinter> {
  const engine = device.engines[0];
  if (!engine) {
    throw new Error(`Marklife device ${device.key} has no engines — registry is malformed.`);
  }
  const printer = new WebMarklifePrinter(device, transport);
  return { [engine.role]: printer };
}

// ─── DriverAdapter ───────────────────────────────────────────────

export const adapter: DriverAdapter<MarklifeDevice, MarklifeMedia> = {
  driverKey: DRIVER_KEY,
  driverDisplayName: 'Marklife',
  targetRepo: TARGET_REPO,
  harnessVersion: HARNESS_VERSION,
  driverVersion: DRIVER_VERSION,

  // Single-device harness — the catalogue is just the P12. The shell
  // hides the engine-tabs strip because the P12 declares one engine.
  devices: [P12_DEVICE],
  media: Object.values(MEDIA),
  deviceKey: d => d.key,
  deviceName: d => d.name,

  connect: async opts => {
    // The P12 is BLE-only — `opts.transport` is always
    // `'bluetooth-gatt'` (the only key the shell exposes a button
    // for; see plan 11 §Connect-section UI).
    if (opts.mock && opts.mockTarget) {
      const target = opts.mockTarget as MockTarget;
      // identityFor is consulted for symmetry with sibling apps;
      // every value is the same P12 today.
      MockTransport.identityFor(target);
      const device = P12_DEVICE;
      const transport = MockTransport.open(target);
      return {
        printers: buildMockPrinterMap(device, transport),
        device,
        mocked: true,
      };
    }

    // Real connect: `requestPrinters({ transport: 'bluetooth-gatt',
    // deviceKey: 'P12' })` opens the Web Bluetooth picker filtered to
    // the P12's registry service UUID + `P12` name prefix, pairs, and
    // returns a `PrinterAdapterMap` keyed by engine role. The
    // `deviceKey` is mandatory on the GATT path — without it
    // marklife-web rejects with `DeviceIdentificationRequiredError`.
    const printers = await requestPrinters({
      transport: 'bluetooth-gatt',
      deviceKey: P12_DEVICE_KEY,
    });
    const first = Object.values(printers)[0];
    if (!first?.device) {
      throw new Error(
        'requestPrinters() returned no engines — driver-web reports the picked device has no drivable engines.',
      );
    }
    return {
      printers,
      device: first.device as MarklifeDevice,
      mocked: false,
    };
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
    // BLE-shape field today (the operator can't usefully override a
    // service UUID). `IdentitySnapshot.serviceUuid` is populated by
    // ConnectSection on GATT connect from the registry; fall back to
    // the registry value here so triage always sees a service
    // identifier even on older shell builds.
    const detected: IdentitySnapshot = {
      ...identity,
      ...(identity.serviceUuid === undefined && gatt
        ? { serviceUuid: gatt.serviceUuid }
        : {}),
      extra: { ...identity.extra, ...(mocked ? { mocked: true } : {}) },
    };
    const media = primarySession.media;
    // Fold the shell-captured live device-state (the pre/post-print
    // status pair) into the report diagnostics block (plan 13 §E).
    // Marklife has no `ESC V` engine version and no `ESC U` SKU dump,
    // so `engineVersion` / `skuInfo` stay unset — the session never
    // populates them and `buildReportDiagnostics` simply omits them.
    // The driver exposes no battery / cassette telemetry, so the
    // captured `MarklifeStatus` carries only the plain `ready` /
    // `errors` shape.
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
          // The P12 has no USB transport — no vid/pid here.
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
