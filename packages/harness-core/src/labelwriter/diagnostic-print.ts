/**
 * Labelwriter diagnostic-print encoder — shared by both harness apps
 * (CLI: `apps/verify-cli/`; browser: `apps/harness-labelwriter/`).
 *
 * Lifted out of `apps/verify-cli/src/drivers/labelwriter/` so the
 * browser app can import the same wire-byte producer the CLI does;
 * the alternative (a sibling `apps/harness-labelwriter-shared/`
 * package) trades a bigger workspace for a thinner harness-core. We
 * picked the subpath instead because:
 *
 *   - harness-core is workspace-internal and never published, so a
 *     driver-shaped subpath inside it costs nothing externally;
 *   - `harness-core/shared` already hosts the cross-driver bitmap
 *     primitives this encoder composes — keeping the labelwriter
 *     composition next to those primitives is clearer than a third
 *     workspace member;
 *   - per-driver subpaths (`harness-core/labelwriter`,
 *     `/labelmanager`, `/brother-ql`) scale naturally as each driver
 *     gets its harness-app, without one-off package boilerplate.
 *
 * The driver-agnostic boundary is preserved by file path rather than
 * package boundary: the `labelwriter/` subdirectory states the scope
 * up front. `harness-core/shared` stays free of any driver-specific
 * imports; this file is the only place a driver-core import shows up
 * in harness-core, and its subpath name discloses that.
 *
 * One comprehensive print, not T1–T7. Layout (per plan 06 §UX shape
 * and plan 05 §hard rules):
 *
 *   - Header block: harness version + driver/model key. Rasterised
 *     with the driver-core's bundled 8x8 font. Strings sized to the
 *     head's dot count for the chosen label so they fit even on the
 *     narrowest stock (return-address 19 mm).
 *   - Asymmetric orientation markers: `TOP>` near the leading edge,
 *     `B` near the trailing edge — different shapes so mirror /
 *     upside-down jumps out in a photo without measuring.
 *   - Edge probes: thin bars stepping outward in 2-dot increments
 *     along the head's left and right edges. The first dropped bar
 *     reveals the printable margin in dots — paper-stock sensors
 *     aside, the active head region is centred under the label so
 *     both edges are symmetric in normal operation.
 *   - Sample text at 1x and 2x the natural 8 px font, for legibility
 *     + dot-uniformity eyeball at both scales.
 *   - Fill region: alternating diagonal stripes for density
 *     uniformity. Stretches to fill long labels.
 *   - Trailing-edge probe: a known marker placed N dots above where
 *     the trailing-edge dead-zone is expected to begin (per the
 *     registry's `trailingEdgeOffsetMm`, when present). The operator
 *     reads from the photo whether the marker landed where expected,
 *     which validates the head-to-cut/tear geometry.
 *
 * Bitmap orientation contract (`labelwriter-core/src/protocol.ts`):
 *   - `widthPx` is the head-perpendicular dimension (across the head)
 *     — for the 300-series this is 672 dots. The encoder stretches
 *     undersized bitmaps to head-width, so we render head-aligned.
 *   - `heightPx` is the feed direction (along the label).
 *
 * The print runs head-aligned with no rotation. On a die-cut label
 * the encoder pads any unused width to the head dot count; the
 * printer's paper sensor stops the feed at the gap. Continuous media
 * (`heightMm` undefined) falls back to a fixed feed length (we use 4
 * inches @ 300 dpi = 1200 dots — enough to fit the diagnostic on a
 * 57 mm tape).
 */
import {
  buildJobHeader,
  encodeLabel,
  renderText,
  type LabelWriterDevice,
  type LabelWriterMedia,
} from '@thermal-label/labelwriter-core';
import { createBitmap, padBitmap, stackBitmaps, type LabelBitmap } from '@mbtech-nl/bitmap';
import { cropHeight, cropToWidth, diagonalStripes, edgeProbeSection } from '../shared/index.js';

