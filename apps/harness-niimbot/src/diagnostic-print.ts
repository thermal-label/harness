/**
 * Niimbot diagnostic-image builder for the browser harness.
 *
 * Niimbot is a multi-engine driver family — head widths range from
 * 96 dots (D11/D110, 12 mm) to 591 dots (B21 Pro, 80 mm) at 203 dpi.
 * Per-print width is `min(engine.headDots, media.printableDots ?? Inf)`,
 * with a sensible default when the media descriptor doesn't carry
 * `printableDots` (most niimbot media is sized in mm, not dots).
 *
 * The shared `buildDiagnosticImage` in harness-core sizes the layout
 * with a priority pipeline: it drops the lowest-priority sections
 * (verbose header line, scale-3 sample, right edge probe) when the
 * feed budget can't hold them, so a D11 (96 dots) short-label print
 * keeps fewer sections automatically while a B1 (384 dots) at a
 * generous budget gets the full layout.
 *
 * Returns RGBA so the driver's threshold + chunking pipeline runs
 * end-to-end. The harness is a fidelity test, not a bypass.
 */
import type { RawImageData } from '@thermal-label/contracts';
import type { NiimbotDevice, NiimbotMedia } from '@thermal-label/niimbot-core';
import { buildDiagnosticImage as buildShared } from '@thermal-label/harness-core/shared';

export interface DiagnosticPrintInput {
  device: NiimbotDevice;
  media: NiimbotMedia;
  harnessVersion: string;
  driverVersion: string;
}

const DPI_DEFAULT = 203;

export function buildDiagnosticImage(input: DiagnosticPrintInput): RawImageData {
  const engine = input.device.engines[0];
  const dpi = engine?.dpi ?? DPI_DEFAULT;
  const headDots = engine?.headDots ?? 384;
  // Niimbot media is mm-typed; convert width to dots and clamp to head.
  const widthDotsFromMm = Math.round((input.media.widthMm * dpi) / 25.4);
  const widthDots = Math.min(headDots, widthDotsFromMm);
  // Die-cut media has a real per-label feed budget (`media.heightMm`)
  // that harness-core honours as a strict ceiling — dropping
  // lower-priority sections so a short 50×30 sticker doesn't print
  // across two labels. Continuous niimbot rolls have no per-page
  // boundary, so we omit `heightDots` entirely and let harness-core
  // fall back to its continuous-stock default budget.
  const heightDots =
    input.media.type === 'die-cut' && input.media.heightMm !== undefined
      ? Math.round((input.media.heightMm * dpi) / 25.4)
      : undefined;
  return buildShared({
    widthDots,
    // exactOptionalPropertyTypes: omit `heightDots` rather than set it
    // to undefined when the media is continuous.
    ...(heightDots !== undefined ? { heightDots } : {}),
    harnessVersion: input.harnessVersion,
    driverVersion: input.driverVersion,
    driverKey: 'niimbot',
    deviceKey: input.device.key,
    mediaId: String(input.media.id),
  });
}
