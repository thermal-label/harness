/**
 * Labelwriter diagnostic-print encoder.
 *
 * One comprehensive print, not T1–T7. Layout (per plan 06 §UX shape and
 * plan 05 §hard rules):
 *
 *   - Header block: harness version + driver/model key. Rasterised with
 *     the driver-core's bundled 8x8 font. Strings sized to the head's
 *     dot count for the chosen label so they fit even on the narrowest
 *     stock (return-address 19 mm).
 *   - Asymmetric orientation markers: `TOP>` near the leading edge,
 *     `B` near the trailing edge — different shapes so mirror /
 *     upside-down jumps out in a photo without measuring.
 *   - Edge probes: thin bars stepping outward in 2-dot increments along
 *     the head's left and right edges. The first dropped bar reveals
 *     the printable margin in dots — paper-stock sensors aside, the
 *     active head region is centred under the label so both edges are
 *     symmetric in normal operation.
 *   - Sample text at 1x and 2x the natural 8 px font, for legibility +
 *     dot-uniformity eyeball at both scales.
 *   - Fill region: alternating 1-dot stripes for density uniformity.
 *   - Trailing-edge probe: a known marker placed N dots above where
 *     the trailing-edge dead-zone is expected to begin (per the
 *     registry's `trailingEdgeOffsetMm`, when present). The operator
 *     reads from the photo whether the marker landed where expected,
 *     which validates the head-to-cut/tear geometry. The maintainer's
 *     LW 330 Turbo / LW 400 use a manual tear bar, not an auto-cutter
 *     — the same probe still reveals the trailing dead zone the
 *     mechanism relies on. Documented inline so a future auto-cutter
 *     model (e.g. LW 450 SE / Twin Turbo) just reuses this probe with
 *     no shape change.
 *
 * Bitmap orientation contract (`labelwriter-core/src/protocol.ts`):
 *   - `widthPx` is the head-perpendicular dimension (across the head)
 *     — for the 300-series this is 672 dots. The encoder stretches
 *     undersized bitmaps to head-width, so we render head-aligned.
 *   - `heightPx` is the feed direction (along the label).
 *
 * The print runs head-aligned with no rotation. On a die-cut label the
 * encoder pads any unused width to the head dot count; the printer's
 * paper sensor stops the feed at the gap. Continuous media (`heightMm`
 * undefined) falls back to a fixed feed length (we use 4 inches @ 300
 * dpi = 1200 dots — enough to fit the diagnostic on a 57 mm tape).
 */
import {
  buildJobHeader,
  encodeLabel,
  renderText,
  type LabelWriterDevice,
  type LabelWriterMedia,
} from '@thermal-label/labelwriter-core';
import {
  bytesPerRow,
  createBitmap,
  padBitmap,
  stackBitmaps,
  type LabelBitmap,
} from '@mbtech-nl/bitmap';

interface DiagnosticPrintInput {
  device: LabelWriterDevice;
  media: LabelWriterMedia;
  harnessVersion: string;
  driverVersion: string;
}

const ROW_GAP_PX = 6;
const DPI = 300;
const CONTINUOUS_DEFAULT_HEIGHT_PX = 1200; // 4 inches at 300 dpi.

/**
 * Build the head-aligned diagnostic bitmap.
 *
 * The bitmap's `widthPx` is the active head-dot count for the device's
 * primary engine; `heightPx` is constrained by the chosen media's
 * feed-direction length (the registry stores it as `lengthDots`).
 *
 * Sections are stacked with a small white gap, then the result is
 * trimmed to the available label height so we never overflow the
 * trailing edge.
 *
 * Exported separately from `encodeBitmap` so the orchestrator can
 * preview the bitmap before printing, and tests can snapshot bitmap
 * dimensions without going through the full `encodeLabel` pipeline.
 */
