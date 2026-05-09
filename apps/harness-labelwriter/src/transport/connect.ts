/**
 * Connect orchestrator — owns the click-to-connect flow.
 *
 * Mirrors the verify-cli's `connect.ts` (status probe + best-effort
 * SKU probe), but uses `WebUsbTransport` instead of node-usb. The
 * status-probe shape is the same: `buildStatusRequest(device)` →
 * `read(statusByteCount(device))` → `parseStatus`. SKU probe via
 * `build550GetSku` is gated behind the device's
 * `capabilities.mediaDetection` flag (LW 5xx only).
 */
import {
  build550GetSku,
  buildStatusRequest,
  parseSkuInfo,
  parseStatus,
  SKU_INFO_BYTE_COUNT,
  statusByteCount,
  type LabelWriterDevice,
  type SkuInfo,
} from '@thermal-label/labelwriter-core';
import { WebUsbTransport } from '@thermal-label/transport/web';
import type { Transport } from '@thermal-label/contracts';
import type { IdentitySnapshot } from '@thermal-label/harness-core/shared';
import { MockTransport } from './mock';
import { IS_MOCK_MODE, MOCK_TARGET } from '../composables/useMockMode';
import { buildLabelwriterUsbFilters, findDeviceByVidPid } from './webusb-filters';

const STATUS_TIMEOUT_MS = 2_000;

export interface ConnectResult {
  /**
   * Per-engine transports keyed by `PrintEngine.role`. Single-engine
   * devices and Twin-style chassis (in-band roll-select on a single
   * USB endpoint) carry one entry — the engine's role keys it. Duo
   * (separate USB interfaces per engine) carries two entries — one
   * per interface — so PrintSection writes to the right one for the
   * active engine.
   */
  transports: Record<string, Transport>;
  device: LabelWriterDevice;
  identity: IdentitySnapshot;
  /** True if the SKU probe surfaced a roll. */
  skuInfo?: SkuInfo;
  /** True if this is the mock transport (UI labels accordingly). */
  mocked: boolean;
}

/**
 * Open a transport via the browser USB picker (or the mock, in
 * `?mock=1` mode), run the status probe, and — for LW 5xx — the SKU
 * probe.
 *
 * Throws on user-cancel of the picker; throws on hard transport
 * errors. The caller (Connect section) catches and surfaces a
 * friendly message.
 */
export async function connectToLabelwriter(): Promise<ConnectResult> {
  if (IS_MOCK_MODE) {
    return connectMock();
  }
  return connectReal();
}

async function connectReal(): Promise<ConnectResult> {
  const filters = buildLabelwriterUsbFilters();
  // Show the picker once. The selected `USBDevice` is reused for
  // each engine's interface claim below — Duo's two interfaces share
  // one chassis, one USB device, just two `claimInterface(N)` calls.
  const usbDevice = await navigator.usb.requestDevice({ filters: [...filters] });
  const vid = usbDevice.vendorId;
  const pid = usbDevice.productId;

  const device = findDeviceByVidPid(vid, pid);
  if (!device) {
    throw new Error(
      `No labelwriter device matched vid=0x${vid.toString(16)} pid=0x${pid.toString(16)}. ` +
        `The browser picker selected an unknown PID. Open the manual VID/PID drawer to override.`,
    );
  }

  const transports = await openEngineTransports(usbDevice, device);

  const primary = pickPrimaryTransport(transports, device);
  if (!primary) {
    throw new Error(
      `No engine transport could be opened for ${device.key}. Browser may have refused to ` +
        `claim the printer-class interface (some platforms restrict this for paired devices); ` +
        `unplug + replug the printer and retry, or use verify-cli.`,
    );
  }

  const identity: IdentitySnapshot = {
    advertisedName: usbDevice.productName ?? device.name,
    vid,
    pid,
  };

  // Status probe + SKU probe run on the primary (label-side) engine.
  // Tape engines speak D1, not lw-450/550 — the LW probes don't
  // apply there.
  await runStatusProbe(primary, device, identity);
  const skuInfo = await runSkuProbe(primary, device);

  return {
    transports,
    device,
    identity,
    ...(skuInfo ? { skuInfo } : {}),
    mocked: false,
  };
}

/**
 * Open one `WebUsbTransport` per engine that declares a USB interface
 * binding. Single-engine and Twin-style devices return one transport
 * keyed by the engine's role; Duo returns two (label + tape).
 *
 * If a per-engine claim fails (some platforms refuse claiming
 * additional interfaces on already-paired devices), the surviving
 * transports are kept and the failed engine logs a warning. Plan 09
 * §rails-not-walls: a partial transport map is still useful — the
 * operator just can't drive the engine that failed.
 */
