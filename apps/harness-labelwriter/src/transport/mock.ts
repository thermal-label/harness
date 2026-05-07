/**
 * Mock transport for self-walking the harness without hardware.
 *
 * Activated by appending `?mock=1` to the harness URL. The maintainer
 * pre-walks the flow before sending the link to a friend or community
 * reporter.
 *
 * Behaviour:
 *  - Connect: returns a synthesised identity (LW 330 Turbo by default
 *    — the maintainer's bench printer; override via `MockTransport.target`).
 *  - Status probe (`buildStatusRequest` → `parseStatus`): returns a
 *    plausible 1-byte `lw-450` status with `ready=true`,
 *    `mediaLoaded=true`, no errors.
 *  - SKU probe (`build550GetSku`): returns "no media-detection on this
 *    model" — tested device defaults to the LW 330 Turbo, which lacks
 *    NFC media detection. Switch the mock target to an LW 5xx device
 *    via `?mock=lw550` to exercise the SKU-prefill branch.
 *  - Print writes: silently accepted (counted, not stored).
 *
 * Intentionally tiny — drives the UI; doesn't simulate USB protocol
 * edge cases. The real WebUSB path is what the harness exercises in
 * default mode.
 */
import {
  TransportClosedError,
  TransportTimeoutError,
  type Transport,
} from '@thermal-label/contracts';

/** Mock target — picks which model to pretend is connected. */
export type MockTarget = 'lw330turbo' | 'lw550' | 'lw5xl';

const TARGET_VID_PID: Record<MockTarget, { vid: number; pid: number; key: string; name: string }> =
  {
    lw330turbo: { vid: 0x0922, pid: 0x0008, key: 'LW_330_TURBO', name: 'LabelWriter 330 Turbo' },
    lw550: { vid: 0x0922, pid: 0x0028, key: 'LW_550', name: 'LabelWriter 550' },
    lw5xl: { vid: 0x0922, pid: 0x002a, key: 'LW_5XL', name: 'LabelWriter 5XL' },
  };

interface MockResponse {
  /** A 1-byte lw-450 status: `ready=1, mediaLoaded=1, errors=0`. */
  status: Uint8Array;
  /** A 63-byte `parseSkuInfo` response carrying SKU 30334 (ADDRESS_LARGE). */
  sku550: Uint8Array;
}

function buildMockResponses(): MockResponse {
  // lw-450 single-byte status: bit0=ready, bit1=mediaLoaded.
  const status = new Uint8Array([0x03]);

  // SKU response is firmware-specific binary; mocking the layout
  // exactly would couple this file to `parseSkuInfo` internals. We
  // keep it as a 63-byte zero buffer — the harness's SKU-prefill
  // branch tries the parse, falls back gracefully on malformed data,
  // and proceeds via the manual media picker. That's the same
  // behaviour as a real LW 3xx/4xx connect, which is what the
  // default mock target simulates.
  const sku550 = new Uint8Array(63);

  return { status, sku550 };
}

const RESPONSES = buildMockResponses();

export class MockTransport implements Transport {
  static currentTarget: MockTarget = 'lw330turbo';
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

  static identityFor(target: MockTarget): { vid: number; pid: number; key: string; name: string } {
    return TARGET_VID_PID[target];
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

    // The harness writes `buildStatusRequest` first; queue a status
    // response so the next `read` resolves with plausible bytes. The
    // SKU-probe path is gated behind a different write pattern
    // (`build550GetSku` = ESC U); we detect that prefix and queue
    // the SKU buffer instead.
    if (this.matchesPrefix(data, [0x1b, 0x55])) {
      this.readQueue = RESPONSES.sku550;
    } else if (this.matchesPrefix(data, [0x1b, 0x41])) {
      this.readQueue = RESPONSES.status;
    }
    // Other writes (the actual print payload) are silently consumed.
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

  private matchesPrefix(data: Uint8Array, prefix: readonly number[]): boolean {
    if (data.byteLength < prefix.length) return false;
    return prefix.every((b, i) => data[i] === b);
  }
}