export function buildDiagnosticBitmap(input: DiagnosticPrintInput): LabelBitmap {
  const headDots = primaryHeadDots(input.device);
  const labelHeight = mediaHeightPx(input.media);
  const trailingProbeOffsetDots = trailingEdgeProbeDots(input.device);

  // "Head" sections — fixed-height content that should appear at the
  // leading edge regardless of label length. Identifying header,
  // orientation marker, edge probes, sample text.
  const headSections: LabelBitmap[] = [
    textSection(`v${input.harnessVersion}`, headDots, 1),
    textSection(input.device.key, headDots, 1),
    textSection(String(input.media.id).toUpperCase(), headDots, 1),
    textSection('TOP>', headDots, 2),
    edgeProbeSection(headDots, 'left', 32),
    edgeProbeSection(headDots, 'right', 32),
    textSection('TXT 1X SAMPLE', headDots, 1),
    textSection('TXT 2X', headDots, 2),
  ];

  // "Tail" sections — trailing-edge probe + bottom orientation marker.
  // Always pinned to the trailing edge of the label so the cut/gap
  // alignment is comparable across runs.
  const tailSections: LabelBitmap[] = [
    textSection(`TRAIL+${String(trailingProbeOffsetDots)}`, headDots, 1),
    trailingProbeMarker(headDots),
    textSection('B', headDots, 2),
  ];

  // Fill region between head and tail. Stretches to fill the available
  // label height — long labels (e.g. LEVER_ARCH at 190 mm) get a
  // continuous density check across the whole label rather than a
  // 26 mm block at the top with the rest blank.
  const headHeight = sumHeightsWithGaps(headSections);
  const tailHeight = sumHeightsWithGaps(tailSections);
  const fillHeight = computeFillHeight(headHeight, tailHeight, labelHeight);
  const middleSection = fillStripes(headDots, fillHeight);

  const sections = [...headSections, middleSection, ...tailSections];

  // Stitch sections with a small white gap.
  const gapped: LabelBitmap[] = [];
  for (const section of sections) {
    gapped.push(section);
    gapped.push(createBitmap(headDots, ROW_GAP_PX));
  }
  gapped.pop();

  const stacked = stackBitmaps(gapped, 'vertical');

  // Belt-and-suspenders trim — adaptive sizing should already hit the
  // label height exactly, but cap defensively on continuous media or
  // sizing edge cases.
  if (labelHeight !== undefined && stacked.heightPx > labelHeight) {
    return cropHeight(stacked, labelHeight);
  }
  return stacked;
}

/** Sum of section heights plus inter-section gaps. */
function sumHeightsWithGaps(sections: readonly LabelBitmap[]): number {
  if (sections.length === 0) return 0;
  const sectionsHeight = sections.reduce((acc, s) => acc + s.heightPx, 0);
  const gapsHeight = ROW_GAP_PX * (sections.length - 1);
  return sectionsHeight + gapsHeight;
}

/**
 * Pick the fill-region height. Stretches to fill the available label
 * length on long labels; falls back to a fixed 16-dot strip when the
 * label is short, the length is unknown (continuous), or the head/tail
 * already overflows.
 */
function computeFillHeight(
  headHeight: number,
  tailHeight: number,
  labelHeight: number | undefined,
): number {
  const MIN_FILL = 16;
  if (labelHeight === undefined) return MIN_FILL;
  // +2 ROW_GAP_PX for the gaps surrounding the middle section.
  const remaining = labelHeight - headHeight - tailHeight - ROW_GAP_PX * 2;
  return remaining > MIN_FILL ? remaining : MIN_FILL;
}

/**
 * Encode an already-built bitmap to printer wire bytes via the
 * driver-core's `encodeLabel`. A small `ESC s` job header is prepended
 * for the lw-550 family (idempotent on lw-450 — `encodeLabel` itself
 * adds the appropriate framing).
 *
 * Split from `buildDiagnosticBitmap` so the orchestrator can preview
 * the bitmap before committing bytes to the wire.
 */
export function encodeBitmap(bitmap: LabelBitmap, device: LabelWriterDevice): Uint8Array {
  // copies = 1 implicit; density 'normal'; mode 'graphics' since the
  // diagnostic carries fine 1-dot stripes.
  const body = encodeLabel(device, bitmap, { copies: 1, mode: 'graphics', compress: false });
  // Optional ESC s job header — `encodeLabel` for lw-550 emits its own
  // job header, so we only prepend on lw-450 when we want a stable
  // job id (1) for triage. Keep it simple: no prepend; encodeLabel
  // already produces a complete stream.
  void buildJobHeader;
  return body;
}

