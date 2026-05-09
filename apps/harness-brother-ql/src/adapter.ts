/**
 * Brother-QL `DriverAdapter` — wires brother-ql-core into the shared
 * harness shell.
 *
 * This is the FIRST consumer of the shared shell's `auto-locked`
 * MediaPicker mode (every QL_700+ class entry declares
 * `engine.capabilities.mediaDetection === true`; the 32-byte status
 * response carries the loaded roll's width + length-mm + two-color
 * flag, which `parseStatus` resolves to a registry media entry via
 * `findMediaByDimensions`). The adapter exposes that resolved entry
 * as `mediaPicker.detected` so the shell pre-selects + locks the
 * catalogue.
 *
 * Single-engine driver: every brother-ql device declares exactly one
 * `PrintEngine`. The adapter omits `multiEngine` entirely so the
 * engine-tabs strip stays hidden (plan-09 hard rule).
 *
 * USB-only transport: brother-ql declares `usb`, `tcp`, and (on
 * QL_820NWBc / PT_P910BT) `bluetooth-spp` transports in the registry.
 * The browser can't open raw TCP-9100 sockets and can't open RFCOMM
 * SPP, so this adapter only wires the WebUSB path. Models with no USB
 * transport (none today, but PT_P900W has TCP+USB; QL_580N has TCP
 * too) fall back to USB. The maintainer's existing decision per
 * project memory: "we won't see TCP-only devices in the browser;
 * non-issue."
 *
 * Multi-transport per-device gap (flagged for the maintainer): the
 * shell's `connect` returns `Record<string, Transport>` keyed by
 * engine role, with no notion of "operator picked transport X out of
 * the device's USB+SPP options". Today brother-ql has no
 * browser-reachable multi-transport devices (TCP is unreachable; SPP
 * is unreachable; QL_820NWBc is USB+TCP+SPP but USB is the only
 * browser-reachable one). So we ship USB-only as the working
 * baseline; if a future Web-Bluetooth-LE driver lands or the maintainer
 * later patches the shell to add a transport picker on multi-transport
 * devices, this adapter will need a second pass.
 */
import type { DriverAdapter, MockSpec } from '@thermal-label/harness-shell';
import type { PrintEngine, Transport } from '@thermal-label/contracts';
import type {
  HardwareReport,
  IdentitySnapshot,
  TransportReport,
} from '@thermal-label/harness-core/shared';
import {
  DEFAULT_MEDIA,
  DEVICES,
  MEDIA,
  parseStatus,
  STATUS_REQUEST,
  type BrotherQLDevice,
  type BrotherQLMedia,
  type BrotherQLStatus,
} from '@thermal-label/brother-ql-core';
import { WebUsbTransport } from '@thermal-label/transport/web';
import type { MediaGroupKey, MediaSwatch } from '@thermal-label/harness-components/types';
import { MockTransport, type MockTarget } from './transport/mock';
import { buildBrotherQlUsbFilters, findDeviceByVidPid } from './transport/webusb-filters';
import { buildDiagnosticBitmap, encodeBitmap } from './diagnostic-print';
import { HARNESS_VERSION, DRIVER_VERSION } from './version';

const DRIVER_KEY = 'brother-ql';
const TARGET_REPO = 'thermal-label/brother-ql';

const STATUS_RESPONSE_BYTES = 32;
const STATUS_TIMEOUT_MS = 2_000;
const STATUS_POLL_TIMEOUT_MS = 1_500;

/**
 * Brother QL preamble — 200 zero bytes ("invalidate") + `ESC @`
 * ("initialize"). Standard sequence the production node adapter and
 * verify-cli embed at the start of every print job; we send it ahead
 * of the status request too so the printer is in a known state and
 * reports media detection on the response. Without it, a freshly-
 * opened connection often returns a stale or no-detected-media status.
 *
 * Built inline because `buildInvalidate` / `buildInitialize` aren't
 * re-exported from `brother-ql-core/index.ts`. Trivial bytes.
 */
const QL_PREAMBLE = (() => {
  const buf = new Uint8Array(202);
  buf[200] = 0x1b;
  buf[201] = 0x40;
  return buf;
})();

// ─── Mock targets ────────────────────────────────────────────────

