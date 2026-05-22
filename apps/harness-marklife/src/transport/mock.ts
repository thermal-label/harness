/**
 * Mock transport for self-walking the marklife harness without
 * hardware.
 *
 * Activated by appending `?mock=1` (or `?mock=p12`) to the harness
 * URL. The maintainer pre-walks the flow before sending the link to
 * a friend or community reporter.
 *
 * Behaviour:
 *  - Connect: no picker — `WebMarklifePrinter` is constructed with a
 *    `MockTransport` and the P12 `DeviceEntry` from the registry.
 *  - Write: silently accepted; the write count is tracked for
 *    introspection. The L11 job ends with the `10 FF F1 45` stop
 *    command — a real P12 ack's `0xAA` on the BLE CX characteristic,
 *    but `WebMarklifePrinter.print()` is fire-and-forget (it never
 *    reads a reply), so the mock has nothing to queue.
 *  - Read: the marklife driver never reads from the transport on the
 *    print or status path (`getStatus()` synthesises its status from
 *    the transport's `connected` flag), so a `read()` should not
 *    happen in normal operation. It rejects with a timeout to mirror
 *    a real BLE link that has no unsolicited data to hand back.
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
 * Mock target — singleton today (the P12 is the only marklife model
 * this harness targets). Defined as a union for symmetry with the
 * other harness apps so a future registry expansion has a clean
 * extension point.
 */
export type MockTarget = 'p12';

interface MockMeta {
  key: string;
  name: string;
}

const TARGET_META: Record<MockTarget, MockMeta> = {
  p12: { key: 'P12', name: 'Marklife P12' },
};

export class MockTransport implements Transport {
  static currentTarget: MockTarget = 'p12';
  private _connected = true;
  private writes = 0;

  private constructor() {
    // Per-target state isn't needed today — P12 is the only target.
    // The MockTarget union exists so sibling apps stay shape-
    // symmetric and a future narrow-tape L11 variant has a clean
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
    // L11 print jobs are fire-and-forget on this driver — the chunk
    // is silently consumed. `data` is referenced so an unused-param
    // lint doesn't fire; the byte content is not inspected.
    void data.length;
    return Promise.resolve();
  }

  async read(length: number, timeout?: number): Promise<Uint8Array> {
    if (!this._connected) throw new TransportClosedError('bluetooth-gatt');
    // The marklife driver never reads on the print / status path —
    // surface a timeout for any unexpected caller, matching a real
    // BLE link with no unsolicited data to return.
    void length;
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
