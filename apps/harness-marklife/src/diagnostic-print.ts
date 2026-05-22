/**
 * Marklife diagnostic-image builder for the browser harness.
 *
 * The P12 is single-engine, narrow-tape (continuous 15 mm stock,
 * ~100 printable dots @ 203 dpi on the 0.5" head). The shared
 * `buildDiagnosticImage` in harness-core drives the layout — header,
 * orientation markers, edge probes, sample text, diagonal fill — and
 * its priority-drop pass trims the verbose sections automatically
 * for so narrow a head.
 *
 * No cutter-offset ladder — the marklife family has no auto-cut, so
 * there is no head-to-blade offset to probe. The P12 prints on
 * continuous stock, so `heightDots` is left unset and the shared
 * builder substitutes its continuous-stock feed budget (no per-page
 * boundary to respect).
 *
 * Returns RGBA so the driver's threshold + L11 raster pipeline runs
 * end-to-end. The harness is a fidelity test, not a bypass.
 */
import type { RawImageData } from '@thermal-label/contracts';
import type { MarklifeDevice, MarklifeMedia } from '@thermal-label/marklife-core';
import { buildDiagnosticImage as buildShared } from '@thermal-label/harness-core/shared';

export interface DiagnosticPrintInput {
  device: MarklifeDevice;
  media: MarklifeMedia;
  harnessVersion: string;
  driverVersion: string;
}

/**
 * `headDots` for the P12. The registry declares `headDots: 100` on
 * the single engine (a best-guess for the 0.5" narrow-tape class,
 * flagged TODO until an on-the-wire capture confirms it). The 100-dot
 * fallback guards against a malformed registry edit.
 */
const HEAD_DOTS_FALLBACK = 100;

export function buildDiagnosticImage(input: DiagnosticPrintInput): RawImageData {
  const engine = input.device.engines[0];
  // P12 engine declares `headDots: 100` and `dpi: 203` — fall back
  // defensively so a future registry edit doesn't crash.
  const headDots = engine?.headDots ?? HEAD_DOTS_FALLBACK;
  // The marklife media descriptor carries no `printableDots`
  // (continuous stock has no fixed printable-dot count), so the
  // head-dot count is the head-perpendicular width. The L11 encoder
  // pads the bitmap up to the next byte boundary itself.
  const widthDots = headDots;
  return buildShared({
    widthDots,
    // Continuous stock — omit `heightDots` so the shared builder
    // uses its continuous-stock feed default. No per-page boundary
    // to respect on a 15 mm continuous roll.
    harnessVersion: input.harnessVersion,
    driverVersion: input.driverVersion,
    driverKey: 'marklife',
    deviceKey: input.device.key,
    mediaId: String(input.media.id),
  });
}
