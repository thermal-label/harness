/**
 * Niimbot `DriverAdapter` — wires niimbot-core + niimbot-web into
 * the shared harness shell.
 *
 * Multi-device, single-engine driver. The registry today carries
 * D11 / D110 / B1 / B21 (and variants) — every chassis declares
 * exactly one engine. The harness-shell hides the engine-tabs strip
 * when `device.engines.length <= 1`, so no per-engine routing.
 *
 * Transport: every niimbot model declares `bluetooth-gatt` (universal
 * service UUID `e7810a71-…` + per-chassis name prefix). Some chassis
 * also declare `serial` / `bluetooth-spp` for legacy paths; those
 * surface as additional buttons via plan-11 `<TransportButtons>`.
 * USB is NOT in the registry today (DECISIONS.md § D8 — revisit
 * pending B1 USB Printer Class evidence; see niimbot/B1_USB_DEBUG_HANDOFF.md).
 *
 * Connect path:
 *  - Real: `requestPrinters({ transport, deviceKey? })`. If `deviceKey`
 *    is omitted, niimbot-web throws `DeviceIdentificationRequiredError`
 *    and the shell renders `<DeviceDropdown>` with the registry
 *    candidates filtered to the picked transport.
 *  - Mock: `new NiimbotPrinter(DEVICES.B1, MockTransport.open())`
 *    wrapped in the per-engine map. The mock transport replies to
 *    every framed packet with the matching `In_*` ack and returns a
 *    pre-completed `PrintStatus` so the strategy resolves instantly
 *    during a self-walk.
 */
import type { DriverAdapter, MockSpec } from '@thermal-label/harness-shell';
import type {
  HardwareReport,
  IdentitySnapshot,
  TransportReport,
} from '@thermal-label/harness-core/shared';
import {
  DEVICES,
  ALL_MEDIA,
  NiimbotPrinter,
  type NiimbotDevice,
  type NiimbotMedia,
} from '@thermal-label/niimbot-core';
import { requestPrinters } from '@thermal-label/niimbot-web';
import type { MediaGroupKey, MediaSwatch } from '@thermal-label/harness-components/types';
import { MockTransport, type MockTarget } from './transport/mock';
import { buildDiagnosticImage } from './diagnostic-print';
import { HARNESS_VERSION, DRIVER_VERSION } from './version';

const DRIVER_KEY = 'niimbot';
const TARGET_REPO = 'thermal-label/niimbot';

// ─── Mock targets ────────────────────────────────────────────────

const MOCK_TARGETS: Record<MockTarget, { displayName: string; deviceKey: string; aliases: readonly string[] }> = {
  b1: {
    displayName: 'Niimbot B1',
    deviceKey: 'B1',
    aliases: ['b1', 'niimbot-b1'],
  },
};

function buildMockTargets(): Record<string, MockSpec<NiimbotDevice>> {
  const out: Record<string, MockSpec<NiimbotDevice>> = {};
  for (const [key, meta] of Object.entries(MOCK_TARGETS)) {
    const device = (DEVICES as Record<string, NiimbotDevice | undefined>)[meta.deviceKey];
    if (!device) {
      throw new Error(
        `Mock target ${key} → device ${meta.deviceKey} not found in DEVICES registry — fix mock target table.`,
      );
    }
    const gatt = device.transports['bluetooth-gatt'];
    if (!gatt) {
      throw new Error(
        `Mock target ${key} → device ${meta.deviceKey} has no bluetooth-gatt transport — registry malformed.`,
      );
    }
    out[key] = {
      displayName: meta.displayName,
      device,
      transport: 'bluetooth-gatt',
      filter: {
        serviceUuid: gatt.serviceUuid,
        ...(gatt.namePrefix !== undefined ? { namePrefix: gatt.namePrefix } : {}),
      },
      aliases: meta.aliases,
    };
  }
  return out;
}

// ─── Media-picker bindings ───────────────────────────────────────

/**
 * Map a chassis to the substrate-tag(s) niimbot media uses on
 * `targetModels`. The registry's `NiimbotTargetModel` is a substrate
 * family (`niimbot-d-series`, `niimbot-b-series`, plus the special
 * cases `niimbot-b3s` and `niimbot-b4`), NOT a device key — so we
 * derive the right tags from the chassis key here.
 */
function targetTagsForDevice(device: NiimbotDevice): readonly NiimbotMedia['targetModels'][number][] {
  const k = device.key;
  if (k === 'B3S') return ['niimbot-b3s', 'niimbot-b-series'];
  if (k === 'B4') return ['niimbot-b4', 'niimbot-b-series'];
  if (k.startsWith('B')) return ['niimbot-b-series'];
  if (k.startsWith('D')) return ['niimbot-d-series'];
  return [];
}

function filterByDeviceEngine(
  media: readonly NiimbotMedia[],
  device: NiimbotDevice,
): readonly NiimbotMedia[] {
  const tags = targetTagsForDevice(device);
  if (tags.length === 0) return media;
  return media.filter(m => m.targetModels.some(t => tags.includes(t)));
}

