/**
 * Brother-QL diagnostic-print encoder.
 *
 * One comprehensive head-aligned print, mirroring plan 06's §Test pattern
 * convention used by the labelmanager driver:
 *
 *   - Header: harness version + driver-core version + model key.
 *   - Asymmetric orientation marker (top): `TOP>`.
 *   - Edge probes: bars stepping outward from each head edge in 2-dot
 *     increments — first row whose bar didn't print marks the printable
 *     margin in dots.
 *   - Sample text at 1x and 2x for legibility eyeball.
 *   - Fill stripes for density uniformity.
 *   - Cutter-offset probe: a ladder of bars at known dot-distances above
 *     the cut line. QL-series auto-cuts; the first bar visible above the
 *     cut tells the operator the head-to-cutter dead zone in dots.
 *   - Asymmetric orientation marker (bottom): `B`.
 *
 * Two-color rendering (when applicable):
 *   When the supplied media carries a `palette` (DK-22251 / DK-44205
 *   today), the encoder emits a `redBitmap` alongside the black bitmap.
 *   Header text + orientation markers go in the red plane; edge probes,
 *   sample text, fill stripes, and the cutter probe go in black. The
 *   operator can verify two-color works by eyeballing the red header on
 *   the printed tape.
 *
 *   The wire-format support exists today (`brother-ql-core/protocol.ts`
 *   `buildRasterRow` two-color branch + `encodeJobForEngine` auto-creates
 *   an empty red plane for multi-ink media). No driver-core gap; ships in
 *   this MVP.
 *
 * Bitmap orientation contract (from `brother-ql-core/protocol.ts`):
 *   - `bitmap.widthPx` is the head-perpendicular dimension — equals the
 *     media's `printAreaDots` (e.g. 696 dots for DK-22205 62 mm).
 *   - `bitmap.heightPx` is the feed direction (along the tape).
 *
 * The head is wide on QL printers (696 dots for 62 mm DK), so the
 * diagnostic print is layout-rotated 90° relative to labelmanager's
 * narrow head: long horizontal sections run along the tape feed.
 *
 * Cutter dead-zone (head-to-blade distance) on QL-820NWB: ~13 mm by
 * Brother's DK-22251 spec; encoded as a 156-dot probe ladder. The
 * operator measures from the first visible bar to the cut.
 */
import {
  encodeJobForEngine,
  flipHorizontal,
  renderText,
  type BrotherQLDevice,
  type BrotherQLMedia,
  type LabelBitmap,
  type PageData,
} from '@thermal-label/brother-ql-core';
import { bytesPerRow, createBitmap, padBitmap, stackBitmaps } from '@mbtech-nl/bitmap';
import {
  blankBitmap,
  cropToWidth,
  diagonalStripes,
  edgeProbeSection,
} from '@thermal-label/harness-core/shared';

interface DiagnosticPrintInput {
  device: BrotherQLDevice;
  media: BrotherQLMedia;
  harnessVersion: string;
  driverVersion: string;
}

export interface DiagnosticPrintBitmaps {
  black: LabelBitmap;
  /** Only populated when media carries a `palette` (two-color media). */
  red?: LabelBitmap;
}

interface Section {
  black: LabelBitmap;
  red?: LabelBitmap;
}

const ROW_GAP_PX = 6;
const FILL_STRIPES_HEIGHT_PX = 16;
/**
 * Cutter-offset ladder: bars every 8 dots up to ~17 mm. QL-820NWB
 * head-to-blade distance is ~13 mm (≈156 dots at 300 dpi); the ladder
 * straddles that so the maintainer can read off the actual offset.
 *
 * Sized as `(steps × stepDots × 2 px/row)` so the section is a thin
 * vertical strip on the long feed axis.
 */
const CUTTER_PROBE_STEP_DOTS = 8;
const CUTTER_PROBE_STEP_COUNT = 24; // covers 0..192 dots ≈ 0..16.3 mm
const CUTTER_PROBE_STEP_HEIGHT_PX = 2;