interface MockMeta {
  vid: number;
  pid: number;
  key: string;
  name: string;
}

const MOCK_DEVICE_FOR_TARGET: Record<MockTarget, MockMeta> = {
  ql_820nwbc: { vid: 0x04f9, pid: 0x209d, key: 'QL_820NWBc', name: 'QL-820NWBc' },
  ql_810w: { vid: 0x04f9, pid: 0x209c, key: 'QL_810W', name: 'QL-810W' },
  ql_700: { vid: 0x04f9, pid: 0x2042, key: 'QL_700', name: 'QL-700' },
  ql_1100: { vid: 0x04f9, pid: 0x20a7, key: 'QL_1100', name: 'QL-1100' },
};

function deviceForMockTarget(target: MockTarget): BrotherQLDevice {
  const meta = MOCK_DEVICE_FOR_TARGET[target];
  const device = findDeviceByVidPid(meta.vid, meta.pid);
  if (!device) {
    throw new Error(`Mock target ${target} has no matching DEVICES entry — fix mock.ts`);
  }
  return device;
}

function mockTargetSpec(target: MockTarget): MockSpec<BrotherQLDevice> {
  const meta = MOCK_DEVICE_FOR_TARGET[target];
  return {
    displayName: meta.name,
    device: deviceForMockTarget(target),
    vid: meta.vid,
    pid: meta.pid,
    aliases: aliasesFor(target),
  };
}

function aliasesFor(target: MockTarget): readonly string[] {
  switch (target) {
    case 'ql_820nwbc':
      return ['ql820', 'ql_820', 'ql-820nwbc'];
    case 'ql_810w':
      return ['ql810', 'ql_810'];
    case 'ql_700':
      return ['ql700'];
    case 'ql_1100':
      return ['ql1100'];
  }
}

// ─── Status probe + identity stash ───────────────────────────────