function groupBy(m: NiimbotMedia): MediaGroupKey {
  // Group by media kind: continuous vs die-cut. Continuous rolls
  // sort first (no per-label feed step) so the operator sees them
  // alongside the die-cut catalogue.
  if (m.type === 'continuous') {
    return { key: 'continuous', label: 'Continuous rolls', priority: 'primary', sort: 0 };
  }
  return { key: 'die-cut', label: 'Die-cut labels', priority: 'primary', sort: 1 };
}

function swatch(): MediaSwatch | null {
  // Every niimbot media is monochrome thermal — no per-cassette
  // colour to render. Return null so the swatch column collapses.
  return null;
}

// ─── DriverAdapter ───────────────────────────────────────────────

export const adapter: DriverAdapter<NiimbotDevice, NiimbotMedia> = {
  driverKey: DRIVER_KEY,
  driverDisplayName: 'Niimbot',
  targetRepo: TARGET_REPO,
  harnessVersion: HARNESS_VERSION,
  driverVersion: DRIVER_VERSION,

  devices: Object.values(DEVICES),
  media: ALL_MEDIA as readonly NiimbotMedia[],
  deviceKey: d => d.key,
  deviceName: d => d.name,

  connect: async opts => {
    if (opts.mock && opts.mockTarget) {
      const target = opts.mockTarget as MockTarget;
      MockTransport.identityFor(target);
      const meta = MOCK_TARGETS[target];
      const device = (DEVICES as Record<string, NiimbotDevice | undefined>)[meta.deviceKey];
      if (!device) throw new Error(`Unknown mock target ${target}`);
      const engine = device.engines[0];
      if (!engine) throw new Error(`Niimbot device ${device.key} has no engines — registry malformed.`);
      const transport = MockTransport.open(target);
      const printer = new NiimbotPrinter(device, transport);
      return {
        printers: { [engine.role]: printer },
        device,
        mocked: true,
      };
    }

    // Real connect — niimbot-web's unified factory throws
    // `DeviceIdentificationRequiredError` when `deviceKey` is omitted;
    // the shell catches it and renders `<DeviceDropdown>` filtered to
    // candidates declaring the picked transport. The error's
    // `continueWith(deviceKey)` reuses the originally-opened picker.
    const transport = opts.transport ?? 'bluetooth-gatt';
    const printers = await requestPrinters({ transport });
    const roles = Object.keys(printers);
    const firstRole = roles[0];
    if (firstRole === undefined) {
      throw new Error('Niimbot connect returned no printers — driver-web factory bug.');
    }
    const printer = printers[firstRole];
    if (!(printer instanceof NiimbotPrinter)) {
      throw new Error(
        `Niimbot connect returned non-NiimbotPrinter for role "${firstRole}" — driver-web factory bug.`,
      );
    }
    return {
      printers,
      device: printer.device,
      mocked: false,
    };
  },

  mockTargets: buildMockTargets(),
  defaultMockTarget: 'b1',

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
    // Surface niimbot-specific runtime state (RFID, battery, head temp,
    // detected media) into `detected.extra`. The last status snapshot
    // is the most recent observation the harness took — post-print if
    // a print ran, otherwise the pre-print snapshot from connect.
    const status = (primarySession.postPrintStatus ?? primarySession.prePrintStatus) as
      | (typeof primarySession.postPrintStatus & {
          rfid?: { barcode?: string; usedLengthMm?: number; totalLengthMm?: number; rawHex?: string };
          batteryPercent?: number;
          headTemperatureC?: number;
          rfidValid?: boolean;
          detectedMedia?: { id: string | number };
        })
      | null
      | undefined;
    const niimbotExtras: Record<string, unknown> = {};
    if (status?.rfid !== undefined) niimbotExtras.rfid = status.rfid;
    if (status?.batteryPercent !== undefined) niimbotExtras.batteryPercent = status.batteryPercent;
    if (status?.headTemperatureC !== undefined) niimbotExtras.headTemperatureC = status.headTemperatureC;
    if (status?.rfidValid !== undefined) niimbotExtras.rfidValid = status.rfidValid;
    if (status?.detectedMedia !== undefined) {
      niimbotExtras.detectedMedia = String(status.detectedMedia.id);
    }
    // Surface the GATT service UUID on `detected` so triage always
    // sees a service identifier — same fallback pattern as the
    // letratag adapter (plan 11 §IdentitySnapshot.serviceUuid).
    const detected: IdentitySnapshot = {
      ...identity,
      ...(identity.serviceUuid === undefined && gatt
        ? { serviceUuid: gatt.serviceUuid }
        : {}),
      extra: {
        ...identity.extra,
        ...niimbotExtras,
        ...(mocked ? { mocked: true } : {}),
      },
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
          // Niimbot has no fixed VID/PID in the BLE-only path. The
          // B1 USB chassis (VID 3513 / PID 0002) IS in the wild but
          // not declared in the registry yet (DECISIONS.md § D8).
          overrides: {
            media: String(media.id),
          },
        },
      },
      transports: [transportReport],
      submittedAt: new Date().toISOString(),
    };
    return report;
  },
};