/**
 * Build the head-aligned diagnostic bitmap (black plane) plus an
 * optional red plane when the chosen media is two-color. Width matches
 * the media's `printAreaDots`; height grows as sections are stacked.
 *
 * Exported separately from `encodeBitmap` so the orchestrator can
 * preview the bitmap before printing, and tests can snapshot bitmap
 * dimensions without going through `encodeJobForEngine`.
 */
export function buildDiagnosticBitmap(input: DiagnosticPrintInput): DiagnosticPrintBitmaps {
  const widthDots = input.media.printAreaDots;
  if (typeof widthDots !== 'number') {
    throw new Error(
      `Media ${input.media.name} has no printAreaDots; brother-ql verify-cli only supports DK media today (TZe / HSe omitted).`,
    );
  }

  const twoColor = input.media.palette !== undefined;

  // Sections in print order (top → bottom along the tape feed).
  // Each entry pairs a black-plane bitmap with an optional red overlay
  // of the same dimensions. We stack them separately at the end so the
  // black and red planes have identical heights (encoder requires it).
  const sections: Section[] = [];

  // 1. Headers — short strings that fit the head width. Two-color media
  //    puts them on the red plane (with empty black) so the operator can
  //    eyeball "yes the red ribbon worked".
  const headerStrings = [
    `v${input.harnessVersion} brother-ql ${input.driverVersion}`,
    input.device.key,
  ];
  for (const text of headerStrings) {
    const rendered = textSection(text, widthDots, 1);
    if (twoColor) {
      sections.push({ black: blankBitmap(widthDots, rendered.heightPx), red: rendered });
    } else {
      sections.push({ black: rendered });
    }
  }

  // 2. Top orientation marker. Asymmetric vs the bottom marker so
  //    mirror / upside-down jumps out of a photo without measuring.
  const top = textSection('TOP>', widthDots, 2);
  if (twoColor) {
    sections.push({ black: blankBitmap(widthDots, top.heightPx), red: top });
  } else {
    sections.push({ black: top });
  }

  // 3. Edge probes (left + right). Always black — the operator measures
  //    margins by the first bar that didn't print. Wide QL head → step
  //    in 4-dot increments to keep the section under ~30 mm.
  sections.push({ black: edgeProbeSection(widthDots, 'left', { dotsPerStep: 4 }) });
  sections.push({ black: edgeProbeSection(widthDots, 'right', { dotsPerStep: 4 }) });

  // 4. Sample text at 1x and 2x. Always black.
  sections.push({ black: textSection('TXT 1X SAMPLE', widthDots, 1) });
  sections.push({ black: textSection('2X', widthDots, 2) });

  // 5. Fill region — diagonal stripe pattern for density uniformity. On
  //    two-color media this lands on the red plane so the operator
  //    immediately sees the second ink working across a meaningful area
  //    (header glyphs alone would be easy to miss); on mono it stays
  //    black. Diagonal beats horizontal on visual readability — a
  //    diagonal slip is obvious in the photo.
  const fill = diagonalStripes(widthDots, FILL_STRIPES_HEIGHT_PX);
  if (twoColor) {
    sections.push({ black: blankBitmap(widthDots, fill.heightPx), red: fill });
  } else {
    sections.push({ black: fill });
  }

  // 6. Cutter-offset ladder. Always black. The probe lives at the
  //    bottom of the bitmap; the auto-cut happens shortly after the
  //    last row — the first ladder bar visible above the cut tells the
  //    operator the head-to-cutter dead zone in dots.
  sections.push({ black: cutterProbeSection(widthDots) });

  // 7. Bottom orientation marker — different glyph from `TOP>` so
  //    mirror is obvious from a photo.
  const bottom = textSection('B', widthDots, 2);
  if (twoColor) {
    sections.push({ black: blankBitmap(widthDots, bottom.heightPx), red: bottom });
  } else {
    sections.push({ black: bottom });
  }

  // Stitch with a small white gap between sections.
  const blackPlanes: LabelBitmap[] = [];
  const redPlanes: LabelBitmap[] = [];
  for (const section of sections) {
    blackPlanes.push(section.black);
    if (twoColor) {
      redPlanes.push(section.red ?? blankBitmap(widthDots, section.black.heightPx));
    }
    blackPlanes.push(blankBitmap(widthDots, ROW_GAP_PX));
    if (twoColor) redPlanes.push(blankBitmap(widthDots, ROW_GAP_PX));
  }
  // Drop the trailing gap — the cutter ladder already serves as the
  // last visual element.
  blackPlanes.pop();
  if (twoColor) redPlanes.pop();

  const black = stackBitmaps(blackPlanes, 'vertical');
  if (twoColor) {
    return { black, red: stackBitmaps(redPlanes, 'vertical') };
  }
  return { black };
}

