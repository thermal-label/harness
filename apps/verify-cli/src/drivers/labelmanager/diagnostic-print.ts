/**
 * Labelmanager diagnostic-print encoder.
 *
 * One comprehensive print, not T1–T7. Layout (per plan 06 §UX shape and
 * plan 05 §hard rules):
 *
 *   - Header block: driver / model / harness version. Rasterised with
 *     the driver's bundled 8x8 font.
 *   - Asymmetric orientation markers: `TOP>` near the top, `B` near
 *     the bottom — different shapes so mirror / upside-down jumps out
 *     in a photo without measuring.
 *   - Edge probes: thin horizontal bars stepping outward in 1-dot
 *     increments along the head's left and right edges. The first
 *     dropped bar reveals the printable margin in dots.
 *   - Sample text at two sizes (1x and 2x the font's natural 8 px),
 *     so legibility/dot-uniformity can be eyeballed at both scales.
 *   - Fill region: a small alternating stripe block for density
 *     uniformity check.
 *
 * Cutter-offset probe is **omitted** for labelmanager: the family does
 * not auto-cut (the user pulls the manual cutter lever); ESC G is a
 * form-feed, not a cut. There's no head-to-cutter "dead zone" worth
 * probing because the operator chooses where to cut. Documented inline
 * so the second driver's MVP (labelwriter 4xx, which *does* auto-cut)
 * surfaces the cutter-probe convention.
 *
 * Bitmap orientation contract (from `labelmanager-core/src/protocol.ts`):
 *   - `widthPx` is the head-perpendicular dimension (across the tape) —
 *     for 12 mm tape this is 64 dots.
 *   - `heightPx` is the feed direction (along the tape).
 *
 * The print runs head-aligned with no rotation; the print appears
 * "sideways" relative to the tape's natural reading direction. That
 * matches the operator's view as the tape comes out of the slot — they
 * inspect the printout in the same orientation as the encoder lays it
 * out.
 */
import {
  buildPrinterStream,
  renderText,
  type LabelManagerDevice,
  type TapeWidth,
} from '@thermal-label/labelmanager-core';
import {
  bytesPerRow,
  createBitmap,
  padBitmap,
  stackBitmaps,
  type LabelBitmap,
} from '@mbtech-nl/bitmap';

interface DiagnosticPrintInput {
  device: LabelManagerDevice;
  tapeWidth: TapeWidth;
  harnessVersion: string;
  driverVersion: string;
}

const ROW_GAP_PX = 4;
const HEAD_DOTS_FOR_TAPE: Record<TapeWidth, number> = {
  6: 32,
  9: 48,
  12: 64,
  19: 64,
};

/**
 * Build the head-aligned diagnostic bitmap. Width matches the head dot
 * count for the chosen tape; height grows as sections are stacked.
 *
 * Exported separately from `encodeDiagnosticPrint` so tests (plan 05
 * step 6) can snapshot the bitmap dimensions without going through the
 * full `buildPrinterStream` pipeline.
 */
export function buildDiagnosticBitmap(input: DiagnosticPrintInput): LabelBitmap {
  const headDots = HEAD_DOTS_FOR_TAPE[input.tapeWidth];

  const sections: LabelBitmap[] = [];

  // 1. Header block — model key + harness version. Two short lines at
  //    1x; both fit the 64-dot head used by 12 mm and 19 mm tape. The
  //    issue title carries the "what is this print of?" framing — no
  //    need to repeat "LM-DIAG" on the print itself.
  sections.push(textSection(`v${input.harnessVersion}`, headDots, 1));
  sections.push(textSection(input.device.key, headDots, 1));

  // 2. Asymmetric orientation marker — top.
  sections.push(textSection('TOP>', headDots, 1));

  // 3. Edge probes. Bars step inward from row 0 toward the centre on
  //    one side and outward toward the head edge on the other; the
  //    first row whose bar fails to print reveals the printable margin.
  sections.push(edgeProbeSection(headDots, 'left'));
  sections.push(edgeProbeSection(headDots, 'right'));

  // 4. Sample text at two sizes for legibility eyeball. Strings sized
  //    to fit a 64-dot head (12 mm tape) at the requested scale.
  sections.push(textSection('TXT 1X', headDots, 1));
  sections.push(textSection('2X', headDots, 2));

  // 5. Fill region — alternating stripes for density uniformity.
  sections.push(fillStripes(headDots, 12));

  // 6. Bottom orientation marker — different glyph from `TOP>`.
  sections.push(textSection('B', headDots, 1));

  // Stitch with a small white gap between sections.
  const gapped: LabelBitmap[] = [];
  for (const section of sections) {
    gapped.push(section);
    gapped.push(createBitmap(headDots, ROW_GAP_PX));
  }
  // Drop the trailing gap so the print ends exactly on the last section.
  gapped.pop();

  return stackBitmaps(gapped, 'vertical');
}

