/**
 * Marklife diagnostic-image builder for the browser harness.
 *
 * The canvas is derived from the **selected media**, not from the head
 * alone. An earlier version pinned the width to `headDots` and never
 * passed a height, so the preview was identical for every roll — the
 * operator could switch from 12 mm narrow tape to an 80 mm label and
 * see no change, which makes the preview worse than useless on a
 * family whose chassis span 12 mm to 100 mm stock.
 *
 * Width is the narrower of the loaded stock and the head: the head
 * cannot address pins past `headDots`, and printing wider than the
 * label puts ink on the platen.
 *
 * Height is the label length for die-cut stock, and left unset for
 * continuous — the shared builder then substitutes its continuous
 * feed budget, which is the right behaviour when there is no page
 * boundary to respect.
 *
 * No cutter-offset ladder — this family has no auto-cut, so there is
 * no head-to-blade offset to probe.
 *
 * Returns RGBA so the driver's own threshold and raster pipeline runs
 * end to end. The harness is a fidelity test, not a bypass.
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

/** Guards a malformed registry edit; the narrowest head in the family. */
const HEAD_DOTS_FALLBACK = 96;
/** Used when an engine somehow declares no dpi. Whole family is 203. */
const DPI_FALLBACK = 203;

const mmToDots = (mm: number, dpi: number): number => Math.round((mm * dpi) / 25.4);

export function buildDiagnosticImage(input: DiagnosticPrintInput): RawImageData {
  const engine = input.device.engines[0];
  const headDots = engine?.headDots ?? HEAD_DOTS_FALLBACK;
  const dpi = engine?.dpi ?? DPI_FALLBACK;
  const { media } = input;

  // Clamp to the head: a 50 mm roll in a 12 mm chassis still only has
  // 12 mm of pins behind it.
  const mediaDots = mmToDots(media.widthMm, dpi);
  const widthDots = Math.max(8, Math.min(mediaDots, headDots));

  // Die-cut stock has a page boundary; continuous does not, and the
  // shared builder's own feed budget is the right answer there.
  const heightDots =
    media.type === 'continuous' || media.heightMm === undefined
      ? undefined
      : Math.max(8, mmToDots(media.heightMm, dpi));

  return buildShared({
    widthDots,
    ...(heightDots === undefined ? {} : { heightDots }),
    harnessVersion: input.harnessVersion,
    driverVersion: input.driverVersion,
    driverKey: 'marklife',
    deviceKey: input.device.key,
    mediaId: String(media.id),
  });
}
