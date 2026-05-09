/**
 * Driver-agnostic helpers for building diagnostic-print bitmaps.
 *
 * Each driver's encoder composes its own section list using these
 * primitives, optionally overlaying a `red` companion plane for
 * two-color media. Per-driver concerns (text rendering, cutter offset,
 * tape vs label semantics) stay in the driver's own diagnostic-print
 * module.
 *
 * All helpers take a `widthPx` matching the head-perpendicular
 * dimension and return single-plane `LabelBitmap` values. Callers
 * stack and pad as needed; this module doesn't compose layouts.
 */
import { bytesPerRow, createBitmap, type LabelBitmap, type RawImageData } from '@mbtech-nl/bitmap';

/**
 * Edge-probe ladder. Each row carries a horizontal bar starting at
 * the chosen edge and growing by `dotsPerStep` per step. The first
 * row whose bar fails to print on the operator's photo reveals the
 * printable margin in dots.
 *
 * Defaults: 2 dots per step, 2 rows per step. `stepCount` defaults to
 * `floor(widthPx / dotsPerStep)` — i.e. the ladder spans the whole
 * head width. Override on wide heads (brother-ql QL has 696 dots; a
 * 696-step ladder would be ~58 mm tall) by passing a smaller
 * `stepCount` or larger `dotsPerStep`.
 */
export interface EdgeProbeOptions {
  /** Width of one bar step, in dots. Defaults to 2. */
  dotsPerStep?: number;
  /** Pixel rows per step (visual thickness of each bar). Defaults to 2. */
  rowsPerStep?: number;
  /** Number of steps. Defaults to spanning the full width. */
  stepCount?: number;
}

export function edgeProbeSection(
  widthPx: number,
  edge: 'left' | 'right',
  options: EdgeProbeOptions = {},
): LabelBitmap {
  const dotsPerStep = options.dotsPerStep ?? 2;
  const rowsPerStep = options.rowsPerStep ?? 2;
  const stepCount = options.stepCount ?? Math.max(1, Math.floor(widthPx / dotsPerStep));
  const heightPx = stepCount * rowsPerStep;
  const bitmap = createBitmap(widthPx, heightPx);
  const bpr = bytesPerRow(widthPx);

  for (let step = 0; step < stepCount; step += 1) {
    const barLength = (step + 1) * dotsPerStep;
    for (let r = 0; r < rowsPerStep; r += 1) {
      const y = step * rowsPerStep + r;
      for (let i = 0; i < barLength; i += 1) {
        const x = edge === 'left' ? i : widthPx - 1 - i;
        const byteIdx = y * bpr + (x >> 3);
        bitmap.data[byteIdx] = (bitmap.data[byteIdx] ?? 0) | (1 << (7 - (x & 7)));
      }
    }
  }
  return bitmap;
}

/**
 * Diagonal-stripe fill — chevron-friendly density check that's more
 * visually engaging than 1-dot vertical/horizontal stripes. Pixel
 * `(x, y)` is set when `((x + y) // period) % 2 === 0`, producing 45°
 * bands of width `period`. Default period 7 dots is roughly 0.6 mm at
 * 300 dpi: wide enough to verify visually, narrow enough to surface
 * dropped rows.
 */
export function diagonalStripes(widthPx: number, heightPx: number, period = 7): LabelBitmap {
  const bitmap = createBitmap(widthPx, heightPx);
  const bpr = bytesPerRow(widthPx);
  for (let y = 0; y < heightPx; y += 1) {
    for (let x = 0; x < widthPx; x += 1) {
      if (Math.floor((x + y) / period) % 2 === 0) {
        const byteIdx = y * bpr + (x >> 3);
        bitmap.data[byteIdx] = (bitmap.data[byteIdx] ?? 0) | (1 << (7 - (x & 7)));
      }
    }
  }
  return bitmap;
}

/**
 * Vertical 1-dot stripes — black column / white column / black column.
 * Less visually interesting than `diagonalStripes` but useful for
 * head-resolution checks (the sharpest stripe a thermal head can
 * resolve at the dot pitch). Kept available for callers that want it.
 */
