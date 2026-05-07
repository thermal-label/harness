import { describe, expect, it } from 'vitest';
import { DEVICES, MEDIA } from '@thermal-label/labelwriter-core';
import { buildDiagnosticBitmap, encodeBitmap } from '../diagnostic-print.js';

describe('labelwriter diagnostic-print encoder', () => {
  it('builds a bitmap whose width matches the LOADED LABEL, not the full head', () => {
    const bitmap = buildDiagnosticBitmap({
      device: DEVICES.LW_330_TURBO,
      media: MEDIA.ADDRESS_STANDARD,
      harnessVersion: '0.0.0',
      driverVersion: '0.0.0',
    });
    // ADDRESS_STANDARD is 28 mm wide × 300 dpi / 25.4 ≈ 331 dots.
    // LW 330 Turbo head is 672 dots — using the full head width on a
    // 28 mm label prints ~2× the expected width.
    expect(bitmap.widthPx).toBe(Math.round((28 * 300) / 25.4));
    expect(bitmap.widthPx).toBeLessThan(672);
    expect(bitmap.heightPx).toBeGreaterThan(50);
  });

  it('caps bitmap width at the head when the media overstates', () => {
    // Synthetic edge case: if a media entry claims a width wider than
    // the head, the bitmap should clamp to the head's actual dot count.
    const bitmap = buildDiagnosticBitmap({
      device: DEVICES.LW_330_TURBO,
      // SHIPPING_LARGE is 59 mm wide → 697 dots, which exceeds the
      // 672-dot head. Bitmap should clamp to 672.
      media: MEDIA.SHIPPING_LARGE,
      harnessVersion: '0.0.0',
      driverVersion: '0.0.0',
    });
    expect(bitmap.widthPx).toBeLessThanOrEqual(672);
  });

  it('respects the smaller media height when the diagnostic content overflows', () => {
    // Return-address (19×51 mm) caps height at lengthDots=602; the
    // diagnostic should crop rather than overflow.
    const bitmap = buildDiagnosticBitmap({
      device: DEVICES.LW_330_TURBO,
      media: MEDIA.RETURN_ADDRESS,
      harnessVersion: '0.0.0',
      driverVersion: '0.0.0',
    });
    expect(bitmap.heightPx).toBeLessThanOrEqual(602);
  });

  it('encodes to a non-empty wire stream that begins with ESC @ (reset)', () => {
    const bitmap = buildDiagnosticBitmap({
      device: DEVICES.LW_330_TURBO,
      media: MEDIA.ADDRESS_STANDARD,
      harnessVersion: '0.0.0',
      driverVersion: '0.0.0',
    });
    const bytes = encodeBitmap(bitmap, DEVICES.LW_330_TURBO);
    // labelwriter-core's encodeLabel emits buildReset() = 0x1B 0x40 first
    // for the lw-450 family.
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x40);
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
