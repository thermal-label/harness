/**
 * Multi-engine dispatch tests.
 *
 * Twin Turbo (in-band roll-select via `ESC q <addr>`) and Duo (per-
 * engine USB-interface routing + `d1-tape` protocol on the tape side)
 * are the two multi-engine LabelWriter chassis types covered today.
 *
 * The dispatch helper picks the right encoder pair per
 * `engine.protocol`, prepends the Twin roll-select prefix when the
 * engine carries `bind.address`, and accepts both LW paper media and
 * D1 tape media without the call site having to switch on protocol.
 */
import { describe, expect, it } from 'vitest';
import { DEVICES, MEDIA } from '@thermal-label/labelwriter-core';
import { dispatchEncoder, roleSelectPrefix } from '../multi-engine.js';

const HARNESS_VERSION = '0.0.0';
const DRIVER_VERSION = '0.0.0';

describe('roleSelectPrefix', () => {
  it("Twin left engine returns ESC q 0x31 ('1')", () => {
    const left = DEVICES.LW_TWIN_TURBO.engines.find(e => e.role === 'left')!;
    const prefix = roleSelectPrefix(left)!;
    expect(Array.from(prefix)).toEqual([0x1b, 0x71, 0x31]);
  });

  it("Twin right engine returns ESC q 0x32 ('2')", () => {
    const right = DEVICES.LW_TWIN_TURBO.engines.find(e => e.role === 'right')!;
    const prefix = roleSelectPrefix(right)!;
    expect(Array.from(prefix)).toEqual([0x1b, 0x71, 0x32]);
  });

  it('Duo label engine returns null (interface-routed, no in-band address)', () => {
    const label = DEVICES.LW_450_DUO.engines.find(e => e.role === 'label')!;
    expect(roleSelectPrefix(label)).toBeNull();
  });

  it('Duo tape engine returns null (interface-routed)', () => {
    const tape = DEVICES.LW_450_DUO.engines.find(e => e.role === 'tape')!;
    expect(roleSelectPrefix(tape)).toBeNull();
  });

  it('single-engine device returns null', () => {
    const primary = DEVICES.LW_330_TURBO.engines[0]!;
    expect(roleSelectPrefix(primary)).toBeNull();
  });
});

describe('dispatchEncoder', () => {
  it('label engine on a single-engine device produces lw-450 wire bytes (no ESC q)', () => {
    const device = DEVICES.LW_330_TURBO;
    const dispatched = dispatchEncoder({
      device,
      engine: device.engines[0]!,
      media: MEDIA.ADDRESS_STANDARD,
      harnessVersion: HARNESS_VERSION,
      driverVersion: DRIVER_VERSION,
    });
    const result = dispatched.buildBitmap();
    const bytes = dispatched.encodeBitmap(result.wire, result.authored.heightPx);
    expect(bytes.length).toBeGreaterThan(0);
    // No `ESC q` (0x1b 0x71) on a single-engine device.
    const escQ = findByteSequence(bytes, [0x1b, 0x71]);
    expect(escQ).toBe(-1);
  });

  it('Twin right engine prepends ESC q 0x32 to the wire stream', () => {
    const device = DEVICES.LW_TWIN_TURBO;
    const right = device.engines.find(e => e.role === 'right')!;
    const dispatched = dispatchEncoder({
      device,
      engine: right,
      media: MEDIA.ADDRESS_STANDARD,
      harnessVersion: HARNESS_VERSION,
      driverVersion: DRIVER_VERSION,
    });
    const result = dispatched.buildBitmap();
    const bytes = dispatched.encodeBitmap(result.wire, result.authored.heightPx);
    // First three bytes are the roll-select prefix.
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x71);
    expect(bytes[2]).toBe(0x32);
  });

  it('Twin left engine prepends ESC q 0x31', () => {
    const device = DEVICES.LW_TWIN_TURBO;
    const left = device.engines.find(e => e.role === 'left')!;
    const dispatched = dispatchEncoder({
      device,
      engine: left,
      media: MEDIA.ADDRESS_STANDARD,
      harnessVersion: HARNESS_VERSION,
      driverVersion: DRIVER_VERSION,
    });
    const bytes = dispatched.encodeBitmap(
      dispatched.buildBitmap().wire,
      dispatched.buildBitmap().authored.heightPx,
    );
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x71);
    expect(bytes[2]).toBe(0x31);
  });

  it('Duo tape engine builds a D1-shape bitmap padded centred to engine.headDots', () => {
    const device = DEVICES.LW_450_DUO;
    const tape = device.engines.find(e => e.role === 'tape')!;
    const tapeMedia = MEDIA.STANDARD_BLACK_ON_WHITE_12;
    const dispatched = dispatchEncoder({
      device,
      engine: tape,
      media: tapeMedia,
      harnessVersion: HARNESS_VERSION,
      driverVersion: DRIVER_VERSION,
    });
    const result = dispatched.buildBitmap();
    // 128-dot Duo head; PoC tape-band centring pads the LM-authored
    // 64-dot bitmap to engine.headDots so the d1-core encoder's
    // scaleBitmap is a no-op (no stretching). Authored stays the
    // real visual size (~64 dots of content), centred in 128.
    expect(result.authored.widthPx).toBe(128);
    expect(result.wire.widthPx).toBe(128);
  });

  it('Duo tape engine emits D1 wire bytes (ESC C tape-type, ESC D bytes-per-line)', () => {
    const device = DEVICES.LW_450_DUO;
    const tape = device.engines.find(e => e.role === 'tape')!;
    const tapeMedia = MEDIA.STANDARD_BLACK_ON_WHITE_12;
    const dispatched = dispatchEncoder({
      device,
      engine: tape,
      media: tapeMedia,
      harnessVersion: HARNESS_VERSION,
      driverVersion: DRIVER_VERSION,
    });
    const result = dispatched.buildBitmap();
    const bytes = dispatched.encodeBitmap(result.wire);
    // D1 stream starts with `ESC C n` (tape-type / palette).
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x43);
    // And contains an `ESC D <bpr>` bytes-per-line directive.
    expect(findByteSequence(bytes, [0x1b, 0x44])).toBeGreaterThanOrEqual(0);
    // No `ESC q` on the Duo's tape path (interface-routed, not in-band).
    expect(findByteSequence(bytes, [0x1b, 0x71])).toBe(-1);
  });

  it('rejects non-tape media on a d1-tape engine', () => {
    const device = DEVICES.LW_450_DUO;
    const tape = device.engines.find(e => e.role === 'tape')!;
    expect(() =>
      dispatchEncoder({
        device,
        engine: tape,
        // ADDRESS_STANDARD is a die-cut paper label, not a tape cassette.
        media: MEDIA.ADDRESS_STANDARD,
        harnessVersion: HARNESS_VERSION,
        driverVersion: DRIVER_VERSION,
      }).buildBitmap(),
    ).toThrow(/d1-tape but the selected media is not a tape/);
  });
});

function findByteSequence(haystack: Uint8Array, needle: readonly number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
