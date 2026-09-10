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
 *    plausible status sized to the target's protocol — a 1-byte
 *    `lw-450` status (`0x03`) for 3xx/4xx targets, a 32-byte `ESC A`
 *    frame for `lw5-raster` targets (550 / 5XL). Both decode to
 *    `ready=true`, `mediaLoaded=true`, no errors.
 *  - SKU probe (`build550GetSku` = `ESC U`): returns "no media-detection
 *    on this model" for non-5xx targets (a 63-byte zero buffer — the
 *    `getMedia()` parse fails gracefully and the operator picks
 *    manually). 5xx targets get a well-formed 63-byte SKU dump.
 *  - Version probe (`build550GetVersion` = `ESC V`): 5xx targets get a
 *    plausible 34-byte HW/FW/PID block; other targets stall (real
 *    3xx/4xx firmware has no `ESC V`).
 *  - Print writes: silently accepted (counted, not stored).
 *
 * `lw_550_unknown_media` (`?mock=lw_550_unknown_media`, alias
 * `?mock=550-unknown`): an LW 550 replaying a **real `ESC U` reply
 * captured off hardware** — SKU `S0722540`, a 57.1 × 31.7 mm die-cut
 * roll **absent from the labelwriter media registry**. `getMedia()`
 * parses it into a geometry-bearing `detectedMedia` that maps to no
 * catalogue entry, so the connect lands straight in the
 * `detected-unrecognized` panel. The dimensions are deliberately
 * non-integer (raw u16 `0x023B` → 57.1 mm via `u16DeciMm`): this is
 * the frame that surfaced the deci-mm parsing bug, so the target
 * doubles as a decimal-geometry regression walk-through. This is the
 * URL the LW 550 retester (and the maintainer, who has no 550) uses
 * to walk the flow without hardware.
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
  /**
   * A 32-byte `parseStatus550` (`ESC A`) frame — print status idle,
   * job ID `0`, bay status 8 (media OK), head OK, voltage OK, density
   * 100, label index 0, 220 labels remaining, external power present.
   * Decodes to `ready=true`, `mediaLoaded=true`, no errors, and a full
   * `details[]` row set so the diagnostics panel is exercised.
   */
  status550: Uint8Array;
  /** A 63-byte `parseSkuInfo` response carrying SKU 30252 (catalogued). */
  sku550: Uint8Array;
  /**
   * A verbatim 63-byte `ESC U` reply captured off a real LW 550 —
   * uncatalogued SKU `S0722540`, a 57.1 × 31.7 mm die-cut roll. Used
   * by the `lw_550_unknown_media` target to drive the
   * `detected-unrecognized` panel against genuine deci-mm geometry.
   */
  sku550Unknown: Uint8Array;
  /**
   * A 34-byte `parseEngineVersion` (`ESC V`) block for the LW 550 — HW
   * `1.0`, firmware application kind, version `0102.0003`, release
   * `0521`, PID 0x0028.
   */
  version550: Uint8Array;
  /** As {@link MockResponse.version550}, but carrying the LW 5XL PID (0x002a). */
  version5xl: Uint8Array;
}

/** Write a little-endian u16 at `offset`. */
function writeU16(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = value & 0xff;
  buf[offset + 1] = (value >> 8) & 0xff;
}

/**
 * Build a well-formed 63-byte `ESC U` SKU dump.
 *
 * Field offsets per `labelwriter-core` `parseSkuInfo` (the 550
 * Technical Reference NFC table). Beyond the identifying fields, the
 * secondary geometry — marker pitch/width, liner width, printable
 * offsets, total roll length — is derived from the label dimensions so
 * the decoded `SkuInfo` and the verbatim `rawBytes` carried into the
 * report resemble a real device's. Those derived values are plausible
 * estimates, not device-confirmed (the maintainer has no LW 5xx unit).
 *
 * `crc` (bytes 4-5) is left zero: `parseSkuInfo` reads but never
 * validates it, and the device's CRC algorithm is not public.
 */