/**
 * Encode the diagnostic print to printer wire bytes for the active USB
 * Printer-Class endpoint. Uses `buildPrinterStream` (the labelle-style
 * raw-byte path), not the HID-report path — node-side USB driver writes
 * to bulk EP 5 OUT.
 */
export function encodeDiagnosticPrint(input: DiagnosticPrintInput): Uint8Array {
  const bitmap = buildDiagnosticBitmap(input);
  return buildPrinterStream(bitmap, { tapeWidth: input.tapeWidth, copies: 1 });
}

/**
 * Render a short text string into a head-width-bounded bitmap. Lines
 * wider than the head are clipped on the right (the encoder doesn't
 * try to wrap — keep the strings short).
 */
function textSection(text: string, headDots: number, scale: number): LabelBitmap {
  const rendered = renderText(text, { scaleX: scale, scaleY: scale });
  if (rendered.widthPx <= headDots) {
    return padBitmap(rendered, { right: headDots - rendered.widthPx });
  }
  // Crop visually rather than throw — diagnostic print tolerates a
  // truncated label more than it tolerates a hard failure.
  return cropToWidth(rendered, headDots);
}

/**
 * Build an edge-probe section: each row is a bar that steps further
 * from the chosen edge as the row index increases. The first row whose
 * bar didn't print (when the operator examines the output) is the
 * printable margin in dots.
 *
 * Rows are 2 px tall to be visible without a magnifier; bar lengths
 * step by 2 dots between rows so a 32-dot head covers 0..30 in
 * 16 rows.
 */
function edgeProbeSection(headDots: number, edge: 'left' | 'right'): LabelBitmap {
  const rowsPerStep = 2;
  const dotsPerStep = 2;
  const stepCount = Math.floor(headDots / dotsPerStep);
  const heightPx = stepCount * rowsPerStep;
  const bitmap = createBitmap(headDots, heightPx);
  const bytesPerLine = bytesPerRow(headDots);

  for (let step = 0; step < stepCount; step += 1) {
    const barLength = (step + 1) * dotsPerStep;
    for (let r = 0; r < rowsPerStep; r += 1) {
      const y = step * rowsPerStep + r;
      // Set bits along the chosen edge, `barLength` dots wide.
      for (let x = 0; x < barLength; x += 1) {
        const px = edge === 'left' ? x : headDots - 1 - x;
        const byteIdx = y * bytesPerLine + Math.floor(px / 8);
        const bitIdx = 7 - (px % 8);
        bitmap.data[byteIdx] = (bitmap.data[byteIdx] ?? 0) | (1 << bitIdx);
      }
    }
  }
  return bitmap;
}

/**
 * Alternating black/white stripes (1 dot each) repeated for `repeatRows`
 * rows. Density check: pattern integrity at the head's resolution limit.
 */
function fillStripes(headDots: number, heightPx: number): LabelBitmap {
  const bitmap = createBitmap(headDots, heightPx);
  const bytesPerLine = bytesPerRow(headDots);
  for (let y = 0; y < heightPx; y += 1) {
    for (let x = 0; x < headDots; x += 1) {
      if (x % 2 === 0) {
        const byteIdx = y * bytesPerLine + Math.floor(x / 8);
        const bitIdx = 7 - (x % 8);
        bitmap.data[byteIdx] = (bitmap.data[byteIdx] ?? 0) | (1 << bitIdx);
      }
    }
  }
  return bitmap;
}

function cropToWidth(bitmap: LabelBitmap, targetWidth: number): LabelBitmap {
  const cropped = createBitmap(targetWidth, bitmap.heightPx);
  const srcBpr = bytesPerRow(bitmap.widthPx);
  const dstBpr = bytesPerRow(targetWidth);
  for (let y = 0; y < bitmap.heightPx; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const srcByteIdx = y * srcBpr + Math.floor(x / 8);
      const srcBitIdx = 7 - (x % 8);
      if (((bitmap.data[srcByteIdx] ?? 0) >> srcBitIdx) & 1) {
        const dstByteIdx = y * dstBpr + Math.floor(x / 8);
        const dstBitIdx = 7 - (x % 8);
        cropped.data[dstByteIdx] = (cropped.data[dstByteIdx] ?? 0) | (1 << dstBitIdx);
      }
    }
  }
  return cropped;
}
