import { describe, expect, it } from 'vitest';
import { DEVICES, MEDIA } from '@thermal-label/labelwriter-core';
import { buildDiagnosticBitmap, encodeBitmap } from '../diagnostic-print.js';

describe('labelwriter diagnostic-print encoder', () => {
  it('builds a bitmap whose width matches the head dot count', () => {
    const bitmap = buildDiagnosticBitmap({
      device: DEVICES.LW_330_TURBO,
      media: MEDIA.ADDRESS_STANDARD,
      harnessVersion: '0.0.0',
      driverVersion: '0.0.0',
    });
    // LW 330 Turbo declares headDots=672 in the registry.
    expect(bitmap.widthPx).toBe(672);
    expect(bitmap.heightPx).toBeGreaterThan(50);
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
