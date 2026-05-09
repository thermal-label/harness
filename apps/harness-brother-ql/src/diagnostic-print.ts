/**
 * Brother-QL diagnostic-print encoder for the browser harness.
 *
 * Mirrors `apps/verify-cli/src/drivers/brother-ql/diagnostic-print.ts`
 * — same content, same orientation, same encoder dispatch — but
 * returns the shell's `DiagnosticBitmapResult` shape so the
 * `<BitmapPreview>` overlay reads the printable-area metadata
 * uniformly across drivers.
 *
 * Brother-QL doesn't expose `engine.printableArea` / forced trailing
 * feed today (the encoder injects feed margins via `ESC i d` from the
 * raster-protocol config rather than off the registry), so we pass
 * `ZERO_PRINTABLE_AREA` + `forcedTrailingFeedMm: 0`. The preview
 * canvas degrades gracefully — no overlay band, but the bitmap itself
 * renders correctly at the engine DPI.
 *
 * Two-color rendering: when `media.palette` is defined (DK-22251 /
 * DK-44205 today), the encoder emits a `redBitmap` alongside the
 * black bitmap. Header text + orientation markers go in the red
 * plane; edge probes, sample text, fill stripes, and the cutter probe
 * go in black. The `wire` bitmap returned to the shell is the black
 * plane only — the preview canvas is single-plane so two-colour media
 * shows the operator-facing content (text + orientation markers in
 * black/red) accurately enough at the preview scale. The actual print
 * receives both planes via the encoder.
 *
 * Bitmap orientation contract (from `brother-ql-core/protocol.ts`):
 *   - `bitmap.widthPx` is the head-perpendicular dimension (across the tape) —
 *     equals the media's `printAreaDots` (e.g. 696 dots for DK-22205 62 mm).
 *   - `bitmap.heightPx` is the feed direction (along the tape).
 */
import {
  encodeJobForEngine,
  flipHorizontal,
  renderText,
  type BrotherQLDevice,
  type BrotherQLMedia,
  type LabelBitmap,
  type PageData,
  type PrintEngine,
} from '@thermal-label/brother-ql-core';
import { bytesPerRow, createBitmap, padBitmap, stackBitmaps } from '@mbtech-nl/bitmap';
import {
  blankBitmap,
  cropToWidth,
  diagonalStripes,
  edgeProbeSection,
} from '@thermal-label/harness-core/shared';
import { ZERO_PRINTABLE_AREA } from '@thermal-label/contracts';
import type { DiagnosticBitmapResult } from '@thermal-label/harness-core/labelmanager';