export function verticalStripes(widthPx: number, heightPx: number): LabelBitmap {
  const bitmap = createBitmap(widthPx, heightPx);
  const bpr = bytesPerRow(widthPx);
  for (let y = 0; y < heightPx; y += 1) {
    for (let x = 0; x < widthPx; x += 2) {
      const byteIdx = y * bpr + (x >> 3);
      bitmap.data[byteIdx] = (bitmap.data[byteIdx] ?? 0) | (1 << (7 - (x & 7)));
    }
  }
  return bitmap;
}

/**
 * An empty (all-white) bitmap of the given dimensions. Convenience
 * for layout code that needs a placeholder bitmap on the opposite
 * plane in two-color encoders.
 */
export function blankBitmap(widthPx: number, heightPx: number): LabelBitmap {
  return createBitmap(widthPx, heightPx);
}

/**
 * Crop a bitmap to a target width by keeping the leftmost columns.
 * Used when a rendered text section overflows the head width; the
 * cropped result is visually clipped on the right rather than aborted.
 */
export function cropToWidth(bitmap: LabelBitmap, targetWidth: number): LabelBitmap {
  if (bitmap.widthPx <= targetWidth) return bitmap;
  const out = createBitmap(targetWidth, bitmap.heightPx);
  const srcBpr = bytesPerRow(bitmap.widthPx);
  const dstBpr = bytesPerRow(targetWidth);
  for (let y = 0; y < bitmap.heightPx; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const srcByteIdx = y * srcBpr + (x >> 3);
      const srcBit = (((bitmap.data[srcByteIdx] ?? 0) >> (7 - (x & 7))) & 1) === 1;
      if (srcBit) {
        const dstByteIdx = y * dstBpr + (x >> 3);
        out.data[dstByteIdx] = (out.data[dstByteIdx] ?? 0) | (1 << (7 - (x & 7)));
      }
    }
  }
  return out;
}

/**
 * Crop a bitmap to a target height by keeping the topmost rows.
 * Used to clamp a stacked diagnostic to a known label length.
 */
export function cropHeight(bitmap: LabelBitmap, targetHeight: number): LabelBitmap {
  if (bitmap.heightPx <= targetHeight) return bitmap;
  const out = createBitmap(bitmap.widthPx, targetHeight);
  const bpr = bytesPerRow(bitmap.widthPx);
  out.data.set(bitmap.data.subarray(0, targetHeight * bpr));
  return out;
}

/**
 * Sum of section heights plus inter-section gaps of size `gapPx`.
 * Useful for adaptive layouts that need to fill remaining label
 * height between fixed-height head and tail sections.
 */
export function sumHeightsWithGaps(sections: readonly LabelBitmap[], gapPx: number): number {
  if (sections.length === 0) return 0;
  const sectionsHeight = sections.reduce((acc, s) => acc + s.heightPx, 0);
  const gapsHeight = gapPx * (sections.length - 1);
  return sectionsHeight + gapsHeight;
}

/**
 * Convert a 1bpp `LabelBitmap` to an RGBA `RawImageData`. Set bits
 * become opaque black; unset bits become opaque white. Used by the
 * harness's diagnostic-image builders to hand the driver an RGBA
 * image — the driver runs its own threshold/dither pipeline (so the
 * harness exercises the real wire path).
 */
export function bitmapToRgba(bitmap: LabelBitmap): RawImageData {
  const { widthPx, heightPx } = bitmap;
  const bpr = bytesPerRow(widthPx);
  const data = new Uint8Array(widthPx * heightPx * 4);
  for (let y = 0; y < heightPx; y += 1) {
    for (let x = 0; x < widthPx; x += 1) {
      const byte = bitmap.data[y * bpr + (x >> 3)] ?? 0;
      const bit = (byte >> (7 - (x & 7))) & 1;
      const idx = (y * widthPx + x) * 4;
      const v = bit === 1 ? 0 : 255;
      data[idx] = v;
      data[idx + 1] = v;
      data[idx + 2] = v;
      data[idx + 3] = 255;
    }
  }
  return { width: widthPx, height: heightPx, data };
}
