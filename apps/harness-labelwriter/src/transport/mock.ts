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
 *  - SKU probe (`build550GetSku` = `ESC U`): returns "no media-detection
 *    on this model" for non-5xx targets (a 63-byte zero buffer — the
 *    `getMedia()` parse fails gracefully and the operator picks
 *    manually). The `lw550unknown` target is the exception — see below.
 *  - Print writes: silently accepted (counted, not stored).
 *
 * `lw_550_unknown_media` (`?mock=lw_550_unknown_media`, alias
 * `?mock=550-unknown`): an LW 550 whose `ESC U` SKU dump is a
 * well-formed 63-byte NFC structure carrying a SKU **absent from the
 * labelwriter media registry**. `getMedia()` parses it into a
 * geometry-bearing `detectedMedia` that maps to no catalogue entry, so
 * the connect lands straight in the `detected-unrecognized` panel.
 * This is the URL the LW 550 retester (and the maintainer, who has no
 * 550) uses to walk the flow without hardware.
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
export type MockTarget = 'lw330turbo' | 'lw550' | 'lw5xl' | 'lw_450_duo' | 'lw_550_unknown_media';

const TARGET_VID_PID: Record<MockTarget, { vid: number; pid: number; key: string; name: string }> =
  {
    lw330turbo: { vid: 0x0922, pid: 0x0008, key: 'LW_330_TURBO', name: 'LabelWriter 330 Turbo' },
    lw550: { vid: 0x0922, pid: 0x0028, key: 'LW_550', name: 'LabelWriter 550' },
    lw5xl: { vid: 0x0922, pid: 0x002a, key: 'LW_5XL', name: 'LabelWriter 5XL' },
    // LW 450 Duo — paper roll engine + D1 tape engine on separate USB
    // interfaces. Mock connect assigns the same MockTransport to both
    // engine roles (per `connectMock` shape-uniformity), so the
    // EngineTabs strip renders and operators can dry-run both tabs
    // without hardware.
    lw_450_duo: { vid: 0x0922, pid: 0x0023, key: 'LW_450_DUO', name: 'LabelWriter 450 Duo' },
    // LW 550 with an uncatalogued NFC SKU — drives the
    // `detected-unrecognized` panel. Same device as `lw550`.
    lw_550_unknown_media: { vid: 0x0922, pid: 0x0028, key: 'LW_550', name: 'LabelWriter 550' },
  };

interface MockResponse {
  /** A 1-byte lw-450 status: `ready=1, mediaLoaded=1, errors=0`. */
  status: Uint8Array;
  /** A 63-byte `parseSkuInfo` response carrying SKU 30334 (ADDRESS_LARGE). */
  sku550: Uint8Array;
  /**
   * A 63-byte `parseSkuInfo` response carrying an uncatalogued SKU —
   * a 41 mm continuous roll. Used by the `lw_550_unknown_media`
   * target to drive the `detected-unrecognized` panel.
   */
  sku550Unknown: Uint8Array;
}

/**
 * Build a well-formed 63-byte `ESC U` SKU dump.
 *
 * Field offsets per `labelwriter-core` `parseSkuInfo` (the 550
 * Technical Reference NFC table): magic u16 LE at 0-1, SKU ASCII at
 * 8-19, label-type index at byte 23 (0 = continuous, 1 = die), label
 * length u16 LE at 40-41, label width u16 LE at 42-43.
 */
function buildSkuDump(opts: {
  sku: string;
  widthMm: number;
  lengthMm: number;
  dieCut: boolean;
}): Uint8Array {
  const buf = new Uint8Array(63);
  // magic 0xCAB6, little-endian.
  buf[0] = 0xb6;
  buf[1] = 0xca;
  buf[2] = 0x30; // spec version byte
  buf[3] = 0x3b; // payload length (informational)
  // SKU number — ASCII at bytes 8..19.
  for (let i = 0; i < opts.sku.length && i < 12; i++) {
    buf[8 + i] = opts.sku.charCodeAt(i);
  }
  buf[20] = 0x00; // brand = dymo
  buf[21] = 0xff; // region = global
  buf[23] = opts.dieCut ? 1 : 0; // label type
  buf[40] = opts.lengthMm & 0xff;
  buf[41] = (opts.lengthMm >> 8) & 0xff;
  buf[42] = opts.widthMm & 0xff;
  buf[43] = (opts.widthMm >> 8) & 0xff;
  return buf;
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

  // Uncatalogued SKU — 41 mm continuous. SKU `99999` is deliberately
  // absent from the labelwriter media registry, so `skuInfoToMedia`
  // yields a geometry-bearing descriptor (`id: 'sku-99999'`) that
  // maps to no catalogue entry → `detected-unrecognized`.
  const sku550Unknown = buildSkuDump({
    sku: '99999',
    widthMm: 41,
    lengthMm: 0,
    dieCut: false,
  });

  return { status, sku550, sku550Unknown };
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
    // the SKU buffer instead. The `lw_550_unknown_media` target
    // answers ESC U with an uncatalogued SKU so the connect lands in
    // the `detected-unrecognized` panel.
    if (this.matchesPrefix(data, [0x1b, 0x55])) {
      this.readQueue =
        this.target === 'lw_550_unknown_media' ? RESPONSES.sku550Unknown : RESPONSES.sku550;
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