function buildSkuDump(opts: {
  sku: string;
  widthMm: number;
  lengthMm: number;
  dieCut: boolean;
  material?: number;
  totalLabelCount?: number;
  counterStrategy?: number;
  productionDate?: string;
}): Uint8Array {
  const buf = new Uint8Array(63);
  buf[0] = 0xb6; // magic 0xCAB6, little-endian
  buf[1] = 0xca;
  buf[2] = 0x30; // spec version byte
  buf[3] = 0x3b; // payload length (informational)
  // bytes 4-5: CRC — left zero (see JSDoc).
  // SKU number — ASCII at bytes 8..19.
  for (let i = 0; i < opts.sku.length && i < 12; i++) {
    buf[8 + i] = opts.sku.charCodeAt(i);
  }
  buf[20] = 0x00; // brand = dymo
  buf[21] = 0xff; // region = global
  buf[22] = opts.material ?? 0x03; // material (3 = paper)
  buf[23] = opts.dieCut ? 1 : 0; // label type
  buf[24] = 1; // label colour: white (the common address-label stock)
  buf[25] = 0x00; // content colour: black
  // Marker geometry — die-cut media carry an inter-label gap marker;
  // continuous media leave bytes 26..39 zero.
  const pitchMm = opts.dieCut ? opts.lengthMm + 3 : opts.lengthMm;
  if (opts.dieCut) {
    buf[26] = 1; // marker type: gap
    writeU16(buf, 28, pitchMm); // marker pitch = label length + ~3 mm gap
    writeU16(buf, 30, 3); // marker 1 width (the gap)
    writeU16(buf, 32, 2); // marker 1 to label start
    // marker 2 (bytes 34..37) — single-marker media: unused, left zero.
  }
  // bytes 38-39: vertical offset — left zero.
  writeU16(buf, 40, opts.lengthMm);
  writeU16(buf, 42, opts.widthMm);
  writeU16(buf, 44, 1); // printable horizontal offset (mm)
  writeU16(buf, 46, 1); // printable vertical offset (mm)
  writeU16(buf, 48, opts.widthMm + 4); // liner width ≈ label + 4 mm
  const total = opts.totalLabelCount ?? 0;
  writeU16(buf, 50, total);
  writeU16(buf, 52, Math.min(total * pitchMm, 0xffff)); // total roll length
  // bytes 54-55: counter margin — left zero.
  buf[56] = opts.counterStrategy ?? 0; // 0 = count-up
  const prod = opts.productionDate ?? '';
  for (let i = 0; i < prod.length && i < 2; i++) {
    buf[60 + i] = prod.charCodeAt(i); // production date ASCII, bytes 60..61
  }
  // byte 62: production time — the 63-byte frame has no room for the
  // full HHMM field; left zero (matches the driver's narrow read).
  return buf;
}

/**
 * Build a well-formed 32-byte `ESC A` status frame for an `lw5-raster`
 * target. Layout per `labelwriter-core` `parseStatus550`: byte 0 print
 * status, bytes 1-4 job ID, bytes 5-6 label index, byte 8 head status,
 * byte 9 density, byte 10 bay status, bytes 23-26 error ID, bytes 27-28
 * labels remaining, byte 29 EPS, byte 30 head voltage.
 *
 * Defaults to a healthy idle 550: idle, bay OK, head OK, voltage OK,
 * density 100, 220 labels remaining, external power present.
 */
function build550StatusFrame(): Uint8Array {
  const buf = new Uint8Array(32);
  buf[0] = 0; // print status: idle
  // job ID 0 (bytes 1-4 already zero); label index 0 (bytes 5-6 zero)
  buf[8] = 0; // head status: OK
  buf[9] = 100; // print density 100%
  buf[10] = 8; // bay status: media present, OK
  // error ID 0 (bytes 23-26 already zero)
  buf[27] = 220 & 0xff; // labels remaining = 220
  buf[28] = (220 >> 8) & 0xff;
  buf[29] = 0x01; // EPS bit 0: external power present
  buf[30] = 1; // head voltage: OK
  buf[31] = 0xff; // reserved
  return buf;
}

/**
 * Build a well-formed 34-byte `ESC V` engine-version block for the
 * given USB PID. Layout per `labelwriter-core` `parseEngineVersion`:
 * hw version ASCII 0-15, fw kind ASCII 16-19, fw major 20-23, fw minor
 * 24-27, release date 28-31, PID u16 LE 32-33.
 */
function build550VersionBlock(pid: number): Uint8Array {
  const buf = new Uint8Array(34);
  const write = (text: string, at: number, max: number): void => {
    for (let i = 0; i < text.length && i < max; i++) buf[at + i] = text.charCodeAt(i);
  };
  write('1.0', 0, 16); // hw version
  write('FWAP', 16, 4); // fw kind: application
  write('0102', 20, 4); // fw major
  write('0003', 24, 4); // fw minor
  write('0521', 28, 4); // release date MMYY
  writeU16(buf, 32, pid); // USB PID, little-endian
  return buf;
}

