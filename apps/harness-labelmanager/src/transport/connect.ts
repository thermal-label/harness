/**
 * Connect orchestrator — owns the click-to-connect flow.
 *
 * Mirrors the verify-cli's labelmanager `connect.ts` (status probe
 * via `STATUS_REQUEST` → `parseStatus`), but uses `WebUsbTransport`
 * instead of node-usb. No NFC SKU probe — labelmanager doesn't have
 * one; the tape-width picker is operator-driven regardless of
 * model.
 */
import {
  parseStatus,
  STATUS_REQUEST,
  type LabelManagerDevice,
} from '@thermal-label/labelmanager-core';
import { WebUsbTransport } from '@thermal-label/transport/web';
import type { Transport } from '@thermal-label/contracts';
import type { IdentitySnapshot } from '@thermal-label/harness-core/shared';
import { MockTransport } from './mock';
import { IS_MOCK_MODE, MOCK_TARGET } from '../composables/useMockMode';
import { buildLabelmanagerUsbFilters, findDeviceByVidPid } from './webusb-filters';

const STATUS_RESPONSE_BYTES = 64;
const STATUS_TIMEOUT_MS = 2_000;

export interface ConnectResult {
  transport: Transport;
  device: LabelManagerDevice;
  identity: IdentitySnapshot;
  /** True if this is the mock transport (UI labels accordingly). */
  mocked: boolean;
}

/**
 * Open a transport via the browser USB picker (or the mock, in
 * `?mock=1` mode), run the status probe.
 *
 * Throws on user-cancel of the picker; throws on hard transport
 * errors. The caller (Connect section) catches and surfaces a
 * friendly message.
 */
export async function connectToLabelmanager(): Promise<ConnectResult> {
  if (IS_MOCK_MODE) {
    return connectMock();
  }
  return connectReal();
}

async function connectReal(): Promise<ConnectResult> {
  const filters = buildLabelmanagerUsbFilters();
  const transport = await WebUsbTransport.request([...filters]);
  // The WebUsbTransport doesn't expose vid/pid directly; we look it
  // up from the underlying USBDevice via `navigator.usb.getDevices`
  // (the previously-paired list — re-prompting via the picker would
  // surface the chooser dialog a second time).
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

  return {
    transport,
    device,
    identity,
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

      await runStatusProbe(transport, identity);

      resolve({
        transport,
        device,
        identity,
        mocked: true,
      });
    })();
  });
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
