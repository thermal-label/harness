/**
 * Open a transport for a marklife device and write the encoded
 * diagnostic job.
 *
 * The marklife P12 is reachable two ways from the CLI:
 *  - `usb` — the printer enumerates as a USB Printer-class device
 *    (`09c7:0011`, bulk EP `0x01`); opened via `UsbTransport` (libusb).
 *    The cleanest Linux path — no pairing, no BlueZ.
 *  - `bluetooth-spp` — Classic-BT SPP over an OS-paired RFCOMM device
 *    node (`/dev/rfcomm0`, `COMx`); `SerialTransport.open` opens it.
 *
 * The L11 job stream is transport-independent — the same bytes print
 * over either pipe. Per project memory ("transport layer is
 * assumed-correct") failures here are surfaced verbatim; the verify
 * flow translates them into a friendlier message but does not retry.
 */
import type { MarklifeDevice } from '@thermal-label/marklife-core';
import type { Transport } from '@thermal-label/contracts';
import { SerialTransport, UsbTransport } from '@thermal-label/transport/node';
import type { IdentitySnapshot } from '@thermal-label/harness-core/shared';

export interface ConnectedSession {
  transport: Transport;
  identity: IdentitySnapshot;
}

/** Open the Bluetooth-SPP transport over an OS-paired RFCOMM node. */
export async function connectMarklifeSpp(
  device: MarklifeDevice,
  serialPath: string,
): Promise<ConnectedSession> {
  const transport = await SerialTransport.open(serialPath);
  // RFCOMM carries no model id; the snapshot is the registry name
  // plus the OS device path for the triage reviewer.
  const identity: IdentitySnapshot = {
    advertisedName: device.name,
    serialPath,
  };
  return { transport, identity };
}

/** Open the USB Printer-class transport via libusb. */
export async function connectMarklifeUsb(device: MarklifeDevice): Promise<ConnectedSession> {
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
  return { transport, identity };
}

export async function writeDiagnosticPrint(
  transport: Transport,
  bytes: Uint8Array,
): Promise<void> {
  // 64-byte chunks: the P12's USB bulk endpoint is 64 bytes wide, and
  // the size is harmless over RFCOMM too. The short inter-chunk delay
  // keeps a slow SPP link from overrunning its OS buffer; it is
  // negligible on USB (bulk transfers flow-control themselves).
  const CHUNK = 64;
  const DELAY_MS = 4;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, bytes.length);
    await transport.write(bytes.subarray(offset, end));
    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
  }
}
