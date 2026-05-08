import { describe, expect, it } from 'vitest';
import { DEVICES, MEDIA } from '@thermal-label/labelwriter-core';
import { bitmapEquals } from '@mbtech-nl/bitmap';
import { buildDiagnosticBitmap, encodeBitmap } from '../diagnostic-print.js';

describe('labelwriter diagnostic-print encoder', () => {
  it('builds an authored bitmap whose width matches the LOADED LABEL, not the full head', () => {
    const result = buildDiagnosticBitmap({
      device: DEVICES.LW_330_TURBO,
      media: MEDIA.ADDRESS_STANDARD,
      harnessVersion: '0.0.0',
      driverVersion: '0.0.0',
    });
    // ADDRESS_STANDARD is 28 mm wide × 300 dpi / 25.4 ≈ 331 dots.
    // LW 330 Turbo head is 672 dots — using the full head width on a
    // 28 mm label prints ~2× the expected width.
    expect(result.authored.widthPx).toBe(Math.round((28 * 300) / 25.4));
    expect(result.authored.widthPx).toBeLessThan(672);
    expect(result.authored.heightPx).toBeGreaterThan(50);
  });

  it('caps authored bitmap width at the head when the media overstates', () => {
    // Synthetic edge case: if a media entry claims a width wider than
    // the head, the bitmap should clamp to the head's actual dot count.
    const result = buildDiagnosticBitmap({
      device: DEVICES.LW_330_TURBO,
      // SHIPPING_LARGE is 59 mm wide → 697 dots, which exceeds the
      // 672-dot head. Bitmap should clamp to 672.
      media: MEDIA.SHIPPING_LARGE,
      harnessVersion: '0.0.0',
      driverVersion: '0.0.0',
    });
    expect(result.authored.widthPx).toBeLessThanOrEqual(672);
  });

  it('respects the smaller media height when the diagnostic content overflows', () => {
    // Return-address (19×51 mm) caps height at lengthDots=602; the
    // diagnostic should crop rather than overflow.
    const result = buildDiagnosticBitmap({
      device: DEVICES.LW_330_TURBO,
      media: MEDIA.RETURN_ADDRESS,
      harnessVersion: '0.0.0',
      driverVersion: '0.0.0',
    });
    expect(result.authored.heightPx).toBeLessThanOrEqual(602);
  });

  it('encodes to a non-empty wire stream that begins with ESC @ (reset)', () => {
    const result = buildDiagnosticBitmap({
      device: DEVICES.LW_330_TURBO,
      media: MEDIA.ADDRESS_STANDARD,
      harnessVersion: '0.0.0',
      driverVersion: '0.0.0',
    });
    const bytes = encodeBitmap(result.wire, DEVICES.LW_330_TURBO);
    // labelwriter-core's encodeLabel emits buildReset() = 0x1B 0x40 first
    // for the lw-450 family.
    expect(bytes[0]).toBe(0x1b);
    expect(bytes[1]).toBe(0x40);
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it('returns wire === authored byte-for-byte when no override is supplied (phase-1 invariant)', () => {
    // Phase 1 default: no engine carries `printableArea` /
    // `forcedTrailingFeedMm` values yet, and no override is passed.
    // The wire bitmap must match the authored bitmap exactly so the
    // wire stream stays byte-identical to today's output.
    const result = buildDiagnosticBitmap({
      device: DEVICES.LW_330_TURBO,
      media: MEDIA.ADDRESS_STANDARD,
      harnessVersion: '0.0.0',
      driverVersion: '0.0.0',
    });
    expect(bitmapEquals(result.wire, result.authored)).toBe(true);
    expect(result.printableArea).toEqual({ leading: 0, trailing: 0, left: 0, right: 0 });
    expect(result.forcedTrailingFeedMm).toBe(0);
  });

  it('returns wire === authored byte-for-byte when the override is all zeros', () => {
    // An override that explicitly sets every field to 0 must still
    // hit the byte-identical fast path — operators who clear the
    // override fields back to 0 should not see a different stream.
    const result = buildDiagnosticBitmap({
      device: DEVICES.LW_330_TURBO,
      media: MEDIA.ADDRESS_STANDARD,
      harnessVersion: '0.0.0',
      driverVersion: '0.0.0',
      override: {
        leadingMm: 0,
        trailingMm: 0,
        leftMm: 0,
        rightMm: 0,
        forcedTrailingFeedMm: 0,
      },
    });
    expect(bitmapEquals(result.wire, result.authored)).toBe(true);
  });

  it('produces a wire bitmap that is shorter and head-sized when leading/trailing overrides are populated', () => {
    // Bench observation 2026-05-08: the LW family pulls the label
    // back before each print so the head sits at label-row 0 — the
    // earlier "send fewer rows" mechanism was wrong for LW. Wire IS
    // the authored bitmap; content layout (within the printable
    // region of a full-label canvas) handles the dead-zone bands.
    const result = buildDiagnosticBitmap({
      device: DEVICES.LW_330_TURBO,
      media: MEDIA.ADDRESS_LARGE,
      harnessVersion: '0.0.0',
      driverVersion: '0.0.0',
      override: { leadingMm: 6, trailingMm: 4 },
    });

    expect(result.wire).toBe(result.authored);
    expect(result.wire.heightPx).toBe(result.authored.heightPx);
    expect(result.printableArea).toEqual({ leading: 6, trailing: 4, left: 0, right: 0 });

    // Top `leadingDots` rows of the authored bitmap are blank by
    // construction — the diagnostic content stack was sized to fit
    // within the printable region and pasted at offset (leadingDots,
    // leftDots), so the dead-zone area carries no ink.
    const leadingDots = Math.round((6 * 300) / 25.4);
    const bpr = Math.ceil(result.authored.widthPx / 8);
    let leadingHasInk = false;
    for (let y = 0; y < leadingDots; y += 1) {
      for (let x = 0; x < bpr; x += 1) {
        if (result.authored.data[y * bpr + x] !== 0) {
          leadingHasInk = true;
          break;
        }
      }
      if (leadingHasInk) break;
    }
    expect(leadingHasInk).toBe(false);
  });

  it('keeps wire and authored identical for the forced-trailing-feed case (LW)', () => {
    // forcedTrailingFeedMm is informational on LW today (variable
    // form-feed handles the trailing-edge advance). The encoder
    // doesn't append rows for it; the value rides on the result so
    // the harness preview can render the strip-overlay extension and
    // the report can carry the operator's calibration intent.
    const result = buildDiagnosticBitmap({
      device: DEVICES.LW_330_TURBO,
      media: MEDIA.ADDRESS_LARGE,
      harnessVersion: '0.0.0',
      driverVersion: '0.0.0',
      override: { leadingMm: 6, trailingMm: 4, forcedTrailingFeedMm: 8 },
    });

    expect(result.wire).toBe(result.authored);
    expect(result.forcedTrailingFeedMm).toBe(8);
  });

  it('exposes the resolved printable area / forced trailing feed back to the caller', () => {
    // The caller uses these to render preview overlays and report
    // them on the `HardwareReport.transports[].offsetCalibration`
    // field. Make sure the returned values match the override.
    const result = buildDiagnosticBitmap({
      device: DEVICES.LW_330_TURBO,
      media: MEDIA.ADDRESS_LARGE,
      harnessVersion: '0.0.0',
      driverVersion: '0.0.0',
      override: { leadingMm: 5.5, trailingMm: 3.2, leftMm: 1, rightMm: 0, forcedTrailingFeedMm: 0 },
    });
    expect(result.printableArea).toEqual({ leading: 5.5, trailing: 3.2, left: 1, right: 0 });
  });
});
