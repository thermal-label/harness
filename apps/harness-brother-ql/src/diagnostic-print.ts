/**
 * Brother-QL diagnostic-image builder for the browser harness.
 *
 * Returns full-RGBA `RawImageData` so the driver's `print()` runs the
 * real palette-split + dither pipeline (two-color rolls like
 * DK-22251 split into black + red planes inside the driver via
 * `renderMultiPlaneImage`). The harness's contribution is a single
 * RGBA composition with red pixels where the second ribbon should
 * fire — the driver classifies each pixel into the correct plane on
 * the way out.
 *
 * Layout mirrors the LM/LW builders: identifying header,
 * orientation markers, edge probes, sample text at two scales, fill
 * region, cutter-offset ladder. Two-color rolls' header text +
 * orientation markers get red pixels so the operator immediately
 * sees the second ink working across a meaningful area.
 */
import {
  renderText,
  type BrotherQLDevice,
  type BrotherQLMedia,
  type LabelBitmap,
  type PrintEngine,
  type RawImageData,
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
 * Build the head-aligned diagnostic image as RGBA. Two-color media
 * gets red pixels where the second ribbon should fire; the driver
 * classifies pixels into the appropriate plane via its palette
 * splitter.
 */
export function buildDiagnosticImage(input: DiagnosticPrintInput): RawImageData {
  const widthDots = resolveWidthDots(input.media, input.engine);
  const twoColor = input.media.palette !== undefined;

  const sections: Section[] = [];

  // 1. Header strings on the red plane (two-color); black on
  //    single-color.
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
  //    mirror / upside-down jumps out of a photo.
  const top = textSection('TOP>', widthDots, 2);
  if (twoColor) {
    sections.push({ black: blankBitmap(widthDots, top.heightPx), red: top });
  } else {
    sections.push({ black: top });
  }

  // 3. Edge probes — always black.
  sections.push({ black: edgeProbeSection(widthDots, 'left', { dotsPerStep: 4 }) });
  sections.push({ black: edgeProbeSection(widthDots, 'right', { dotsPerStep: 4 }) });

  // 4. Sample text 1x and 2x — always black.
  sections.push({ black: textSection('TXT 1X SAMPLE', widthDots, 1) });
  sections.push({ black: textSection('2X', widthDots, 2) });

  // 5. Fill region — diagonal stripe pattern.
  const fill = diagonalStripes(widthDots, FILL_STRIPES_HEIGHT_PX);
  if (twoColor) {
    sections.push({ black: blankBitmap(widthDots, fill.heightPx), red: fill });
  } else {
    sections.push({ black: fill });
  }

  // 6. Cutter-offset ladder — always black.
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
  blackPlanes.pop();
  if (twoColor) redPlanes.pop();

  const black = stackBitmaps(blackPlanes, 'vertical');
  const red = twoColor ? stackBitmaps(redPlanes, 'vertical') : null;

  return composeRgba(black, red);
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

/**
 * Compose 1bpp black + (optional) red planes into an RGBA buffer.
 * Set bits in the black plane → opaque black; set bits in the red
 * plane → opaque red; cleared in both → opaque white. Where black
 * and red overlap, black wins (matches the driver's plane-split
 * priority).
 */
function composeRgba(black: LabelBitmap, red: LabelBitmap | null): RawImageData {
  const widthPx = black.widthPx;
  const heightPx = black.heightPx;
  const bpr = bytesPerRow(widthPx);
  const data = new Uint8Array(widthPx * heightPx * 4);
  for (let y = 0; y < heightPx; y += 1) {
    for (let x = 0; x < widthPx; x += 1) {
      const blackByte = black.data[y * bpr + (x >> 3)] ?? 0;
      const blackBit = (blackByte >> (7 - (x & 7))) & 1;
      const redBit =
        red === null ? 0 : ((red.data[y * bpr + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1;
      const idx = (y * widthPx + x) * 4;
      if (blackBit === 1) {
        data[idx] = 0;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
      } else if (redBit === 1) {
        data[idx] = 255;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
      } else {
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
      }
      data[idx + 3] = 255;
    }
  }
  return { width: widthPx, height: heightPx, data };
}
