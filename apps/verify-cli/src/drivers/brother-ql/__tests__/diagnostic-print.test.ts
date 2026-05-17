import { describe, expect, it } from 'vitest';
import { DEVICES, MEDIA } from '@thermal-label/brother-ql-core';
import { buildDiagnosticBitmap, encodeBitmap } from '../diagnostic-print.js';

const device = DEVICES.QL_820NWBc;
function media(id: number): NonNullable<(typeof MEDIA)[number]> {
  const m = MEDIA[id];
  if (!m) throw new Error(`Test fixture missing media id ${id.toString()}`);
  return m;
}
const MONO_62MM = media(259); // DK-22205
const TWO_COLOR_62MM = media(251); // DK-22251
const DIE_CUT_29X90 = media(271); // DK-11201

describe('brother-ql diagnostic-print encoder', () => {
  it('builds a bitmap whose width matches the media printableDots', () => {
    const { black, red } = buildDiagnosticBitmap({
      device,
      media: MONO_62MM,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.0',
    });
    expect(black.widthPx).toBe(696); // 62 mm DK printableDots
    expect(black.heightPx).toBeGreaterThan(50);
    expect(red).toBeUndefined();
  });

  it('narrower DK media uses a narrower head-aligned bitmap', () => {
    const { black } = buildDiagnosticBitmap({
      device,
      media: DIE_CUT_29X90,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.0',
    });
    expect(black.widthPx).toBe(306); // DK-11201 printableDots
  });

  it('two-color media produces a matching red plane', () => {
    const { black, red } = buildDiagnosticBitmap({
      device,
      media: TWO_COLOR_62MM,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.0',
    });
    expect(red).toBeDefined();
    expect(red?.widthPx).toBe(black.widthPx);
    expect(red?.heightPx).toBe(black.heightPx);
  });

  it('encodes mono media to a non-empty wire stream', () => {
    const bitmaps = buildDiagnosticBitmap({
      device,
      media: MONO_62MM,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.0',
    });
    const bytes = encodeBitmap(bitmaps, device, MONO_62MM);
    // QL job preamble per brother-ql-core protocol.ts: raster-mode +
    // invalidate (200×2 = 400 bytes for two-color-capable engine) +
    // initialize. The first byte of raster-mode is 0x1B.
    expect(bytes.length).toBeGreaterThan(1000);
    expect(bytes[0]).toBe(0x1b);
  });

  it('two-color rendering emits both black and red raster opcodes (0x77)', () => {
    const bitmaps = buildDiagnosticBitmap({
      device,
      media: TWO_COLOR_62MM,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.0',
    });
    const bytes = encodeBitmap(bitmaps, device, TWO_COLOR_62MM);
    // Two-color raster rows use opcode 0x77 (black: 0x77 0x01, red:
    // 0x77 0x02). Mono rows would use 0x67 0x00. Confirm both colour
    // codes appear in the stream.
    let foundBlack = false;
    let foundRed = false;
    for (let i = 0; i < bytes.length - 1; i += 1) {
      if (bytes[i] === 0x77) {
        if (bytes[i + 1] === 0x01) foundBlack = true;
        if (bytes[i + 1] === 0x02) foundRed = true;
      }
    }
    expect(foundBlack, 'expected at least one two-color black raster row').toBe(true);
    expect(foundRed, 'expected at least one two-color red raster row').toBe(true);
  });

  it('two-color encode produces strictly more bytes than mono at the same dimensions', () => {
    // Both DK-22205 (mono) and DK-22251 (two-color) are 62 mm continuous
    // with printableDots = 696. Two-color writes both planes per row →
    // larger byte stream. The diagnostic-print bitmaps differ in shape
    // (mono puts headers in black; two-color puts them in red), but the
    // total row count is similar. We assert the two-color byte count is
    // measurably larger to confirm the encoder is actually emitting the
    // red plane and not silently dropping it.
    const monoBytes = encodeBitmap(
      buildDiagnosticBitmap({
        device,
        media: MONO_62MM,
        harnessVersion: '0.0.0',
        driverVersion: '0.5.0',
      }),
      device,
      MONO_62MM,
    );
    const twoColorBytes = encodeBitmap(
      buildDiagnosticBitmap({
        device,
        media: TWO_COLOR_62MM,
        harnessVersion: '0.0.0',
        driverVersion: '0.5.0',
      }),
      device,
      TWO_COLOR_62MM,
    );
    expect(twoColorBytes.length).toBeGreaterThan(monoBytes.length);
  });

  it('rejects PT-only media (no printableDots) with a useful message', () => {
    // PT engines fill `geometry.narrow` / `geometry.wide` instead of
    // the flat printableDots field. The encoder is QL-only today.
    const ptMedia = media(404); // 12 mm TZe
    expect(() =>
      buildDiagnosticBitmap({
        device,
        media: ptMedia,
        harnessVersion: '0.0.0',
        driverVersion: '0.5.0',
      }),
    ).toThrowError(/no printableDots/);
  });
});
