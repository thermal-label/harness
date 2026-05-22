/**
 * Marklife 1bpp diagnostic-print encoder — verify-cli-internal.
 *
 * Mirrors the labelmanager sibling: one comprehensive head-aligned
 * print — header / orientation markers / edge probes / sample text /
 * density fill — authored at the chassis head-dot width and handed to
 * the marklife-core encoder via `encodeJobForEngine`.
 *
 * P12-class chassis are narrow: the 0.5" head is ~100 dots
 * (`headDots` in the registry, flagged best-guess until a datasheet
 * confirms it). Strings are kept short so they don't clip the right
 * edge of so narrow a head.
 *
 * No cutter probe — the marklife family has no auto-cut. No
 * leading/trailing dead-zone pad either: the YXQ encoder emits its own
 * `ESC J` feed past the print head, so the harness authors visible
 * content only and lets the driver-core encoder wrap the job.
 *
 * Bitmap orientation: `widthPx` is the head-perpendicular dimension
 * (across the tape); `heightPx` is the feed direction. The print runs
 * head-aligned with no rotation — same convention as the labelmanager
 * diagnostic.
 */
import {
  createBitmap,
  padBitmap,
  renderText,
  stackBitmaps,
  type LabelBitmap,
} from '@mbtech-nl/bitmap';
import {
  encodeJobForEngine,
  isEngineDrivable,
  type MarklifeDevice,
  type MarklifeEngine,
  type MarklifeMedia,
} from '@thermal-label/marklife-core';
import { cropToWidth, diagonalStripes, edgeProbeSection } from '@thermal-label/harness-core/shared';

export interface DiagnosticPrintInput {
  device: MarklifeDevice;
  media: MarklifeMedia;
  harnessVersion: string;
  driverVersion: string;
}

const ROW_GAP_PX = 4;
const FILL_HEIGHT_PX = 24;

/**
 * `headDots` for the chosen chassis. Every marklife entry carries one;
 * the 100-dot fallback matches the 0.5" narrow-tape class (P12) and is
 * only a guard against a malformed registry entry.
 */
function resolveHeadDots(device: MarklifeDevice): number {
  return device.engines[0]?.headDots ?? 100;
}

/**
 * Build the head-aligned diagnostic bitmap. Width matches the head dot
 * count; height grows as sections stack.
 */
export function buildDiagnosticBitmap(input: DiagnosticPrintInput): LabelBitmap {
  const headDots = resolveHeadDots(input.device);
  const sections: LabelBitmap[] = [];

  // 1. Header — harness version + model key, 1x. Short strings so they
  //    fit the narrow 0.5" head without right-edge clipping.
  sections.push(textSection(`v${input.harnessVersion}`, headDots, 1));
  sections.push(textSection(input.device.key, headDots, 1));

  // 2. Asymmetric orientation marker — top.
  sections.push(textSection('TOP>', headDots, 1));

  // 3. Edge probes. Bars step outward from each head edge; the first
  //    row whose bar didn't print reveals the printable margin.
  sections.push(edgeProbeSection(headDots, 'left'));
  sections.push(edgeProbeSection(headDots, 'right'));

  // 4. Sample text at 1x and 2x for a legibility eyeball at both
  //    scales.
  sections.push(textSection('TXT 1X', headDots, 1));
  sections.push(textSection('2X', headDots, 2));

  // 5. Fill region — diagonal stripes for density uniformity.
  sections.push(diagonalStripes(headDots, FILL_HEIGHT_PX));

  // 6. Bottom orientation marker — different glyph from `TOP>`.
  sections.push(textSection('B', headDots, 1));

  // Stitch with a small white gap between sections; drop the trailing
  // gap so the print ends on the last section (the encoder appends its
  // own `ESC J` feed).
  const gapped: LabelBitmap[] = [];
  for (const section of sections) {
    gapped.push(section);
    gapped.push(createBitmap(headDots, ROW_GAP_PX));
  }
  gapped.pop();

  return stackBitmaps(gapped, 'vertical');
}

/**
 * Encode an already-built bitmap into marklife wire bytes for the
 * device's single engine (`encodeJobForEngine` routes on
 * `engine.protocol` — `marklife-yxq` for the P12).
 *
 * Split from `buildDiagnosticBitmap` so the orchestrator can preview
 * the bitmap before committing bytes to the wire.
 */
export function encodeBitmap(
  bitmap: LabelBitmap,
  engine: MarklifeEngine,
  media: MarklifeMedia,
): Uint8Array {
  if (!isEngineDrivable(engine)) {
    throw new Error(
      `marklife engine protocol "${engine.protocol}" has no encoder in this build ` +
        `(see marklife DECISIONS.md). This chassis cannot be diagnostic-printed yet.`,
    );
  }
  // The YXQ encoder packs `widthBytes = ceil(widthPx / 8)`; pad the
  // right edge up to the next multiple of 8 dots so the trailing bits
  // of the last byte are guaranteed white and produce no edge artefact.
  const slack = (8 - (bitmap.widthPx % 8)) % 8;
  const padded = slack > 0 ? padBitmap(bitmap, { right: slack }) : bitmap;
  return encodeJobForEngine(engine, { bitmap: padded, media });
}

/**
 * Render a short text string into a head-width-bounded bitmap. Lines
 * wider than the head are cropped on the right rather than throwing —
 * a truncated diagnostic label is more useful than a hard failure.
 */
function textSection(text: string, headDots: number, scale: number): LabelBitmap {
  const rendered = renderText(text, { scaleX: scale, scaleY: scale });
  if (rendered.widthPx <= headDots) {
    return padBitmap(rendered, { right: headDots - rendered.widthPx });
  }
  return cropToWidth(rendered, headDots);
}
