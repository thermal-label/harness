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
  transport: Transport;
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
  const transport = await WebUsbTransport.request([...filters]);
  // The WebUsbTransport doesn't expose vid/pid directly; we look it
  // up from the underlying USBDevice via `navigator.usb.getDevices`.
  // Cleaner approach: ask the picker again? No — re-prompts the
  // user. Use the previously-paired list.
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
      `No labelwriter device matched vid=0x${vid.toString(16)} pid=0x${pid.toString(16)}. ` +
        `The browser picker selected an unknown PID. Open the manual VID/PID drawer to override.`,
    );
  }

  const identity: IdentitySnapshot = {
    advertisedName: matching?.productName ?? device.name,
    vid,
    pid,
  };

  await runStatusProbe(transport, device, identity);
  const skuInfo = await runSkuProbe(transport, device);

  return {
    transport,
    device,
    identity,
    ...(skuInfo ? { skuInfo } : {}),
    mocked: false,
  };
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

      resolve({
        transport,
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
