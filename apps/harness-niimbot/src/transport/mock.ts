/**
 * Mock transport for self-walking the niimbot harness without
 * hardware.
 *
 * Activated by appending `?mock=1` (or `?mock=b1`) to the harness
 * URL. The maintainer pre-walks the flow before sending the link to
 * a friend or community reporter.
 *
 * Behaviour:
 *  - `write(packet)` parses the framed niimbot packet (`55 55 cmd
 *    len data... crc aa aa`) and queues the matching `In_*` reply
 *    so the next `read(1)` from the driver's reader loop pulls it
 *    cleanly.
 *  - For row-stream opcodes (`PrintBitmapRow`, `PrintEmptyRow`,
 *    `PrintBitmapRowIndexed`) no reply is queued — those are
 *    fire-and-forget on the wire.
 *  - For `PrintStatus` the reply uses a "completed" payload
 *    (`pages_printed=255, progress=100`) — the b1 strategy's
 *    completion check (`pages_printed >= copies && progress === 100`)
 *    fires on the first poll, so the harness mock-print returns
 *    instantly instead of dragging the operator through a 60-second
 *    timeout.
 *  - For Heartbeat the reply mimics `In_HeartbeatAdvanced1` shape so
 *    `getStatus()` doesn't error during the connect flow.
 *  - `read()` outside the queued window times out — the driver swallows
 *    the rejection, matching a real BLE link that misses a notification.
 *
 * Intentionally tiny — drives the harness UI, doesn't simulate every
 * niimbot edge case. Real Web Bluetooth is what the harness exercises
 * by default.
 */
import {
  TransportClosedError,
  TransportTimeoutError,
  type Transport,
} from '@thermal-label/contracts';
import { buildPacket, REPLY } from '@thermal-label/niimbot-core';

/**
 * Mock target — singleton today (the B1 is the only bench device in
 * the maintainer's hands). Defined as a union for symmetry with the
 * other harness apps so future targets have a clean extension point.
 */
export type MockTarget = 'b1';

interface MockMeta {
  key: string;
  name: string;
}

const TARGET_META: Record<MockTarget, MockMeta> = {
  b1: { key: 'B1', name: 'Niimbot B1' },
};

const CMD = {
  PrintStart: 0x01,
  PageStart: 0x03,
  SetPageSize: 0x13,
  SetDensity: 0x21,
  SetLabelType: 0x23,
  PageEnd: 0xe3,
  PrintEnd: 0xf3,
  PrintStatus: 0xa3,
  PrinterStatusData: 0xa5,
  Heartbeat: 0xdc,
  RfidInfo2: 0x1c,
} as const;

export class MockTransport implements Transport {
  static currentTarget: MockTarget = 'b1';
  private _connected = true;
  private writes = 0;
  /** Queued bytes for the next `read()` call(s). */
  private readQueue: Uint8Array = new Uint8Array(0);

  private constructor() {
    // Per-target state isn't needed today — B1 is the only target.
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
    // Each write from NiimbotPrinter is a single framed packet.
    if (data.length < 7 || data[0] !== 0x55 || data[1] !== 0x55) {
      // Unexpected framing — silently drop. Real wire would too.
      return;
    }
    const cmd = data[2] ?? 0;
    const reply = this.replyFor(cmd);
    if (reply) {
      const next = new Uint8Array(this.readQueue.length + reply.length);
      next.set(this.readQueue, 0);
      next.set(reply, this.readQueue.length);
      this.readQueue = next;
    }
    return Promise.resolve();
  }

  async read(length: number, timeout?: number): Promise<Uint8Array> {
    if (!this._connected) throw new TransportClosedError('bluetooth-gatt');
    if (this.readQueue.length >= length) {
      const slice = this.readQueue.subarray(0, length);
      this.readQueue = this.readQueue.subarray(length);
      return Promise.resolve(new Uint8Array(slice));
    }
    // No queued bytes for the requested length — surface a timeout.
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

  // ── reply table ────────────────────────────────────────────────

  private replyFor(cmd: number): Uint8Array | undefined {
    switch (cmd) {
      case CMD.Heartbeat:
        // 13-byte In_HeartbeatAdvanced1: [reserved×2, cover, paper, rfid,
        // batt%, ...]. lid closed, paper present, rfid valid, ~96% batt.
        return buildPacket(REPLY.In_HeartbeatAdvanced1, [
          0x00, 0x00, 0x01, 0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01,
        ]);
      case CMD.PrinterStatusData:
        return buildPacket(REPLY.In_PrinterStatusData, [
          0x00, 0x00, 0x60, 0x00, 0x00, 0x00,
        ]);
      case CMD.RfidInfo2:
        // No tag — empty payload. Strategy treats this as "no detected
        // media" and falls back to the operator-picked entry.
        return buildPacket(REPLY.In_RfidInfo2, [0x00]);
      case CMD.SetDensity:
        return buildPacket(REPLY.In_SetDensity, [0x01]);
      case CMD.SetLabelType:
        return buildPacket(REPLY.In_SetLabelType, [0x01]);
      case CMD.PrintStart:
        return buildPacket(REPLY.In_PrintStart, [0x01]);
      case CMD.PageStart:
        return buildPacket(REPLY.In_PageStart, [0x01]);
      case CMD.SetPageSize:
        return buildPacket(REPLY.In_SetPageSize, [0x01, 0x00]);
      case CMD.PageEnd:
        return buildPacket(REPLY.In_PageEnd, [0x01]);
      case CMD.PrintStatus:
        // Completion shape: pages_printed=255 (≥ any copies count),
        // progress=100. The b1 strategy's check fires on the first
        // poll and returns clean.
        return buildPacket(REPLY.In_PrintStatus, [
          0x00, 0xff, 0x64, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ]);
      case CMD.PrintEnd:
        return buildPacket(REPLY.In_PrintEnd, [0x01]);
      default:
        // Row-stream opcodes (0x83/0x84/0x85) and anything else —
        // no reply on the real wire, no queued reply here.
        return undefined;
    }
  }
}
