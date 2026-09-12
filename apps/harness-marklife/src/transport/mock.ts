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
 * Mock targets — one representative chassis per sub-engine and
 * head-size class, so `?mock=<key>` can walk every distinct encode
 * path without hardware:
 *
 *   p12 — marklife-l11, 0.5" narrow tape, USB + SPP + BLE GATT
 *   p15 — marklife-l11, 0.5" narrow tape, USB + SPP
 *   s2  — marklife-yxq, 2" mobile (the zlib-compressed raster path)
 *   a1  — marklife-tspl, the ASCII-markup path
 *   lp15 — marklife-escpos, the ESC/POS path
 *
 * `key` is the marklife registry key; the adapter resolves it
 * against `DEVICES` so a registry rebind cannot leave a stale
 * protocol behind here.
 */
export type MockTarget = 'p12' | 'p15' | 's2' | 'a1' | 'lp15';

interface MockMeta {
  key: string;
  name: string;
  aliases: readonly string[];
}

export const MOCK_TARGETS: Record<MockTarget, MockMeta> = {
  p12: { key: 'P12', name: 'Marklife P12', aliases: ['p12', 'marklife', 'marklife-p12'] },
  p15: { key: 'P15', name: 'Marklife P15', aliases: ['p15', 'marklife-p15'] },
  s2: { key: 'S2', name: 'Marklife S2', aliases: ['s2', 'marklife-s2'] },
  a1: { key: 'A1', name: 'Marklife A1', aliases: ['a1', 'marklife-a1'] },
  lp15: { key: 'LP15', name: 'Marklife LP15', aliases: ['lp15', 'marklife-lp15'] },
};

export class MockTransport implements Transport {
  static currentTarget: MockTarget = 'p12';
  private _connected = true;
  private writes = 0;

  private constructor() {
    // No per-target state: every marklife chassis is fire-and-forget
    // on the wire, so the mock differs only in which registry entry
    // the adapter pairs it with.
  }

  static open(target: MockTarget = MockTransport.currentTarget): MockTransport {
    MockTransport.currentTarget = target;
    return new MockTransport();
  }

  static identityFor(target: MockTarget): MockMeta {
    return MOCK_TARGETS[target];
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
