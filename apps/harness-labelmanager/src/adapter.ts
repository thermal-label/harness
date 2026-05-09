/**
 * Labelmanager `DriverAdapter` — wires labelmanager-core into the
 * shared harness shell.
 *
 * The shell handles UI, polling, submit flow, engine tabs (no-op
 * for LM since every LM device is single-engine). This adapter
 * supplies the LM-specific bits:
 *
 *   - device + media catalogues from `@thermal-label/labelmanager-core`
 *   - WebUSB connect orchestration (status probe → identity-stash)
 *   - mock targets (LM PnP, 280, 400, etc.)
 *   - status poll (`STATUS_REQUEST` → `parseStatus`)
 *   - media-picker bindings (group by tape width, demote Rhino, no
 *     detection — LM firmware can't read cartridge IDs)
 *   - encoder dispatch (`buildDiagnosticBitmap` + `encodeBitmap`)
 *   - report builder (LM-specific `overrides` shape with media-id +
 *     tape-width)
 */
import type { DriverAdapter, MockSpec } from '@thermal-label/harness-shell';
import type { PrinterStatus, Transport } from '@thermal-label/contracts';
import { buildDiagnosticBitmap, encodeBitmap } from '@thermal-label/harness-core/labelmanager';
import {
  renderIssueBody,
  type HardwareReport,
  type IdentitySnapshot,
  type TransportReport,
} from '@thermal-label/harness-core/shared';
import {
  DEFAULT_MEDIA,
  DEVICES,
  MEDIA_LIST,
  parseStatus,
  STATUS_REQUEST,
  type LabelManagerDevice,
  type LabelManagerMedia,
  type TapeWidth,
} from '@thermal-label/labelmanager-core';
import { WebUsbTransport } from '@thermal-label/transport/web';
import type { MediaGroupKey, MediaSwatch } from '@thermal-label/harness-components/types';
import { MockTransport, type MockTarget } from './transport/mock';
import { buildLabelmanagerUsbFilters, findDeviceByVidPid } from './transport/webusb-filters';
import { HARNESS_VERSION, DRIVER_VERSION } from './version';

// `renderIssueBody` is imported so the adapter can pre-render in
// future fallback paths; the shell calls it for us today. Keeping the
// re-export here documents the intent.
void renderIssueBody;

const DRIVER_KEY = 'labelmanager';
const TARGET_REPO = 'thermal-label/labelmanager';

const STATUS_RESPONSE_BYTES = 64;
const STATUS_TIMEOUT_MS = 2_000;
const STATUS_POLL_TIMEOUT_MS = 1_500;

const HEAD_DOTS_FOR_TAPE: Record<TapeWidth, number> = {
  6: 32,
  9: 48,
  12: 64,
  19: 64,
};

/**
 * Mock-target → identity hint. The mock transport responds to
 * status-probe writes with a synthesised "ready, media loaded" reply
 * (single 0x00 byte); other writes are silently consumed. Mirrors
 * the real WebUSB path's identity shape.
 */
const MOCK_DEVICE_FOR_TARGET: Record<
  MockTarget,
  { vid: number; pid: number; key: string; name: string }
> = {
  lm_pnp: { vid: 0x0922, pid: 0x1002, key: 'LM_PNP', name: 'LabelManager PnP' },
  lm_280: { vid: 0x0922, pid: 0x1006, key: 'LM_280', name: 'LabelManager 280' },
  lm_400: { vid: 0x0922, pid: 0x0013, key: 'LM_400', name: 'LabelManager 400' },
  lm_420p: { vid: 0x0922, pid: 0x1004, key: 'LM_420P', name: 'LabelManager 420P' },
  lm_pc: { vid: 0x0922, pid: 0x0011, key: 'LM_PC', name: 'LabelManager PC' },
  lm_wireless_pnp: {
    vid: 0x0922,
    pid: 0x1008,
    key: 'LM_WIRELESS_PNP',
    name: 'LabelManager Wireless PnP',
  },
  labelpoint_350: { vid: 0x0922, pid: 0x0015, key: 'LABELPOINT_350', name: 'LabelPoint 350' },
  mobile_labeler: { vid: 0x0922, pid: 0x1009, key: 'MOBILE_LABELER', name: 'Mobile Labeler' },
};

function deviceForMockTarget(target: MockTarget): LabelManagerDevice {
  const meta = MOCK_DEVICE_FOR_TARGET[target];
  const device = findDeviceByVidPid(meta.vid, meta.pid);
  if (!device) {
    throw new Error(`Mock target ${target} has no matching DEVICES entry — fix mock.ts`);
  }
  return device;
}