async function openEngineTransports(
  usbDevice: USBDevice,
  device: LabelWriterDevice,
): Promise<Record<string, Transport>> {
  const transports: Record<string, Transport> = {};
  for (const engine of device.engines) {
    const interfaceNumber = engine.bind?.usb?.bInterfaceNumber;
    try {
      const t = await WebUsbTransport.fromDevice(
        usbDevice,
        interfaceNumber !== undefined ? { interfaceNumber } : undefined,
      );
      transports[engine.role] = t;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console -- diagnostic for partial-claim failures (Duo on platforms that restrict multi-interface paired devices); the surviving transports remain usable per plan 09 §rails-not-walls.
      console.warn(
        `[harness] Could not claim interface ${String(interfaceNumber ?? 0)} for engine ` +
          `"${engine.role}" on ${device.key}: ${detail}. The other engines remain available.`,
      );
    }
  }
  return transports;
}

/**
 * Pick the transport used for the post-connect status + SKU probes.
 * Prefer the label-protocol engine (lw-450 / lw-550) — those are the
 * protocols the probes speak. Falls back to any available transport.
 */
function pickPrimaryTransport(
  transports: Record<string, Transport>,
  device: LabelWriterDevice,
): Transport | undefined {
  for (const engine of device.engines) {
    if (engine.protocol === 'd1-tape') continue;
    const t = transports[engine.role];
    if (t) return t;
  }
  // Fall back to whatever opened, including a tape-only transport
  // (degenerate but possible if the label-engine claim failed).
  return Object.values(transports)[0];
}

function connectMock(): Promise<ConnectResult> {
  // Eagerly resolve so the call signature stays uniform with
  // `connectReal`. Mock transport ops are synchronous internally.
  return new Promise(resolve => {
    void (async () => {
      const transport = MockTransport.open(MOCK_TARGET);
      const meta = MockTransport.identityFor(MOCK_TARGET);
      const device = findDeviceByVidPid(meta.vid, meta.pid);
      if (!device) {
        throw new Error(`Mock target ${MOCK_TARGET} has no matching DEVICES entry — fix mock.ts`);
      }

      const identity: IdentitySnapshot = {
        advertisedName: `${meta.name} (mock)`,
        vid: meta.vid,
        pid: meta.pid,
        extra: { mocked: true, mockTarget: MOCK_TARGET },
      };

      await runStatusProbe(transport, device, identity);
      const skuInfo = await runSkuProbe(transport, device);

      // Mock targets are single-engine LW models; share the one
      // transport across all declared engines so the multi-engine
      // shape is consistent (`transports[role]` always resolves).
      const transports: Record<string, Transport> = {};
      for (const engine of device.engines) {
        transports[engine.role] = transport;
      }

      resolve({
        transports,
        device,
        identity,
        ...(skuInfo ? { skuInfo } : {}),
        mocked: true,
      });
    })();
  });
}

async function runStatusProbe(
  transport: Transport,
  device: LabelWriterDevice,
  identity: IdentitySnapshot,
): Promise<void> {
  const wireOut = buildStatusRequest(device, 0);
  const wireIn = statusByteCount(device);
  try {
    await transport.write(wireOut);
    const response = await transport.read(wireIn, STATUS_TIMEOUT_MS);
    const status = parseStatus(device, response);
    identity.extra = {
      ...identity.extra,
      ready: status.ready,
      mediaLoaded: status.mediaLoaded,
      raw: Array.from(response.subarray(0, Math.min(response.length, 32))),
      ...(status.errors.length > 0 ? { errors: status.errors.map(e => e.code) } : {}),
    };
  } catch (err) {
    identity.extra = {
      ...identity.extra,
      statusProbeError: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Best-effort SKU probe — only attempted on LW 5xx (the family with
 * NFC media detection). Returns the parsed SKU info on success;
 * returns `undefined` when the device doesn't declare media
 * detection or the probe fails (malformed response, timeout, etc.).
 *
 * On a 3xx/4xx the harness's media picker is mandatory anyway, so a
 * silent pass-through here is the right behaviour.
 */
async function runSkuProbe(
  transport: Transport,
  device: LabelWriterDevice,
): Promise<SkuInfo | undefined> {
  const detects = device.engines[0]?.capabilities?.mediaDetection === true;
  if (!detects) return undefined;
  try {
    await transport.write(build550GetSku());
    const response = await transport.read(SKU_INFO_BYTE_COUNT, STATUS_TIMEOUT_MS);
    return parseSkuInfo(response);
  } catch {
    return undefined;
  }
}

/**
 * Send the diagnostic-print bytes to the printer.
 *
 * WebUSB transferOut works at any chunk size up to the device's max
 * packet size; the browser handles chunking internally. We keep a
 * `CHUNK + delay` loop matching the node-usb path so the timing
 * profile is comparable when triaging "works on CLI, fails in
 * browser" reports — same write cadence on both sides.
 */
export async function writeDiagnosticPrint(transport: Transport, bytes: Uint8Array): Promise<void> {
  const CHUNK = 64;
  const DELAY_MS = 5;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, bytes.length);
    await transport.write(bytes.subarray(offset, end));
    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
  }
}
