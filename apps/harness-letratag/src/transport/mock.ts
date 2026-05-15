/**
 * Mock transport for self-walking the letratag harness without
 * hardware.
 *
 * Activated by appending `?mock=1` (or `?mock=lt200b`) to the harness
 * URL. The maintainer pre-walks the flow before sending the link to
 * a friend or community reporter.
 *
 * Behaviour:
 *  - Connect: no picker — `LetraTagPrinter` is constructed with a
 *    `MockTransport` and the synthesised LT_200B device entry.
 *  - Status: after a `write()` whose tail is the LT-200B's `MAGIC`
 *    trailer (`[0x12, 0x34]`), queue a 3-byte `[0x1B, 0x52, 0x00]`
 *    (success) reply for the next `read()`. The driver's `print()`
 *    reads exactly `STATUS_NOTIFICATION_LENGTH = 3` bytes after the
 *    payload — see `LetraTagPrinter.print` and
 *    `letratag-core/src/status.ts`.
 *  - Reads outside the expected post-print window time out (the
 *    driver swallows the rejection and leaves `lastStatus` unchanged,
 *    same as a real BLE link that misses the notification).
 *  - `close()`: flips `_connected` to false.
 *
 * Intentionally tiny — drives the harness UI, doesn't simulate every
 * BLE edge case. Real Web Bluetooth is what the harness exercises by
 * default.
 */
import {
  TransportClosedError,
  TransportTimeoutError,
  type Transport,
} from '@thermal-label/contracts';

/**
 * Mock target — singleton today (the LT-200B is the only LetraTag
 * model in the registry). Defined as a union for symmetry with the
 * other harness apps so a future registry expansion has a clean
 * extension point.
 */
export type MockTarget = 'lt_200b';

interface MockMeta {
  key: string;
  name: string;
}

const TARGET_META: Record<MockTarget, MockMeta> = {
  lt_200b: { key: 'LT_200B', name: 'LetraTag LT-200B' },
};

/** LT-200B payload trailer that marks the end of a print job. */
const MAGIC_BYTE_0 = 0x12;
const MAGIC_BYTE_1 = 0x34;
/** Post-print 3-byte success status: `1B 52 00`. */
const SUCCESS_STATUS = new Uint8Array([0x1b, 0x52, 0x00]);

export class MockTransport implements Transport {
  static currentTarget: MockTarget = 'lt_200b';
  private _connected = true;
  private writes = 0;
  /** Queued bytes for the next `read()` call. */
  private readQueue: Uint8Array | null = null;

  private constructor() {
    // Per-target state isn't needed today — LT_200B is the only
    // target. The MockTarget union exists so sibling apps stay
    // shape-symmetric and a future LT variant has a clean
    // extension point.
  }

  static open(target: MockTarget = MockTransport.currentTarget): MockTransport {
    MockTransport.currentTarget = target;
    return new MockTransport();
  }

  static identityFor(target: MockTarget): MockMeta {
    return TARGET_META[target];
  }

  get connected(): boolean {
    return this._connected;
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this._connected) throw new TransportClosedError('bluetooth-gatt');
    this.writes += 1;
    // The LT-200B emits a status reply after the print payload's
    // final chunk. We detect the payload boundary by sniffing the
    // `MAGIC` trailer on any incoming write — anything else (header,
    // body chunks, status request) is silently consumed.
    const len = data.length;
    if (len >= 2 && data[len - 2] === MAGIC_BYTE_0 && data[len - 1] === MAGIC_BYTE_1) {
      this.readQueue = SUCCESS_STATUS;
    }
    return Promise.resolve();
  }

  async read(length: number, timeout?: number): Promise<Uint8Array> {
    if (!this._connected) throw new TransportClosedError('bluetooth-gatt');
    if (this.readQueue !== null) {
      const slice = this.readQueue.slice(0, length);
      this.readQueue = null;
      return Promise.resolve(slice);
    }
    // No queued reply — surface a timeout. The driver's `print()`
    // path swallows this, matching a real BLE link that drops the
    // post-print notification.
    return Promise.reject(new TransportTimeoutError('bluetooth-gatt', timeout ?? 0));
  }

  async close(): Promise<void> {
    this._connected = false;
    return Promise.resolve();
  }

  /** Test / mock-mode introspection — write count since open(). */
  get writeCount(): number {
    return this.writes;
  }
}
