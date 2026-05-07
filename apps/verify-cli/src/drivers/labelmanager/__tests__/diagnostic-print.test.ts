import { describe, expect, it } from 'vitest';
import { DEVICES } from '@thermal-label/labelmanager-core';
import { buildDiagnosticBitmap, encodeBitmap } from '../diagnostic-print.js';

describe('labelmanager diagnostic-print encoder', () => {
  const device = DEVICES.LM_PNP;

  it('builds a bitmap whose width matches the head-dot count for the chosen tape', () => {
    const bitmap = buildDiagnosticBitmap({
      device,
      tapeWidth: 12,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.1',
    });
    // 12 mm tape on labelmanager → 64-dot head emission per protocol.ts.
    expect(bitmap.widthPx).toBe(64);
    expect(bitmap.heightPx).toBeGreaterThan(50);
  });

  it('narrower tapes use a narrower head-aligned bitmap', () => {
    const six = buildDiagnosticBitmap({
      device,
      tapeWidth: 6,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.1',
    });
    expect(six.widthPx).toBe(32);
  });

  it('encodes to a non-empty wire stream with the expected header', () => {
    const bitmap = buildDiagnosticBitmap({
      device,
      tapeWidth: 12,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.1',
    });
    const bytes = encodeBitmap(bitmap, 12);
    // ESC C 0  ESC D 8 — opening sequence from buildPrinterStream for a
    // 64-dot head (8 bytes per line).
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x43);
    expect(bytes[2]).toBe(0x00);
    expect(bytes[3]).toBe(0x1b);
    expect(bytes[4]).toBe(0x44);
    expect(bytes[5]).toBe(8);
    expect(bytes.length).toBeGreaterThan(1000);
  });
});