function buildMockTargets(): Record<string, MockSpec<LabelManagerDevice>> {
  const out: Record<string, MockSpec<LabelManagerDevice>> = {};
  for (const target of Object.keys(MOCK_DEVICE_FOR_TARGET) as MockTarget[]) {
    out[target] = buildOne(target);
  }
  return out;
}

function buildOne(target: MockTarget): MockSpec<LabelManagerDevice> {
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
    case 'lm_pnp':
      return ['lmpnp', 'pnp'];
    case 'lm_280':
      return ['lm280'];
    case 'lm_400':
      return ['lm400'];
    case 'lm_420p':
      return ['lm420p'];
    case 'lm_pc':
      return ['lmpc'];
    case 'lm_wireless_pnp':
      return ['wireless'];
    case 'labelpoint_350':
      return ['lp350'];
    case 'mobile_labeler':
      return ['mobile'];
  }
}

async function runStatusProbe(transport: Transport, identity: IdentitySnapshot): Promise<void> {
  try {
    await transport.write(STATUS_REQUEST);
    const response = await transport.read(STATUS_RESPONSE_BYTES, STATUS_TIMEOUT_MS);
    const status = parseStatus(response);
    identity.extra = {
      ...identity.extra,
      ready: status.ready,
      mediaLoaded: status.mediaLoaded,
      raw: Array.from(response.subarray(0, Math.min(response.length, 16))),
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
  device: LabelManagerDevice;
  identity: IdentitySnapshot;
}> {
  const filters = buildLabelmanagerUsbFilters();
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
      `No labelmanager device matched vid=0x${vid.toString(16)} pid=0x${pid.toString(16)}. ` +
        `The browser picker selected an unknown PID. Open the manual VID/PID drawer to override.`,
    );
  }

  const identity: IdentitySnapshot = {
    advertisedName: matching?.productName ?? device.name,
    vid,
    pid,
  };

  await runStatusProbe(transport, identity);
  return { transport, device, identity };
}

async function connectMock(target: MockTarget): Promise<{
  transport: Transport;
  device: LabelManagerDevice;
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
  await runStatusProbe(transport, identity);
  return { transport, device, identity };
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

// ─── DriverAdapter ───────────────────────────────────────────────

export const adapter: DriverAdapter<LabelManagerDevice, LabelManagerMedia, PrinterStatus> = {
  driverKey: DRIVER_KEY,
  driverDisplayName: 'LabelManager',
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

  mockTargets: buildMockTargets(),
  defaultMockTarget: 'lm_pnp',

  status: {
    kind: 'poll',
    intervalMs: 4000,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- single-engine; engine arg ignored
    read: async (transport, _device, _engine) => {
      await transport.write(STATUS_REQUEST);
      const response = await transport.read(STATUS_RESPONSE_BYTES, STATUS_POLL_TIMEOUT_MS);
      return parseStatus(response);
    },
    toPills: status => {
      // §1 Connect: printer-ready pill.
      // §3 Media: cassette-loaded pill.
      if (!status) {
        return {
          printer: { state: 'unknown', label: 'Printer: checking…' },
          media: { state: 'unknown', label: 'Cassette: checking…' },
        };
      }
      const lowMedia = status.errors.some(e => e.code === 'low_media');
      const printer: { state: 'unknown' | 'good' | 'warn' | 'bad'; label: string } = !status.ready
        ? { state: 'bad', label: 'Printer busy' }
        : lowMedia
          ? { state: 'warn', label: 'Tape supply low' }
          : { state: 'good', label: 'Printer ready' };
      const media: { state: 'unknown' | 'good' | 'warn' | 'bad'; label: string } =
        !status.mediaLoaded
          ? { state: 'bad', label: 'No cassette' }
          : lowMedia
            ? { state: 'warn', label: 'Cassette loaded — tape low' }
            : { state: 'good', label: 'Cassette loaded' };
      return { printer, media };
    },
  },

  media: MEDIA_LIST,
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
    defaultMediaId: () => DEFAULT_MEDIA.id,
    detectionCapability: () => 'none',
    sectionTitle: () => "Pick what's loaded",
  },

  encoder: {
    buildBitmap: ({ device, media, harnessVersion, driverVersion }) =>
      buildDiagnosticBitmap({ device, media, harnessVersion, driverVersion }),
    encodeBytes: (bitmap, device, media) => {
      const engine = device.engines[0];
      if (!engine) {
        throw new Error('Labelmanager device has no engines — driver-core registry is corrupt.');
      }
      return encodeBitmap(bitmap, engine, media);
    },
    chunkSize: 64,
    chunkDelayMs: 5,
  },

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
          // Mirror the labelwriter shape — `overrides.media` (id) +
          // `overrides.tapeWidthMm` (width). A future generic triage
          // view can render both drivers' "what was loaded" the same
          // way.
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
