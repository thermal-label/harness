/**
 * Mock transport for self-walking the labelmanager harness without
 * hardware.
 *
 * Activated by appending `?mock=1` to the harness URL. The maintainer
 * pre-walks the flow before sending the link to a friend or community
 * reporter.
 *
 * Behaviour:
 *  - Connect: returns a synthesised identity (LM PnP by default — the
 *    maintainer's bench unit; override via `?mock=lm280` etc.).
 *  - Status probe (`STATUS_REQUEST` → `parseStatus`): returns a
 *    plausible single-byte status with `ready=true`,
 *    `mediaLoaded=true`, no errors. Labelmanager's status doesn't
 *    carry tape-width — the harness's tape-width picker is
 *    operator-driven regardless of model.
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

/** Mock target — picks which labelmanager model to pretend is connected. */
export type MockTarget =
  | 'lm_pnp'
  | 'lm_280'
  | 'lm_400'
  | 'lm_420p'
  | 'lm_pc'
  | 'lm_wireless_pnp'
  | 'labelpoint_350'
  | 'mobile_labeler';

/**
 * VID/PIDs lifted from the labelmanager-core registry
 * (`devices.generated.ts`). Keep this in sync if registry entries
 * shift; today every entry shares VID 0x0922.
 */
const TARGET_VID_PID: Record<MockTarget, { vid: number; pid: number; key: string; name: string }> =
  {
    lm_pnp: { vid: 0x0922, pid: 0x1002, key: 'LM_PNP', name: 'LabelManager PnP' },
    lm_280: { vid: 0x0922, pid: 0x1006, key: 'LM_280', name: 'LabelManager 280' },
    lm_400: { vid: 0x0922, pid: 0x0013, key: 'LM_400', name: 'LabelManager 400' },
    lm_420p: { vid: 0x0922, pid: 0x1004, key: 'LM_420P', name: 'LabelManager 420P' },
    lm_pc: { vid: 0x0922, pid: 0x0011, key: 'LM_PC', name: 'LabelManager PC' },
    lm_wireless_pnp: {
      vid: 0x0922,
      pid: 0x1008,
      key: 'LM_WIRELESS_PNP',
      name: 'LabelManager Wireless PnP',
    },
    labelpoint_350: {
      vid: 0x0922,
      pid: 0x0015,
      key: 'LABELPOINT_350',
      name: 'LabelPoint 350',
    },
    mobile_labeler: {
      vid: 0x0922,
      pid: 0x1009,
      key: 'MOBILE_LABELER',
      name: 'Mobile Labeler',
    },
  };

interface MockResponse {
  /**
   * Single-byte labelmanager status: bit0=ready (clear), bit1=no
   * tape (clear), bit2=tape low (clear). 0x00 → ready + media + ok.
   */
  status: Uint8Array;
}

const RESPONSES: MockResponse = { status: new Uint8Array([0x00]) };

export class MockTransport implements Transport {
  static currentTarget: MockTarget = 'lm_pnp';
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

    // The harness writes the labelmanager `STATUS_REQUEST` (ESC A,
    // bytes 0x1b 0x41) before any print payload. Detect the prefix
    // and queue a status response so the next `read()` resolves
    // with plausible bytes. Other writes (the actual print payload)
    // are silently consumed.
    if (this.matchesPrefix(data, [0x1b, 0x41])) {
      this.readQueue = RESPONSES.status;
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

  private matchesPrefix(data: Uint8Array, prefix: readonly number[]): boolean {
    if (data.byteLength < prefix.length) return false;
    return prefix.every((b, i) => data[i] === b);
  }
}