interface DiagnosticPrintInput {
  device: BrotherQLDevice;
  engine: PrintEngine;
  media: BrotherQLMedia;
  harnessVersion: string;
  driverVersion: string;
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
 */
const CUTTER_PROBE_STEP_DOTS = 8;
const CUTTER_PROBE_STEP_COUNT = 24;
const CUTTER_PROBE_STEP_HEIGHT_PX = 2;

/**
 * Resolve the head-perpendicular dot count for the active media on
 * the active engine. DK media carries the flat `printAreaDots` field;
 * TZe / HSe media carries head-family geometry under `media.geometry`
 * keyed by 128-pin (`narrow`) vs 560-pin (`wide`) head.
 */
function resolveWidthDots(media: BrotherQLMedia, engine: PrintEngine): number {
  if (typeof media.printAreaDots === 'number') return media.printAreaDots;
  const family = engine.headDots === 128 ? 'narrow' : 'wide';
  const geom = media.geometry?.[family];
  if (geom) return geom.printAreaDots;
  throw new Error(
    `${media.name} has no printAreaDots (DK) and no geometry.${family} entry — encoder cannot resolve head-perpendicular width.`,
  );
}

/**
 * Build the head-aligned diagnostic bitmap. Returns the shell's
 * `DiagnosticBitmapResult` shape so the preview canvas reads the same
 * `authored` / `wire` / `printableArea` / `forcedTrailingFeedMm`
 * fields it does for LM/LW.
 *
 * The internal red plane (when applicable for two-color media) is
 * stashed on a module-local map keyed by the returned bitmap so
 * `encodeBytes` can reattach it without changing the shell's
 * single-bitmap encoder signature.
 */
export function buildDiagnosticBitmap(input: DiagnosticPrintInput): DiagnosticBitmapResult {
  const widthDots = resolveWidthDots(input.media, input.engine);
  const twoColor = input.media.palette !== undefined;

  const sections: Section[] = [];

  // 1. Header strings on the red plane (two-color) so the operator sees
  //    second-ribbon coverage without measuring; black on single-color.
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

  // 2. Top orientation marker — asymmetric vs the bottom marker so
  //    mirror / upside-down jumps out of a photo without measuring.
  const top = textSection('TOP>', widthDots, 2);
  if (twoColor) {
    sections.push({ black: blankBitmap(widthDots, top.heightPx), red: top });
  } else {
    sections.push({ black: top });
  }

  // 3. Edge probes — always black, operator measures margins by which
  //    bar didn't print. QL's wide head wants 4-dot steps to keep the
  //    section under ~30 mm.
  sections.push({ black: edgeProbeSection(widthDots, 'left', { dotsPerStep: 4 }) });
  sections.push({ black: edgeProbeSection(widthDots, 'right', { dotsPerStep: 4 }) });

  // 4. Sample text 1x and 2x — always black.
  sections.push({ black: textSection('TXT 1X SAMPLE', widthDots, 1) });
  sections.push({ black: textSection('2X', widthDots, 2) });

  // 5. Fill region — diagonal stripe pattern. Red on two-color so the
  //    operator immediately sees the second ink working across a
  //    meaningful area.
  const fill = diagonalStripes(widthDots, FILL_STRIPES_HEIGHT_PX);
  if (twoColor) {
    sections.push({ black: blankBitmap(widthDots, fill.heightPx), red: fill });
  } else {
    sections.push({ black: fill });
  }

  // 6. Cutter-offset ladder — always black. Lives at the bottom; the
  //    auto-cut happens shortly after the last row, so the first
  //    visible bar above the cut tells the head-to-cutter dead zone.
  sections.push({ black: cutterProbeSection(widthDots) });

  // 7. Bottom orientation marker — different glyph from `TOP>`.
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
  // Drop the trailing gap — cutter ladder serves as the last visual.
  blackPlanes.pop();
  if (twoColor) redPlanes.pop();

  const black = stackBitmaps(blackPlanes, 'vertical');
  if (twoColor) {
    const red = stackBitmaps(redPlanes, 'vertical');
    redPlaneFor.set(black, red);
  }

  return {
    authored: black,
    wire: black,
    printableArea: ZERO_PRINTABLE_AREA,
    forcedTrailingFeedMm: 0,
  };
}

/**
 * Module-local stash of the red plane keyed by the black bitmap, so
 * `encodeBytes` can reattach it without changing the shell's
 * single-bitmap encoder signature. WeakMap so dropped bitmaps GC
 * cleanly. Empty entries (single-color media) just resolve to
 * undefined.
 */
const redPlaneFor = new WeakMap<LabelBitmap, LabelBitmap>();

/**
 * Encode the diagnostic bitmap into wire bytes for the device's
 * primary engine. Mirrors the verify-cli encoder: `flipHorizontal` on
 * both planes (QL head pin 0 is on the right of the printed face),
 * then `encodeJobForEngine` with the engine's protocol config picked
 * automatically.
 */
export function encodeBitmap(
  bitmap: LabelBitmap,
  device: BrotherQLDevice,
  media: BrotherQLMedia,
  engine: PrintEngine,
): Uint8Array {
  const red = redPlaneFor.get(bitmap);
  const page: PageData = {
    bitmap: flipHorizontal(bitmap),
    media,
    ...(red ? { redBitmap: flipHorizontal(red) } : {}),
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
 * survived the cut.
 */
function cutterProbeSection(widthDots: number): LabelBitmap {
  const heightPx = CUTTER_PROBE_STEP_COUNT * CUTTER_PROBE_STEP_DOTS;
  const bitmap = createBitmap(widthDots, heightPx);
  const bytesPerLine = bytesPerRow(widthDots);
  const barStart = Math.floor((widthDots * 3) / 8);
  const barEnd = Math.floor((widthDots * 5) / 8);

  for (let step = 0; step < CUTTER_PROBE_STEP_COUNT; step += 1) {
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
