import { describe, expect, it } from 'vitest';
import { DEVICES, MEDIA } from '@thermal-label/labelwriter-core';
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

  it('produces a wire bitmap that is shorter than the authored canvas (LW chassis leading skip)', () => {
    // Bench-confirmed model 2026-05-08: every LW 3xx/4xx/5xx engine
    // ships `printableArea.leading: 6 mm`. The wire bitmap MUST drop
    // `leadingDots` rows from the top of the authored bitmap —
    // otherwise the head fires content past the trailing edge of the
    // label.
    //
    // The diagnostic encoder lays content WITHIN the printable region
    // of a full-label authored canvas (top `leadingDots` rows blank
    // by construction), so the wire-skip removes only blank rows. No
    // content is lost; the printer fires content rows at the first
    // reachable label row and lands inside the printable region.
    //
    // The actual label feed pitch (= authored.heightPx) is passed
    // separately to the encoder via `options.labelLengthDots`, so
    // form-feed/cut sequencing uses the true pitch, not the wire
    // bitmap height.
    const result = buildDiagnosticBitmap({
      device: DEVICES.LW_330_TURBO,
      media: MEDIA.ADDRESS_LARGE,
      harnessVersion: '0.0.0',
      driverVersion: '0.0.0',
    });

    const expectedSkip = Math.round((6 * 300) / 25.4);
    expect(result.wire.heightPx).toBe(result.authored.heightPx - expectedSkip);
    expect(result.printableArea).toEqual({ leading: 6, trailing: 0, left: 0, right: 0 });

    // Top `leadingDots` rows of the authored bitmap are blank by
    // construction — the diagnostic content stack was sized to fit
    // within the printable region and pasted at offset (leadingDots,
    // leftDots), so the dead-zone area carries no ink.
    const leadingDots = expectedSkip;
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

  it('exposes the resolved printable area / forced trailing feed back to the caller', () => {
    // The caller uses these to render preview overlays. Engine
    // defaults from the registry — no operator override layer.
    const result = buildDiagnosticBitmap({
      device: DEVICES.LW_330_TURBO,
      media: MEDIA.ADDRESS_LARGE,
      harnessVersion: '0.0.0',
      driverVersion: '0.0.0',
    });
    expect(result.printableArea.leading).toBe(6);
    // LW family uses variable form-feed for trailing — no
    // `forcedTrailingFeedMm` populated.
    expect(result.forcedTrailingFeedMm).toBe(0);
  });
});