/**
 * Encode the diagnostic bitmap(s) into wire bytes for the device's
 * primary engine. Mirrors the production node adapter's pre-encode
 * step: `flipHorizontal` so input x-axis matches printed x-axis (QL
 * head pin 0 sits on the right side of the printed face).
 */
export function encodeBitmap(
  bitmaps: DiagnosticPrintBitmaps,
  device: BrotherQLDevice,
  media: BrotherQLMedia,
): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- every brother-ql device has at least one engine
  const engine = device.engines[0]!;
  const page: PageData = {
    bitmap: flipHorizontal(bitmaps.black),
    media,
    ...(bitmaps.red ? { redBitmap: flipHorizontal(bitmaps.red) } : {}),
  };
  return encodeJobForEngine([page], { copies: 1 }, engine, device.name);
}

function textSection(text: string, widthDots: number, scale: number): LabelBitmap {
  const rendered = renderText(text, { scaleX: scale, scaleY: scale });
  if (rendered.widthPx <= widthDots) {
    return padBitmap(rendered, { right: widthDots - rendered.widthPx });
  }
  return cropToWidth(rendered, widthDots);
}

/**
 * Cutter-offset ladder: short horizontal bars at every 8th dot row,
 * stepping in length so the operator can identify which bar position
 * survived the cut. Bar `n` is `widthDots / 4` dots wide and lives
 * `n * 8` dots above the bottom of the section.
 *
 * Layout is "rungs" pattern — every 8 dots is a 2-row bar. The
 * operator looks at which rung is the lowest one *visible* on the
 * printed cut piece; that rung's index times 8 is the dead zone in
 * dots. Multiply by 25.4/300 to get mm (~0.085 mm/dot at 300 dpi).
 */
function cutterProbeSection(widthDots: number): LabelBitmap {
  const heightPx = CUTTER_PROBE_STEP_COUNT * CUTTER_PROBE_STEP_DOTS;
  const bitmap = createBitmap(widthDots, heightPx);
  const bytesPerLine = bytesPerRow(widthDots);
  // The bar lives in the centre quarter of the head; clear margins
  // either side so the bar can't be confused with edge artefacts.
  const barStart = Math.floor((widthDots * 3) / 8);
  const barEnd = Math.floor((widthDots * 5) / 8);

  for (let step = 0; step < CUTTER_PROBE_STEP_COUNT; step += 1) {
    // Step 0 sits at the bottom; step N sits N*step_dots above.
    const baseY = heightPx - (step + 1) * CUTTER_PROBE_STEP_DOTS;
    for (let r = 0; r < CUTTER_PROBE_STEP_HEIGHT_PX; r += 1) {
      const y = baseY + r;
      if (y < 0 || y >= heightPx) continue;
      for (let x = barStart; x < barEnd; x += 1) {
        const byteIdx = y * bytesPerLine + Math.floor(x / 8);
        const bitIdx = 7 - (x % 8);
        bitmap.data[byteIdx] = (bitmap.data[byteIdx] ?? 0) | (1 << bitIdx);
      }
    }
  }
  return bitmap;
}