export interface DiagnosticPrintInput {
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
 * The bitmap's `widthPx` is the active head-dot count for the
 * device's primary engine; `heightPx` is constrained by the chosen
 * media's feed-direction length (the registry stores it as
 * `lengthDots`).
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
  // Bitmap width should match the LOADED LABEL's printable width, not
  // the printer's full head dot count. LW heads are 672 dots wide
  // (~57 mm) but a 36 mm ADDRESS_LARGE label only uses ~425 of them;
  // sending a 672-dot bitmap to a 36 mm label gives ~2× the expected
  // width. Cap at headDots defensively in case a media entry
  // overstates.
  const headDots = Math.min(mediaWidthPx(input.media), primaryHeadDots(input.device));
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
    edgeProbeSection(headDots, 'left', { stepCount: 32 }),
    edgeProbeSection(headDots, 'right', { stepCount: 32 }),
    textSection('TXT 1X SAMPLE', headDots, 1),
    textSection('TXT 2X', headDots, 2),
  ];

  // "Tail" sections — trailing-edge probe + bottom orientation
  // marker. Always pinned to the trailing edge of the label so the
  // cut/gap alignment is comparable across runs.
  const tailSections: LabelBitmap[] = [
    textSection(`TRAIL+${String(trailingProbeOffsetDots)}`, headDots, 1),
    trailingProbeMarker(headDots),
    textSection('B', headDots, 2),
  ];

  // Fill region between head and tail. Stretches to fill the
  // available label height — long labels (e.g. LEVER_ARCH at 190 mm)
  // get a continuous density check across the whole label rather
  // than a 26 mm block at the top with the rest blank.
  const headHeight = sumHeightsWithGaps(headSections);
  const tailHeight = sumHeightsWithGaps(tailSections);
  const fillHeight = computeFillHeight(headHeight, tailHeight, labelHeight);
  const middleSection = diagonalStripes(headDots, fillHeight);

  const sections = [...headSections, middleSection, ...tailSections];

  // Stitch sections with a small white gap.
  const gapped: LabelBitmap[] = [];
  for (const section of sections) {
    gapped.push(section);
    gapped.push(createBitmap(headDots, ROW_GAP_PX));
  }
  gapped.pop();

  const stacked = stackBitmaps(gapped, 'vertical');

  // Belt-and-suspenders trim — adaptive sizing should already hit
  // the label height exactly, but cap defensively on continuous
  // media or sizing edge cases.
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
 * label is short, the length is unknown (continuous), or the
 * head/tail already overflows.
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
 * driver-core's `encodeLabel`. A small `ESC s` job header is
 * prepended for the lw-550 family (idempotent on lw-450 —
 * `encodeLabel` itself adds the appropriate framing).
 *
 * Split from `buildDiagnosticBitmap` so the orchestrator can preview
 * the bitmap before committing bytes to the wire.
 */
export function encodeBitmap(bitmap: LabelBitmap, device: LabelWriterDevice): Uint8Array {
  // copies = 1 implicit; density 'normal'; mode 'graphics' since the
  // diagnostic carries fine 1-dot stripes.
  const body = encodeLabel(device, bitmap, { copies: 1, mode: 'graphics', compress: false });
  // Optional ESC s job header — `encodeLabel` for lw-550 emits its
  // own job header, so we only prepend on lw-450 when we want a
  // stable job id (1) for triage. Keep it simple: no prepend;
  // encodeLabel already produces a complete stream.
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

/**
 * Printable width across the head, derived from the loaded label's
 * `widthMm`. The driver-core's `encodeLabel` aligns the bitmap on the
 * head per the engine's offset rules; the bitmap width should match
 * the label's actual printable width to avoid the "fills full head,
 * label sees only half" misalignment.
 */
function mediaWidthPx(media: LabelWriterMedia): number {
  return Math.round((media.widthMm * DPI) / 25.4);
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
 * Trailing-edge probe marker — a 24-dot-wide × 4-row bar centred on
 * the head, easy to spot in a photo. Read against the `TRAIL+N` text
 * label printed just above it.
 */
function trailingProbeMarker(headDots: number): LabelBitmap {
  const heightPx = 4;
  const barWidth = 24;
  const bitmap = createBitmap(headDots, heightPx);
  const startX = Math.max(0, Math.floor((headDots - barWidth) / 2));
  const bytesPerLine = Math.ceil(headDots / 8);
  for (let y = 0; y < heightPx; y += 1) {
    for (let x = startX; x < startX + barWidth && x < headDots; x += 1) {
      const byteIdx = y * bytesPerLine + (x >> 3);
      bitmap.data[byteIdx] = (bitmap.data[byteIdx] ?? 0) | (1 << (7 - (x & 7)));
    }
  }
  return bitmap;
}
