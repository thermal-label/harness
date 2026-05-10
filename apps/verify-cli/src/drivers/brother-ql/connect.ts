/**
 * Open USB or TCP-9100 transport for a Brother QL device + run the
 * status-query identity probe.
 *
 * Mirrors the labelmanager driver's `connect.ts` shape (`ConnectedSession`
 * carrying `transport` + `IdentitySnapshot`). Bluetooth-SPP is **not**
 * implemented here — see the deferred TODO note in `verify.ts`.
 *
 * Per project memory ("transport layer is assumed-correct"), failures
 * here are surfaced verbatim — the verify orchestrator translates known
 * `DeviceNotFoundError` / `TransportClosedError` into a friendlier
 * stdout message but does not retry, recover, or wrap. A broken
 * transport is a release bug for `@thermal-label/transport`, not a
 * matrix nuance for the harness.
 *
 * Status-probe specifics (brother-ql-core §status.ts):
 *   - Status request is `ESC i S` (3 bytes).
 *   - Response is 32 bytes; we poll up to 1.5 s the same way the
 *     production node adapter does.
 *   - Byte 25 bit 7 carries the two-color-roll flag — `parseStatus`
 *     surfaces it as `BrotherQLStatus.twoColorRoll`. We capture it +
 *     the resolved media descriptor on the identity's `extra` field so
 *     triage can eyeball whether the printer agreed with `--media`.
 */
import {
  parseStatus,
  STATUS_REQUEST,
  type BrotherQLDevice,
  type BrotherQLMedia,
  type BrotherQLStatus,
} from '@thermal-label/brother-ql-core';
import { TcpTransport, UsbTransport } from '@thermal-label/transport/node';
import type { Transport } from '@thermal-label/contracts';
import type { IdentitySnapshot } from '@thermal-label/harness-core/shared';

const STATUS_RESPONSE_BYTES = 32;
const STATUS_POLL_INTERVAL_MS = 150;
const STATUS_POLL_ATTEMPTS = 10;

/**
 * Brother QL preamble — 200 zero bytes ("invalidate") + `ESC @`
 * ("initialize"). Standard sequence the production node adapter
 * embeds at the start of every print job; we send it ahead of the
 * status request too so the printer is in a known state and reports
 * media detection on the response. Without it, a freshly-opened
 * connection often returns a stale or no-detected-media status —
 * which was breaking media auto-detection in the wizard.
 *
 * Built inline because `buildInvalidate` / `buildInitialize` aren't
 * re-exported from `brother-ql-core/index.ts`. Trivial bytes; not
 * worth a driver-core export round-trip.
 */
const QL_PREAMBLE = (() => {
  const buf = new Uint8Array(202);
  // Bytes 0..199 stay zero. ESC @ at 200..201.
  buf[200] = 0x1b;
  buf[201] = 0x40;
  return buf;
})();

export interface ConnectedSession {
  transport: Transport;
  identity: IdentitySnapshot;
  /**
   * Status snapshot (parsed) when the probe succeeded. Undefined when
   * the printer didn't respond within the poll budget — common on
   * brand-new bench printers that haven't completed warm-up yet, or on
   * TCP printers that drop the status request silently when the model
   * has no inbound queue. Either way, the verify flow continues.
   */
  status?: BrotherQLStatus;
}

export interface UsbConnectOptions {
  device: BrotherQLDevice;
}

export interface TcpConnectOptions {
  device: BrotherQLDevice;
  host: string;
  port?: number;
}

export async function connectBrotherQlUsb(options: UsbConnectOptions): Promise<ConnectedSession> {
  const { device } = options;
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
  const status = await probeStatus(transport, device);
  attachStatusToIdentity(identity, status);
  return { transport, identity, ...(status ? { status } : {}) };
}

export async function connectBrotherQlTcp(options: TcpConnectOptions): Promise<ConnectedSession> {
  const { device, host } = options;
  const tcp = device.transports.tcp;
  if (!tcp) {
    throw new Error(
      `Device ${device.key} has no TCP transport in its registry entry; cannot proceed.`,
    );
  }
  const port = options.port ?? tcp.port;
  const transport = await TcpTransport.connect(host, port);
  const identity: IdentitySnapshot = {
    advertisedName: device.name,
    extra: { host, port },
  };
  const status = await probeStatus(transport, device);
  attachStatusToIdentity(identity, status);
  return { transport, identity, ...(status ? { status } : {}) };
}

/**
 * Reset the printer with the QL preamble, then send `ESC i S` and poll
 * for the 32-byte status response. Best-effort: on no-reply, returns
 * `undefined` and the orchestrator surfaces the gap on the identity
 * snapshot's `extra.statusProbeError`.
 *
 * The preamble is what makes media auto-detection reliable on a
 * cold-opened connection — without it the printer returns either no
 * data or a stale/incomplete frame and the detected-media field is
 * empty. With it, we get a clean status frame on the first try.
 */
async function probeStatus(
  transport: Transport,
  device: BrotherQLDevice,
): Promise<BrotherQLStatus | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- every brother-ql device has at least one engine
  const engine = device.engines[0]!;
  try {
    await transport.write(QL_PREAMBLE);
    await transport.write(STATUS_REQUEST);
    for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt += 1) {
      await sleep(STATUS_POLL_INTERVAL_MS);
      const response = await transport.read(STATUS_RESPONSE_BYTES);
      if (response.length >= STATUS_RESPONSE_BYTES) {
        return parseStatus(response, engine);
      }
    }
  } catch {
    // Swallow — caller's identity.extra captures it via no-status path.
  }
  return undefined;
}

function attachStatusToIdentity(
  identity: IdentitySnapshot,
  status: BrotherQLStatus | undefined,
): void {
  if (!status) {
    identity.extra = {
      ...(identity.extra ?? {}),
      statusProbeError: 'no response within 1.5s (printer may need warm-up)',
    };
    return;
  }
  const detected = status.detectedMedia as BrotherQLMedia | undefined;
  identity.extra = {
    ...(identity.extra ?? {}),
    ready: status.ready,
    mediaLoaded: status.mediaLoaded,
    twoColorRoll: detected?.palette !== undefined,
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
    ...(status.errors.length > 0 ? { errors: status.errors } : {}),
  };
}

/**
 * Empirical chunking constants borrowed from the production node
 * adapter (`brother-ql/packages/node/src/printer.ts`) — a single
 * libusb bulk transfer of an entire raster job hangs the QL-820NWBc
 * firmware mid-print. 1 KB chunks with a 20 ms gap keep the input
 * ring buffer drained. TCP doesn't need it (kernel handles flow
 * control on the socket) but applying it uniformly keeps the code
 * simple — adds about 1 s to a 50 KB job.
 */
const CHUNK_SIZE = 1024;
const CHUNK_DELAY_MS = 20;

export async function writeDiagnosticPrint(transport: Transport, bytes: Uint8Array): Promise<void> {
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    const end = Math.min(offset + CHUNK_SIZE, bytes.length);
    await transport.write(bytes.subarray(offset, end));
    if (end < bytes.length) {
      await sleep(CHUNK_DELAY_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