function buildMockResponses(): MockResponse {
  // lw-450 single-byte status: bit0=ready, bit1=mediaLoaded.
  const status = new Uint8Array([0x03]);

  // 32-byte lw5-raster `ESC A` frame — healthy idle 550.
  const status550 = build550StatusFrame();

  // Catalogued SKU dump — SKU 30252 (a 28×89 mm die-cut address
  // label, present in the labelwriter media registry). Carries
  // material / total-count / production-date so `skuInfoDetails`
  // produces a full roll-instance detail set.
  const sku550 = buildSkuDump({
    sku: '30252',
    widthMm: 28,
    lengthMm: 89,
    dieCut: true,
    material: 0x03, // paper
    totalLabelCount: 260,
    counterStrategy: 0, // count-up
    productionDate: '21',
  });

  // Uncatalogued SKU — a real `ESC U` reply captured off an LW 550 by
  // a community tester (2026-05-23 bench capture). SKU `S0722540` is
  // absent from the labelwriter media registry, so `skuInfoToMedia`
  // yields a geometry-bearing descriptor (`id: 'sku-S0722540'`,
  // 57.1 × 31.7 mm die-cut) that maps to no catalogue entry →
  // `detected-unrecognized`.
  //
  // Verbatim 63-byte capture: full secondary geometry — marker pitch /
  // width / start offset, vertical offset, liner width, total label
  // count (1000), total roll length, counter margin, count-down
  // strategy, and production date / time bytes. `parseSkuInfo` +
  // `skuInfoDetails` exercise their real-world parsing paths, not a
  // sparser synthesised approximation. This is also the frame that
  // surfaced the deci-mm parsing bug (raw u16 `0x023B` → 57.1 mm via
  // `u16DeciMm`) — kept as a decimal-geometry regression walk-through.
  const sku550Unknown = new Uint8Array([
    0xb6, 0xca, 0x00, 0x3c, 0x82, 0xeb, 0xee, 0x6f, // magic / version / length=60 / crc / reserved
    0x53, 0x30, 0x37, 0x32, 0x32, 0x35, 0x34, 0x30, // SKU "S0722540" (bytes 8-15)
    0x00, 0x00, 0x00, 0x00, // SKU field padding (bytes 16-19)
    0x00, 0xff, 0x06, 0x01, // brand=dymo, region, material=removable, labelType=die
    0x01, 0x00, 0x00, 0x00, // labelColor=white, contentColor=black, markerType=0
    0x9d, 0x01, 0x1e, 0x00, // markerPitch=413 (41.3 mm), marker1Width=30 (3.0 mm)
    0x58, 0x00, 0x00, 0x00, // marker1ToStart=88 (8.8 mm), marker2Width=0
    0x00, 0x00, 0x19, 0x00, // marker2Offset=0, verticalOffset=25 (2.5 mm)
    0x3d, 0x01, 0x3b, 0x02, // labelLength=317 (31.7 mm), labelWidth=571 (57.1 mm)
    0x00, 0x00, 0x00, 0x00, // printable offsets (bytes 44-47)
    0x6b, 0x02, 0xe8, 0x03, // linerWidth=619 (61.9 mm), totalLabelCount=1000
    0xa0, 0x50, 0x64, 0x00, // totalLength=20640 (2064.0 mm), counterMargin=100
    0x01, 0x00, 0x00, 0x00, // counterStrategy=count-down (bytes 56-59)
    0xc9, 0x5f, 0x91, // productionDate (60-61), productionTime first byte (62)
  ]);

  // 34-byte lw5-raster `ESC V` engine-version blocks — the USB PID
  // differs per model (LW 550 = 0x0028, LW 5XL = 0x002a).
  const version550 = build550VersionBlock(0x0028);
  const version5xl = build550VersionBlock(0x002a);

  return { status, status550, sku550, sku550Unknown, version550, version5xl };
}

const RESPONSES = buildMockResponses();

/**
 * Targets whose primary engine speaks `lw5-raster` — these answer
 * `ESC A` with the 32-byte frame and `ESC V` with the version block.
 * The Duo's label engine is classic `lw-raster`, so it stays on the
 * 1-byte status form.
 */
const LW5_TARGETS = new Set<MockTarget>(['lw550', 'lw5xl', 'lw_550_unknown_media']);

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
    // response so the next `read` resolves with plausible bytes. Three
    // 550-family query commands are dispatched by their `ESC` prefix:
    //   ESC U (0x1b 0x55) — Get SKU Information → 63-byte dump
    //   ESC V (0x1b 0x56) — Get Engine Version → 34-byte block
    //   ESC A (0x1b 0x41) — Request Print Engine Status → 32-byte
    //                       frame on lw5-raster, 1-byte on lw-450
    // The `lw_550_unknown_media` target answers ESC U with an
    // uncatalogued SKU so the connect lands in the
    // `detected-unrecognized` panel.
    const isLw5 = LW5_TARGETS.has(this.target);
    if (this.matchesPrefix(data, [0x1b, 0x55])) {
      this.readQueue =
        this.target === 'lw_550_unknown_media' ? RESPONSES.sku550Unknown : RESPONSES.sku550;
    } else if (this.matchesPrefix(data, [0x1b, 0x56])) {
      // ESC V — only lw5-raster firmware answers; others stall. The
      // version block's PID is model-specific (5XL = 0x002a).
      if (!isLw5) {
        this.readQueue = null;
      } else {
        this.readQueue = this.target === 'lw5xl' ? RESPONSES.version5xl : RESPONSES.version550;
      }
    } else if (this.matchesPrefix(data, [0x1b, 0x41])) {
      this.readQueue = isLw5 ? RESPONSES.status550 : RESPONSES.status;
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