function primaryHeadDots(device: LabelWriterDevice): number {
  const engine = device.engines.find(e => e.role !== 'tape') ?? device.engines[0];
  if (!engine) {
    throw new Error(`Device ${device.key} has no engines declared.`);
  }
  return engine.headDots;
}

function mediaHeightPx(media: LabelWriterMedia): number | undefined {
  if (media.lengthDots !== undefined) return media.lengthDots;
  if (media.heightMm !== undefined) return Math.round((media.heightMm * DPI) / 25.4);
  // Continuous tape — accept up to the soft cap.
  return CONTINUOUS_DEFAULT_HEIGHT_PX;
}

function trailingEdgeProbeDots(device: LabelWriterDevice): number {
  const engine = device.engines[0];
  const caps = engine?.capabilities as
    | { trailingEdgeOffsetMm?: number; leadingEdgeOffsetMm?: number }
    | undefined;
  const mm = caps?.trailingEdgeOffsetMm;
  if (mm !== undefined) return Math.round((mm * DPI) / 25.4);
  // Fallback: a conservative 20-dot offset is enough to land inside
  // the printable area on every LW model in the registry.
  return 20;
}

/**
 * Render a short text string into a head-width-bounded bitmap. Lines
 * wider than the head are cropped on the right (the encoder doesn't
 * try to wrap — keep strings short).
 */
function textSection(text: string, headDots: number, scale: number): LabelBitmap {
  const rendered = renderText(text, { scaleX: scale, scaleY: scale });
  if (rendered.widthPx <= headDots) {
    return padBitmap(rendered, { right: headDots - rendered.widthPx });
  }
  return cropToWidth(rendered, headDots);
}

/**
 * Build an edge-probe section: each row is a bar that steps further
 * from the chosen edge as the row index increases. The first row whose
 * bar didn't print marks the printable margin in dots.
 *
 * `stepCount` controls how far we probe — 32 steps × 2 dots = 64-dot
 * coverage from each edge, which is enough to surface the margin on
 * every label in the registry.
 */
function edgeProbeSection(
  headDots: number,
  edge: 'left' | 'right',
  stepCount: number,
): LabelBitmap {
  const rowsPerStep = 2;
  const dotsPerStep = 2;
  const heightPx = stepCount * rowsPerStep;
  const bitmap = createBitmap(headDots, heightPx);
  const bytesPerLine = bytesPerRow(headDots);

  for (let step = 0; step < stepCount; step += 1) {
    const barLength = (step + 1) * dotsPerStep;
    for (let r = 0; r < rowsPerStep; r += 1) {
      const y = step * rowsPerStep + r;
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

/**
 * Trailing-edge probe marker — a 24-dot-wide × 4-row bar centred on
 * the head, easy to spot in a photo. Read against the `TRAIL+N` text
 * label printed just above it.
 */
function trailingProbeMarker(headDots: number): LabelBitmap {
  const heightPx = 4;
  const barWidth = 24;
  const bitmap = createBitmap(headDots, heightPx);
  const bytesPerLine = bytesPerRow(headDots);
  const startX = Math.max(0, Math.floor((headDots - barWidth) / 2));
  for (let y = 0; y < heightPx; y += 1) {
    for (let x = startX; x < startX + barWidth && x < headDots; x += 1) {
      const byteIdx = y * bytesPerLine + Math.floor(x / 8);
      const bitIdx = 7 - (x % 8);
      bitmap.data[byteIdx] = (bitmap.data[byteIdx] ?? 0) | (1 << bitIdx);
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

function cropHeight(bitmap: LabelBitmap, targetHeight: number): LabelBitmap {
  if (bitmap.heightPx <= targetHeight) return bitmap;
  const cropped = createBitmap(bitmap.widthPx, targetHeight);
  const bpr = bytesPerRow(bitmap.widthPx);
  cropped.data.set(bitmap.data.subarray(0, targetHeight * bpr));
  return cropped;
}