async function runStatusProbe(
  transport: Transport,
  device: BrotherQLDevice,
  identity: IdentitySnapshot,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- every brother-ql device declares ≥1 engine in the registry.
  const engine = device.engines[0]!;
  try {
    // Send the QL preamble first so the printer is in a known state
    // before we request status. Reliable media detection on a freshly-
    // opened connection depends on this — see verify-cli's connect.ts
    // for the same pattern.
    await transport.write(QL_PREAMBLE);
    await transport.write(STATUS_REQUEST);
    const response = await transport.read(STATUS_RESPONSE_BYTES, STATUS_TIMEOUT_MS);
    const status = parseStatus(response, engine);
    const detected = status.detectedMedia as BrotherQLMedia | undefined;
    identity.extra = {
      ...identity.extra,
      ready: status.ready,
      mediaLoaded: status.mediaLoaded,
      twoColorRoll: status.twoColorRoll ?? false,
      raw: Array.from(response.subarray(0, Math.min(response.length, 32))),
      ...(detected
        ? {
            detectedMedia: {
              id: detected.id,
              name: detected.name,
              skus: detected.skus,
              widthMm: detected.widthMm,
              heightMm: detected.heightMm,
            },
          }
        : {}),
      ...(status.errors.length > 0 ? { errors: status.errors.map(e => e.code) } : {}),
    };
  } catch (err) {
    identity.extra = {
      ...identity.extra,
      statusProbeError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function connectReal(): Promise<{
  transport: Transport;
  device: BrotherQLDevice;
  identity: IdentitySnapshot;
}> {
  const filters = buildBrotherQlUsbFilters();
  const transport = await WebUsbTransport.request([...filters]);
  const paired = await navigator.usb.getDevices();
  const matching = paired.find(d =>
    filters.some(f => f.vendorId === d.vendorId && f.productId === d.productId),
  );
  const vid = matching?.vendorId ?? 0;
  const pid = matching?.productId ?? 0;

  const device = findDeviceByVidPid(vid, pid);
  if (!device) {
    await transport.close();
    throw new Error(
      `No brother-ql device matched vid=0x${vid.toString(16)} pid=0x${pid.toString(16)}. ` +
        `The browser picker selected an unknown PID. Open the manual VID/PID drawer to override.`,
    );
  }

  const identity: IdentitySnapshot = {
    advertisedName: matching?.productName ?? device.name,
    vid,
    pid,
  };
  await runStatusProbe(transport, device, identity);
  return { transport, device, identity };
}

async function connectMock(target: MockTarget): Promise<{
  transport: Transport;
  device: BrotherQLDevice;
  identity: IdentitySnapshot;
}> {
  const transport = MockTransport.open(target);
  const meta = MockTransport.identityFor(target);
  const device = findDeviceByVidPid(meta.vid, meta.pid);
  if (!device) {
    throw new Error(`Mock target ${target} has no matching DEVICES entry — fix mock.ts`);
  }
  const identity: IdentitySnapshot = {
    advertisedName: `${meta.name} (mock)`,
    vid: meta.vid,
    pid: meta.pid,
    extra: { mocked: true, mockTarget: target },
  };
  await runStatusProbe(transport, device, identity);
  return { transport, device, identity };
}

// ─── Media-picker bindings ───────────────────────────────────────

/**
 * Filter the DK / TZe / HSe catalogue down to entries compatible with
 * the active engine. Brother-QL media declares `targetModels` as a
 * coarse tape-system label (`'dk'`, `'dk-wide'`, `'tze'`,
 * `'hse-2to1'`, `'hse-3to1'`); engines declare the same labels in
 * their `mediaCompatibility` set. The intersection is the picker's
 * `available[]`.
 */
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
  // DK rolls split into continuous, die-cut, and the two-color
  // sub-bucket. PT tapes split by tape system (TZe / HSe) — each
  // tape-system family lands under its own primary group. Less-common
  // entries (the wide-only DK 102 mm and HSe heat-shrink families)
  // tuck under the secondary disclosure.
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
    return {
      key: 'dk-two-color',
      label: 'DK two-color',
      priority: 'primary',
      sort: 0,
    };
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

/**
 * Optional swatch — DK substrate is overwhelmingly white with black
 * print, so we surface a swatch only on the two-color rolls
 * (DK-22251 etc.). Single-colour DK rolls render without a swatch
 * since "black on white" adds no triage value.
 */
function swatch(m: BrotherQLMedia): MediaSwatch | null {
  if (m.palette === undefined) return null;
  // Two-color rolls: DK-22251 prints black + red on white. Surface
  // those as fg='red' / bg='white' so the picker chip shows the
  // distinguishing ink.
  return { fg: 'red', bg: 'white' };
}

// ─── DriverAdapter ───────────────────────────────────────────────

export const adapter: DriverAdapter<BrotherQLDevice, BrotherQLMedia, BrotherQLStatus> = {
  driverKey: DRIVER_KEY,
  driverDisplayName: 'Brother QL',
  targetRepo: TARGET_REPO,
  harnessVersion: HARNESS_VERSION,
  driverVersion: DRIVER_VERSION,

  devices: Object.values(DEVICES),
  deviceKey: d => d.key,
  deviceName: d => d.name,
  findDeviceByVidPid,

  connect: async opts => {
    if (opts.mock && opts.mockTarget) {
      const { transport, device, identity } = await connectMock(opts.mockTarget as MockTarget);
      return {
        transports: { primary: transport },
        device,
        identity,
        mocked: true,
      };
    }
    const { transport, device, identity } = await connectReal();
    return {
      transports: { primary: transport },
      device,
      identity,
      mocked: false,
    };
  },

  mockTargets: {
    ql_820nwbc: mockTargetSpec('ql_820nwbc'),
    ql_810w: mockTargetSpec('ql_810w'),
    ql_700: mockTargetSpec('ql_700'),
    ql_1100: mockTargetSpec('ql_1100'),
  },
  defaultMockTarget: 'ql_820nwbc',

  status: {
    kind: 'poll',
    intervalMs: 4000,
    read: async (transport, _device, engine) => {
      await transport.write(STATUS_REQUEST);
      const response = await transport.read(STATUS_RESPONSE_BYTES, STATUS_POLL_TIMEOUT_MS);
      return parseStatus(response, engine);
    },
    toPills: status => {
      // §1 Connect: printer-ready pill.
      // §3 Media: roll-loaded pill.
      if (!status) {
        return {
          printer: { state: 'unknown', label: 'Printer: checking…' },
          media: { state: 'unknown', label: 'Roll: checking…' },
        };
      }
      const coverOpen = status.errors.some(e => e.code === 'cover_open');
      const noMedia = status.errors.some(e => e.code === 'no_media');
      const mediaEnd = status.errors.some(e => e.code === 'media_end');
      const cutterJam = status.errors.some(e => e.code === 'cutter_jam');
      const printer: { state: 'unknown' | 'good' | 'warn' | 'bad'; label: string } = !status.ready
        ? coverOpen
          ? { state: 'bad', label: 'Cover open' }
          : cutterJam
            ? { state: 'bad', label: 'Cutter jam' }
            : { state: 'bad', label: 'Printer not ready' }
        : { state: 'good', label: 'Printer ready' };
      const media: { state: 'unknown' | 'good' | 'warn' | 'bad'; label: string } =
        noMedia || !status.mediaLoaded
          ? { state: 'bad', label: 'No roll loaded' }
          : mediaEnd
            ? { state: 'warn', label: 'Roll near end' }
            : { state: 'good', label: 'Roll loaded' };
      return { printer, media };
    },
  },

  media: Object.values(MEDIA),
  mediaPicker: {
    filterByDeviceEngine,
    groupBy,
    swatch,
    describe: m => m.name,
    defaultMediaId: () => DEFAULT_MEDIA.id,
    /**
     * `auto-locked` on every QL_700+ class engine — every engine in
     * the brother-ql registry today declares
     * `capabilities.mediaDetection === true`. Locked rather than
     * suggested because the printer hard-rejects with an error code
     * if the host job dimensions disagree with the loaded roll
     * (see QL_700 `hardwareQuirks` in the registry: "hard-rejects
     * with an error code if the host job dimensions do not match the
     * loaded DK cassette").
     */
    detectionCapability: (_d, engine) =>
      engine.capabilities?.mediaDetection === true ? 'auto-locked' : 'none',
    /**
     * Resolve the loaded roll from the status-probe payload. The
     * probe stashes the resolved media object (id + name + skus +
     * widthMm + heightMm) on `identity.extra.detectedMedia`; we look
     * up the canonical entry in the available set by id so the
     * MediaPicker pre-selects an entry from the catalogue (and not a
     * detached object).
     */
    detected: (identity, available, _engine, status) => {
      // Prefer the live status frame — brother-ql swaps DK rolls
      // mid-session, and cover-open at connect time means the
      // initial probe might have missed media that's now there.
      // The polling status carries the freshest media identity.
      const live = (status as { detectedMedia?: BrotherQLMedia } | null)?.detectedMedia;
      if (live && typeof live.id === 'number') {
        const fromCatalogue = available.find(m => m.id === live.id);
        if (fromCatalogue) return fromCatalogue;
      }
      // Fallback: connect-time identity.extra (set by runStatusProbe).
      const extra = identity.extra as { detectedMedia?: { id?: number } } | undefined;
      const id = extra?.detectedMedia?.id;
      if (typeof id !== 'number') return null;
      return available.find(m => m.id === id) ?? null;
    },
    sectionTitle: () => "Pick what's loaded",
  },

  encoder: {
    buildBitmap: ({ device, engine, media, harnessVersion, driverVersion }) =>
      buildDiagnosticBitmap({ device, engine, media, harnessVersion, driverVersion }),
    encodeBytes: (bitmap, device, media, engine) => encodeBitmap(bitmap, device, media, engine),
    // Empirical chunking constants borrowed from the production node
    // adapter: 1 KB / 20 ms keeps the QL-820NWBc input ring buffer
    // drained on USB. Slower but reliable; matches verify-cli's
    // `writeDiagnosticPrint`.
    chunkSize: 1024,
    chunkDelayMs: 20,
  },

  // No multiEngine — every brother-ql device in the registry is
  // single-engine. Plan-09 hard rule: omit the field entirely so the
  // shell never renders the engine-tabs strip.

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
          // Mirror LM/LW shape: `overrides.media` carries the picked
          // entry's id; brother-ql media ids are numeric, so coerce
          // to string for the schema. `tapeWidthMm` keeps parity with
          // the labelmanager triage view.
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
