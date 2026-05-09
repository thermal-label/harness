import { describe, expect, it } from 'vitest';
import { DEVICES, MEDIA, tapeTypeFor } from '@thermal-label/labelmanager-core';
import { buildDiagnosticBitmap, encodeBitmap } from '../diagnostic-print.js';

describe('labelmanager diagnostic-print encoder', () => {
  const device = DEVICES.LM_PNP;
  const engine = device.engines[0];
  if (!engine) throw new Error('LM_PNP registry entry has no engines — fix devices.generated.ts');

  const standard12 = MEDIA['d1-standard-bw-12'];
  const standard6 = MEDIA['d1-standard-bw-6'];
  if (!standard12 || !standard6) {
    throw new Error('media catalogue is missing the canonical 6/12 mm STANDARD entries');
  }

  it('builds an authored bitmap whose width matches the head-dot count for the chosen tape', () => {
    const result = buildDiagnosticBitmap({
      device,
      media: standard12,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.1',
    });
    // 12 mm tape on labelmanager → 64-dot head emission per protocol.ts.
    expect(result.authored.widthPx).toBe(64);
    expect(result.authored.heightPx).toBeGreaterThan(50);
  });

  it('narrower tapes use a narrower head-aligned bitmap', () => {
    const six = buildDiagnosticBitmap({
      device,
      media: standard6,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.1',
    });
    expect(six.authored.widthPx).toBe(32);
  });

  it('exposes wire === authored (labelmanager pads in the encoder, not the harness)', () => {
    const result = buildDiagnosticBitmap({
      device,
      media: standard12,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.1',
    });
    expect(result.wire).toBe(result.authored);
  });

  it('exposes the engine-default printable area / forced-trailing-feed back to the caller', () => {
    const result = buildDiagnosticBitmap({
      device,
      media: standard12,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.1',
    });
    // LM_PNP carries `printableArea: { leading: 0, ... }` and
    // `forcedTrailingFeedMm: 16` (centred-strip semantics — symmetric
    // ~8mm pad each side in steady state). Verify the harness
    // surfaces those defaults verbatim.
    expect(result.printableArea.leading).toBe(0);
    expect(result.forcedTrailingFeedMm).toBe(16);
  });

  it('encodes to a non-empty wire stream with the expected header', () => {
    const result = buildDiagnosticBitmap({
      device,
      media: standard12,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.1',
    });
    const bytes = encodeBitmap(result.wire, engine, standard12);
    // ESC C 0  ESC D 8 — opening sequence from buildPrinterStream
    // for a 64-dot head (8 bytes per line). Black-on-white tapeType
    // is 0; verify against the catalogue mapping so this stays
    // honest if the table ever shifts.
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x43);
    expect(bytes[2]).toBe(tapeTypeFor(standard12));
    expect(bytes[2]).toBe(0);
    expect(bytes[3]).toBe(0x1b);
    expect(bytes[4]).toBe(0x44);
    expect(bytes[5]).toBe(8);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('threads the cartridge colour pair through to ESC C n (non-zero for coloured tape)', () => {
    // Black-on-yellow (12 mm) maps to ESC C 4 per the d1-core
    // tape-type table. Picking a non-zero value proves the encoder
    // reads media, not just the width.
    const yellow = MEDIA['d1-standard-by-12'];
    if (!yellow) throw new Error('media catalogue is missing d1-standard-by-12');
    const result = buildDiagnosticBitmap({
      device,
      media: yellow,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.1',
    });
    const bytes = encodeBitmap(result.wire, engine, yellow);
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x43);
    expect(bytes[2]).toBe(tapeTypeFor(yellow));
    expect(bytes[2]).toBe(4);
  });
});
