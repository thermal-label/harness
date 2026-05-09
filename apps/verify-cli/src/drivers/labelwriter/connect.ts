/**
 * Open a transport for a labelwriter device + run the identity probe.
 *
 * Two transport flavours surface here:
 *   - USB: `UsbTransport` from `@thermal-label/transport/node`. Vid/pid
 *     come from the registry entry. Identity probe is `ESC A` →
 *     `parseStatus` on the response (1 byte for the lw-450 family,
 *     32 bytes for the lw-550 family); per-protocol byte count via
 *     `statusByteCount(device)`.
 *   - TCP-9100: `TcpTransport.connect(host, 9100)`. Identity is the
 *     host:port pair; the status probe is best-effort — many networked
 *     LabelWriters (notably the LW Wireless / 5XL) accept print bytes on
 *     9100 but don't echo `ESC A` back; we record `extra.statusProbeError`
 *     and move on rather than abort. Plan 05's transport-axiom: a broken
 *     transport is a release bug, not a matrix nuance.
 *
 * Per project memory ("transport layer is assumed-correct"), failures
 * here surface verbatim — the verify flow translates known errors into
 * a friendly stdout message but does not retry.
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
import { TcpTransport, UsbTransport } from '@thermal-label/transport/node';
import type { PrintEngine, Transport } from '@thermal-label/contracts';
import type { IdentitySnapshot } from '@thermal-label/harness-core/shared';

export interface ConnectedSession<T extends Transport = Transport> {
  transport: T;
  identity: IdentitySnapshot;
}

const STATUS_TIMEOUT_MS = 2_000;

/**
 * Open USB + run the lw-450/550 status probe.
 *
 * Records the parsed `ready` / `mediaLoaded` flags in `identity.extra`,
 * plus the raw response bytes for triage. If the probe times out (some
 * units stall the IN endpoint until the first print job hits), we
 * surface `statusProbeError` rather than failing the connect — the
 * print + assess loop tolerates an unknown initial status.
 */
export async function connectLabelwriterUsb(
  device: LabelWriterDevice,
  engine?: PrintEngine,
): Promise<ConnectedSession<UsbTransport>> {
  const usb = device.transports.usb;
  if (!usb) {
    throw new Error(
      `Device ${device.key} has no USB transport in its registry entry; cannot proceed.`,
    );
  }
  const vid = parseInt(usb.vid, 16);
  const pid = parseInt(usb.pid, 16);

  // Multi-engine devices with per-engine USB-interface routing (Duo:
  // label = interface 0, tape = interface 1) need `claimInterface(N)`
  // on the right interface for the active engine. Single-engine
  // devices and Twin-style chassis (in-band roll-select, one
  // interface) ignore the bind hint.
  const bInterfaceNumber = engine?.bind?.usb?.bInterfaceNumber;
  const transport =
    bInterfaceNumber !== undefined
      ? await UsbTransport.open(vid, pid, { bInterfaceNumber })
      : await UsbTransport.open(vid, pid);

  const identity: IdentitySnapshot = {
    advertisedName: device.name,
    vid,
    pid,
    ...(engine
      ? {
          extra: { engineRole: engine.role, engineProtocol: engine.protocol },
        }
      : {}),
  };

  // Status probe on the tape engine speaks D1 (1-byte status reply),
  // not lw-450/550 — skip the LW probe there. The labelwriter probe
  // would either time out or echo garbage on a D1 head.
  if (engine?.protocol === 'd1-tape') {
    return { transport, identity };
  }

  await runStatusProbe(transport, device, identity);

  return { transport, identity };
}

/**
 * Open TCP-9100 + run the status probe.
 *
 * Identity is best-effort: TCP transports don't expose a vid/pid, and
 * the `ESC A` probe is unreliable across networked LabelWriter models
 * (the 5XL responds; the Wireless silently drops the request).
 * `extra.host` and `extra.port` carry the routing info for triage.
 */
export async function connectLabelwriterTcp(
  device: LabelWriterDevice,
  host: string,
  port = 9100,
): Promise<ConnectedSession<TcpTransport>> {
  const transport = await TcpTransport.connect(host, port);

  const identity: IdentitySnapshot = {
    advertisedName: device.name,
    extra: { host, port },
  };

  await runStatusProbe(transport, device, identity);

  return { transport, identity };
}

/**
 * Send the diagnostic-print bytes to the printer.
 *
 * USB and TCP both accept the same wire stream (the labelwriter encoder
 * is transport-agnostic). USB is chunked at the bulk-OUT MTU
 * convention (64 bytes with a 5 ms gap, matching the production node
 * driver). TCP writes in one shot — the kernel handles framing.
 */
export async function writeDiagnosticPrint(transport: Transport, bytes: Uint8Array): Promise<void> {
  if (transport instanceof UsbTransport) {
    const CHUNK = 64;
    const DELAY_MS = 5;
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      const end = Math.min(offset + CHUNK, bytes.length);
      await transport.write(bytes.subarray(offset, end));
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
    return;
  }
  await transport.write(bytes);
}

/**
 * Lightweight one-shot SKU probe over USB for `--media` auto-detection.
 *
 * Only attempted when the device's primary engine declares
 * `capabilities.mediaDetection: true` (LW 5xx family). Opens, sends
 * `ESC U`, reads the 63-byte SKU dump, and closes — all best-effort.
 * Caller proceeds without detection if the probe throws or the device
 * isn't capable.
 *
 * Run before the full connect-and-print flow so `resolveMedia` can use
 * the detected SKU as a default. The user's `--media` flag (if passed)
 * always wins regardless of what's detected.
 */
export async function probeLabelwriterMedia(
  device: LabelWriterDevice,
): Promise<SkuInfo | undefined> {
  const usb = device.transports.usb;
  const detects = device.engines[0]?.capabilities?.mediaDetection === true;
  if (!usb || !detects) return undefined;
  const vid = parseInt(usb.vid, 16);
  const pid = parseInt(usb.pid, 16);

  let transport: UsbTransport | undefined;
  try {
    transport = await UsbTransport.open(vid, pid);
    await transport.write(build550GetSku());
    const response = await transport.read(SKU_INFO_BYTE_COUNT, STATUS_TIMEOUT_MS);
    return parseSkuInfo(response);
  } catch {
    return undefined;
  } finally {
    await transport?.close();
  }
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
