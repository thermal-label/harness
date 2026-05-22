/**
 * Open the Bluetooth-SPP transport for a marklife device and write the
 * encoded diagnostic job.
 *
 * Marklife is a Classic-Bluetooth-SPP family — the vendor APK declares
 * no USB / TCP on the print path (`~/marklife/hardware.md` § 1). The
 * operator pairs the printer at the OS level and binds an RFCOMM
 * device node (`/dev/rfcomm0` on Linux, `/dev/tty.<Name>-SPPDev` on
 * macOS, `COMx` on Windows); `SerialTransport.open` opens that path.
 * RFCOMM carries no model-identifying bytes, so the operator-picked
 * registry entry is the source of truth for the protocol binding.
 *
 * Per project memory ("transport layer is assumed-correct"), failures
 * here are surfaced verbatim — the verify flow translates them into a
 * friendlier stdout message but does not retry, recover, or wrap.
 */
import type { MarklifeDevice } from '@thermal-label/marklife-core';
import { SerialTransport } from '@thermal-label/transport/node';
import type { IdentitySnapshot } from '@thermal-label/harness-core/shared';

export interface ConnectedSession {
  transport: SerialTransport;
  identity: IdentitySnapshot;
}

export async function connectMarklife(
  device: MarklifeDevice,
  serialPath: string,
): Promise<ConnectedSession> {
  const transport = await SerialTransport.open(serialPath);

  // Marklife exposes no host-readable identity probe — the YXQ status
  // opcodes are best-effort and the production node driver's
  // `getStatus()` reports connectivity only (`marklife/packages/node/
  // src/printer.ts`). The RFCOMM channel surfaces no vid/pid or
  // advertised name, so the identity snapshot is the registry name
  // plus the OS device path for the triage reviewer.
  const identity: IdentitySnapshot = {
    advertisedName: device.name,
    serialPath,
  };

  return { transport, identity };
}

export async function writeDiagnosticPrint(
  transport: SerialTransport,
  bytes: Uint8Array,
): Promise<void> {
  // RFCOMM SPP is a slow link; write in modest chunks with a short
  // inter-chunk delay so a multi-KB raster job doesn't overrun the OS
  // serial buffer. The production node driver issues a single
  // `transport.write` — the chunking here is harness-side conservatism
  // for the bench-test path and is wire-identical (RFCOMM reassembles
  // the stream on the printer side).
  const CHUNK = 256;
  const DELAY_MS = 8;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const end = Math.min(offset + CHUNK, bytes.length);
    await transport.write(bytes.subarray(offset, end));
    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
  }
}
