/**
 * Mock transport for self-walking the brother-ql harness without
 * hardware.
 *
 * Activated by appending `?mock=1` to the harness URL (default target
 * `ql_820nwbc` — the maintainer's verified bench unit). The maintainer
 * pre-walks the flow before sending the link to a friend or community
 * reporter.
 *
 * Behaviour:
 *  - Connect: returns a synthesised identity for the chosen mock
 *    target (QL_820NWBc default; override via `?mock=ql_810w` etc.).
 *  - Status probe (`STATUS_REQUEST` / `ESC i S` → `parseStatus`):
 *    returns a 32-byte status frame indicating "ready, media loaded,
 *    DK-22205 (62 mm continuous)" — the most common starter roll. The
 *    `auto-locked` MediaPicker mode pre-selects this entry and locks
 *    the catalogue when the engine declares
 *    `capabilities.mediaDetection === true` (every QL_700+ class entry
 *    in the registry).
 *  - Print writes: silently accepted (counted, not stored).
 *
 * Intentionally tiny — drives the UI; doesn't simulate USB protocol
 * edge cases or every status-byte permutation. The real WebUSB path
 * is what the harness exercises in default mode.
 *
 * Status-frame layout (per `brother-ql-core/src/status.ts`):
 *   byte 8  — error info 1 (0 = ok)
 *   byte 9  — error info 2 (0 = ok)
 *   byte 10 — media width mm
 *   byte 11 — media type (0x0A continuous, 0x0B die-cut)
 *   byte 17 — media length mm (0 for continuous rolls)
 *   byte 18 — status type (0x06 phase change / not 0x02 = error response)
 *   byte 25 — bit 7 = two-color-roll flag (0 = single-color)
 */
import {
  TransportClosedError,
  TransportTimeoutError,
  type Transport,
} from '@thermal-label/contracts';

/** Mock target — picks which brother-ql model to pretend is connected. */
export type MockTarget = 'ql_820nwbc' | 'ql_810w' | 'ql_700' | 'ql_1100';

interface MockMeta {
  vid: number;
  pid: number;
  key: string;
  name: string;
}

/**
 * VID/PIDs lifted verbatim from the brother-ql-core registry
 * (`packages/core/data/devices/`). Keep this in sync if registry
 * entries shift; today every entry shares VID 0x04f9.
 */
const TARGET_META: Record<MockTarget, MockMeta> = {
  ql_820nwbc: { vid: 0x04f9, pid: 0x209d, key: 'QL_820NWBc', name: 'QL-820NWBc' },
  ql_810w: { vid: 0x04f9, pid: 0x209c, key: 'QL_810W', name: 'QL-810W' },
  ql_700: { vid: 0x04f9, pid: 0x2042, key: 'QL_700', name: 'QL-700' },
  ql_1100: { vid: 0x04f9, pid: 0x20a7, key: 'QL_1100', name: 'QL-1100' },
};

/**
 * Build a 32-byte status response that parses to "ready, media
 * loaded, DK-22205 (62 mm continuous), single-color". Reused for every
 * mock target — every QL declares `mediaDetection: true` at the
 * engine, so the auto-locked MediaPicker resolves the same entry and
 * locks the catalogue regardless of model.
 *
 * The response intentionally mirrors what `parseStatus` reads, no
 * more: bytes outside the parsed offsets stay zero. A real device
 * fills the printer-id bytes etc. — the parser doesn't care, so we
 * don't either.
 */
function buildMediaLoadedStatus(): Uint8Array {
  const buf = new Uint8Array(32);
  buf[0] = 0x80; // print head mark — informational
  buf[1] = 0x20; // size 32 — informational
  buf[2] = 0x42; // 'B' — informational
  buf[3] = 0x30; // device id placeholder — informational
  buf[8] = 0x00; // error info 1 — no errors
  buf[9] = 0x00; // error info 2 — no errors
  buf[10] = 62; // media width mm — DK-22205 62 mm
  buf[11] = 0x0a; // media type — continuous
  buf[17] = 0x00; // media length — 0 = continuous roll
  buf[18] = 0x06; // status type — phase change (not 0x02 error)
  buf[25] = 0x00; // two-color flag clear — single-color DK-22205
  return buf;
}

const STATUS_RESPONSE = buildMediaLoadedStatus();

export class MockTransport implements Transport {
  static currentTarget: MockTarget = 'ql_820nwbc';
  private _connected = true;
  private writes = 0;
  private readonly target: MockTarget;
  /** Queued bytes for the next `read()` call. */
  private readQueue: Uint8Array | null = null;

  private constructor(target: MockTarget) {
    this.target = target;
  }

  static open(target: MockTarget = MockTransport.currentTarget): MockTransport {
    MockTransport.currentTarget = target;
    return new MockTransport(target);
  }

  static identityFor(target: MockTarget): MockMeta {
    return TARGET_META[target];
  }

  get connected(): boolean {
    return this._connected;
  }

  get bytesWritten(): number {
    return this.writes;
  }

  /** The mock target this transport pretends to be. */
  get mockTarget(): MockTarget {
    return this.target;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async write(data: Uint8Array): Promise<void> {
    if (!this._connected) throw new TransportClosedError('usb');
    this.writes += data.byteLength;

    // The brother-ql adapter writes a preamble (200 zero bytes + ESC @
    // = init) before the status request, then `ESC i S` (1b 69 53).
    // Detect the status-request prefix anywhere in the write payload
    // (the adapter may send the preamble + STATUS_REQUEST as a single
    // chunk on real hardware, or split them — both shapes need to
    // queue a status response).
    if (this.containsStatusRequest(data)) {
      this.readQueue = STATUS_RESPONSE;
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async read(length: number, timeout?: number): Promise<Uint8Array> {
    if (!this._connected) throw new TransportClosedError('usb');

    const queued = this.readQueue;
    if (queued !== null) {
      this.readQueue = null;
      // Trim or pad to the requested length to match the real
      // WebUSB transport's "exact byte count" contract.
      if (queued.byteLength >= length) return queued.subarray(0, length);
      const padded = new Uint8Array(length);
      padded.set(queued);
      return padded;
    }

    // Nothing queued — simulate a timeout (real device would also
    // stall). Caller catches and continues with synthesised
    // identity.extra fields.
    throw new TransportTimeoutError('usb', timeout ?? 0);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async close(): Promise<void> {
    this._connected = false;
  }

  /** Brother-QL status request: ESC i S (0x1b 0x69 0x53). */
  private containsStatusRequest(data: Uint8Array): boolean {
    for (let i = 0; i + 2 < data.byteLength; i += 1) {
      if (data[i] === 0x1b && data[i + 1] === 0x69 && data[i + 2] === 0x53) {
        return true;
      }
    }
    return false;
  }
}
