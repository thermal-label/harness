import { describe, expect, it } from 'vitest';
import { DEVICES } from '@thermal-label/labelmanager-core';
import { buildDiagnosticBitmap, encodeBitmap } from '../diagnostic-print.js';

describe('labelmanager diagnostic-print encoder', () => {
  const device = DEVICES.LM_PNP;
  const engine = device.engines[0];
  if (!engine) throw new Error('LM_PNP registry entry has no engines — fix devices.generated.ts');

  it('builds an authored bitmap whose width matches the head-dot count for the chosen tape', () => {
    const result = buildDiagnosticBitmap({
      device,
      tapeWidth: 12,
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
      tapeWidth: 6,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.1',
    });
    expect(six.authored.widthPx).toBe(32);
  });

  it('exposes wire === authored (labelmanager pads in the encoder, not the harness)', () => {
    const result = buildDiagnosticBitmap({
      device,
      tapeWidth: 12,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.1',
    });
    expect(result.wire).toBe(result.authored);
  });

  it('exposes the engine-default printable area / forced-trailing-feed back to the caller', () => {
    const result = buildDiagnosticBitmap({
      device,
      tapeWidth: 12,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.1',
    });
    // LM_PNP carries `printableArea: { leading: 8, ... }` and
    // `forcedTrailingFeedMm: 8` on its primary engine post-plan-08
    // phase 2. Verify the harness surfaces those defaults verbatim.
    expect(result.printableArea.leading).toBe(8);
    expect(result.forcedTrailingFeedMm).toBe(8);
  });

  it('overlays per-session overrides on top of the engine defaults', () => {
    const result = buildDiagnosticBitmap({
      device,
      tapeWidth: 12,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.1',
      override: { leadingMm: 4, forcedTrailingFeedMm: 12 },
    });
    expect(result.printableArea.leading).toBe(4);
    // Trailing was not overridden — falls back to engine default.
    expect(result.printableArea.trailing).toBe(0);
    expect(result.forcedTrailingFeedMm).toBe(12);
  });

  it('encodes to a non-empty wire stream with the expected header', () => {
    const result = buildDiagnosticBitmap({
      device,
      tapeWidth: 12,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.1',
    });
    const bytes = encodeBitmap(result.wire, engine, 12);
    // ESC C 0  ESC D 8 — opening sequence from buildPrinterStream
    // for a 64-dot head (8 bytes per line).
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x43);
    expect(bytes[2]).toBe(0x00);
    expect(bytes[3]).toBe(0x1b);
    expect(bytes[4]).toBe(0x44);
    expect(bytes[5]).toBe(8);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('encodeBitmap with override increases the trailing-pad rows over the default', () => {
    const result = buildDiagnosticBitmap({
      device,
      tapeWidth: 12,
      harnessVersion: '0.0.0',
      driverVersion: '0.5.1',
    });
    const baseline = encodeBitmap(result.wire, engine, 12);
    // Bumping `forcedTrailingFeedMm` from 8 → 24 should add ~113 dots
    // of trailing white at 180 dpi: (24-8) * 180 / 25.4 ≈ 113. Each
    // row is `1 (SYN) + 8 (bytes per 64-dot line) = 9` bytes. So we
    // expect ~1017 more bytes.
    const padded = encodeBitmap(result.wire, engine, 12, { forcedTrailingFeedMm: 24 });
    expect(padded.length).toBeGreaterThan(baseline.length);
  });
});
