/**
 * Open the USB transport for a labelmanager device + run the
 * status-query identity probe.
 *
 * Per project memory ("transport layer is assumed-correct"), failures
 * here are surfaced verbatim — the verify flow translates known
 * `DeviceNotFoundError` / `TransportClosedError` into a friendlier
 * stdout message but does not retry, recover, or wrap. A broken
 * transport is a release bug for the transport repo, not a matrix
 * nuance for the harness.
 */
import {
  parseStatus,
  STATUS_REQUEST,
  type LabelManagerDevice,
} from '@thermal-label/labelmanager-core';
import { UsbTransport } from '@thermal-label/transport/node';
import type { IdentitySnapshot } from '@thermal-label/harness-core/shared';

export interface ConnectedSession {
  transport: UsbTransport;
  identity: IdentitySnapshot;
}

const STATUS_RESPONSE_BYTES = 64;
const STATUS_TIMEOUT_MS = 2_000;

export async function connectLabelmanager(device: LabelManagerDevice): Promise<ConnectedSession> {
  const usb = device.transports.usb;
  if (!usb) {
    throw new Error(
      `Device ${device.key} has no USB transport in its registry entry; cannot proceed.`,
    );
  }
  const vid = parseInt(usb.vid, 16);
  const pid = parseInt(usb.pid, 16);

  const transport = await UsbTransport.open(vid, pid);

  const identity: IdentitySnapshot = {
    advertisedName: device.name,
    vid,
    pid,
  };

  // Status probe — best-effort. The labelmanager status byte does not
  // carry a tape-width field (see `labelmanager-core/src/status.ts`),
  // so we record the raw byte plus the readiness flags from
  // `parseStatus`. Some labelmanagers stall the IN endpoint until the
  // first print; if the probe times out, surface what we know without
  // aborting.
  try {
    await transport.write(STATUS_REQUEST);
    const response = await transport.read(STATUS_RESPONSE_BYTES, STATUS_TIMEOUT_MS);
    const status = parseStatus(response);
    identity.extra = {
      ready: status.ready,
      mediaLoaded: status.mediaLoaded,
      raw: Array.from(response.subarray(0, Math.min(response.length, 16))),
    };
  } catch (err) {
    identity.extra = {
      statusProbeError: err instanceof Error ? err.message : String(err),
    };
  }

  return { transport, identity };
}

export async function writeDiagnosticPrint(
  transport: UsbTransport,
  bytes: Uint8Array,
): Promise<void> {
  // Same chunking convention the production driver uses
  // (`labelmanager/packages/node/src/printer.ts`): 64-byte chunks with
  // a 5 ms delay between writes. Replicated here rather than depending
  // on `DymoPrinter` so the verify-cli's diagnostic-print path stays
  // independent of the driver's higher-level printing API.
  const CHUNK = 64;
  const DELAY_MS = 5;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, bytes.length);
    await transport.write(bytes.subarray(offset, end));
    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
  }
}
