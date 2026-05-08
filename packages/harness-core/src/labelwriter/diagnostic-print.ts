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
 *
 * **Authored bitmap vs. wire bitmap (plan 08 §6 / §7).**
 *
 * The encoder produces two artefacts from the same authored content:
 *
 *   - `authored` — full label-sized bitmap (`mediaWidthDots ×
 *     mediaLengthDots`). Today's behaviour. The harness's preview
 *     canvas renders this and overlays the dead-zone bands so the
 *     operator sees the complete authored layout AND where it won't
 *     print.
 *   - `wire` — head-sized bitmap with `leadingDots` rows skipped from
 *     the top and `trailingDots` rows skipped from the bottom (the
 *     LW family's "send fewer rows" leading-edge convention; per
 *     plan 08 §6, after the form-feed positions the label, the LW
 *     head is already past the leading dead-zone, so the first wire
 *     row fires at the first reachable label row). Cross-feed: white
 *     padding on the left for `leftDots` columns; the right edge
 *     fires harmlessly past the label.
 *
 * When `printableArea` is `{0,0,0,0}` and `forcedTrailingFeedMm` is
 * 0 (today's phase-1 default — no values populated on any LW engine
 * yet), `wire` equals `authored` byte-for-byte. The override flow
 * in the harness lets operators dial in per-session values that
 * surface the difference; populated registry values come later.
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
import {
  getPrintableArea,
  getForcedTrailingFeedMm,
  ZERO_PRINTABLE_AREA,
  type PrintableArea,
} from '@thermal-label/contracts';
import { cropHeight, cropToWidth, diagonalStripes, edgeProbeSection } from '../shared/index.js';

/**
 * Per-session overrides supplied by the harness operator (plan 08
 * §7a). Each field is optional in millimetres; when present, it
 * replaces the matching value resolved from `getPrintableArea` /
 * `getForcedTrailingFeedMm`. Used by the diagnostic encoder to
 * compose the wire bitmap and by the harness UI to drive the
 * dead-zone overlays in the preview canvas.
 */
export interface PrintableAreaOverride {
  leadingMm?: number;
  trailingMm?: number;
  leftMm?: number;
  rightMm?: number;
  forcedTrailingFeedMm?: number;
}

export interface DiagnosticPrintInput {
  device: LabelWriterDevice;
  media: LabelWriterMedia;
  harnessVersion: string;
  driverVersion: string;
  /**
   * Optional per-session override for the printable-area / forced-
   * trailing-feed values. Merged on top of
   * `getPrintableArea(engine, media)` /
   * `getForcedTrailingFeedMm(engine)`. Phase-1 defaults are zero on
   * every engine, so this is currently the only way to exercise the
   * dead-zone pipeline.
   */
  override?: PrintableAreaOverride;
}

/**
 * Result of `buildDiagnosticBitmap` — both artefacts plus the
 * resolved printable-area metadata so the caller can render overlays
 * (browser harness preview, CLI summary line) without re-resolving.
 */
export interface DiagnosticBitmapResult {
  /**
   * Full label-sized bitmap (`mediaWidthDots × mediaLengthDots`) —
   * what the harness preview renders. Includes the leading / trailing
   * dead-zone rows so the operator sees the authored layout in full;
   * the harness overlays the dead-zone bands as striped overlays per
   * plan 08 §7.
   */
  authored: LabelBitmap;
  /**
   * Head-sized wire bitmap with the LW family's "send fewer rows"
   * leading-edge convention applied: `leadingDots` rows skipped from
   * the top, `trailingDots` rows skipped from the bottom, white-pad
   * on the left for `leftDots` columns, right edge unbounded (the
   * head fires harmlessly past the label). When the resolved
   * `PrintableArea` is `{0,0,0,0}` and `forcedTrailingFeedMm` is 0,
   * `wire === authored` byte-for-byte (today's behaviour).
   */
  wire: LabelBitmap;
  /** The resolved printable area, in mm. */
  printableArea: PrintableArea;
  /** The resolved forced-trailing-feed, in mm. */
  forcedTrailingFeedMm: number;
}

const ROW_GAP_PX = 6;
const DPI = 300;
const CONTINUOUS_DEFAULT_HEIGHT_PX = 1200; // 4 inches at 300 dpi.

/**
 * Build the head-aligned diagnostic bitmap pair.
 *
 * The `authored` bitmap is the full media-sized canvas (today's
 * behaviour) — the operator's design view, what the harness preview
 * renders. The `wire` bitmap is the head-sized composition derived
 * from authored per the LW "send fewer rows" pipeline (plan 08 §6).
 *
 * Sections are stacked with a small white gap, then the result is
 * trimmed to the available label height so we never overflow the
 * trailing edge.
 *
 * Exported separately from `encodeBitmap` so the orchestrator can
 * preview the bitmap before printing, and tests can snapshot bitmap
 * dimensions without going through the full `encodeLabel` pipeline.
 */
export function buildDiagnosticBitmap(input: DiagnosticPrintInput): DiagnosticBitmapResult {
  // Bitmap width should match the LOADED LABEL's printable width, not
  // the printer's full head dot count. LW heads are 672 dots wide
  // (~57 mm) but a 36 mm ADDRESS_LARGE label only uses ~425 of them;
  // sending a 672-dot bitmap to a 36 mm label gives ~2× the expected
  // width. Cap at headDots defensively in case a media entry
  // overstates.
  const headDots = primaryHeadDots(input.device);
  const labelWidthDots = Math.min(mediaWidthPx(input.media), headDots);
  const labelHeight = mediaHeightPx(input.media);
  const trailingProbeOffsetDots = trailingEdgeProbeDots(input.device);

  // Resolve printable area BEFORE composing sections so the layout
  // budget excludes the dead zones up front. Content is sized to fit
  // within the printable region; dead-zone rows/cols at the edges of
  // the authored bitmap stay white. The wire transform then drops
  // those blank rows / pads cross-feed columns — no content is ever
  // sliced off because the diagnostic was authored to fit in the
  // first place.
  const printableArea = resolvePrintableArea(input);
  const forcedTrailingFeedMm = resolveForcedTrailingFeedMm(input);
  const leadingDots = mmToDots(printableArea.leading);
  const trailingDots = mmToDots(printableArea.trailing);
  const leftDots = mmToDots(printableArea.left);
  const rightDots = mmToDots(printableArea.right);

  // Effective content dimensions — inside the dead-zone bands.
  const contentWidthDots = Math.max(8, labelWidthDots - leftDots - rightDots);
  const contentHeight =
    labelHeight !== undefined ? Math.max(0, labelHeight - leadingDots - trailingDots) : undefined;

  // "Head" sections — fixed-height content that should appear at the
  // leading edge regardless of label length. Identifying header,
  // orientation marker, edge probes, sample text.
  const headSections: LabelBitmap[] = [
    textSection(`v${input.harnessVersion}`, contentWidthDots, 1),
    textSection(input.device.key, contentWidthDots, 1),
    textSection(String(input.media.id).toUpperCase(), contentWidthDots, 1),
    textSection('TOP>', contentWidthDots, 2),
    edgeProbeSection(contentWidthDots, 'left', { stepCount: 32 }),
    edgeProbeSection(contentWidthDots, 'right', { stepCount: 32 }),
    textSection('TXT 1X SAMPLE', contentWidthDots, 1),
    textSection('TXT 2X', contentWidthDots, 2),
  ];

  // "Tail" sections — trailing-edge probe + bottom orientation
  // marker. Pinned to the bottom of the printable region (which is
  // the trailing edge minus the trailing dead zone).
  const tailSections: LabelBitmap[] = [
    textSection(`TRAIL+${String(trailingProbeOffsetDots)}`, contentWidthDots, 1),
    trailingProbeMarker(contentWidthDots),
    textSection('B', contentWidthDots, 2),
  ];

  // Fill region between head and tail, sized to whatever's left in
  // the printable region.
  const headHeight = sumHeightsWithGaps(headSections);
  const tailHeight = sumHeightsWithGaps(tailSections);
  const fillHeight = computeFillHeight(headHeight, tailHeight, contentHeight);
  const middleSection = diagonalStripes(contentWidthDots, fillHeight);

  const sections = [...headSections, middleSection, ...tailSections];

  // Stitch sections with a small white gap.
  const gapped: LabelBitmap[] = [];
  for (const section of sections) {
    gapped.push(section);
    gapped.push(createBitmap(contentWidthDots, ROW_GAP_PX));
  }
  gapped.pop();

  const contentStack = stackBitmaps(gapped, 'vertical');
  const contentTrimmed =
    contentHeight !== undefined && contentStack.heightPx > contentHeight
      ? cropHeight(contentStack, contentHeight)
      : contentStack;

  // Position the content stack inside a full-label-sized canvas. The
  // top `leadingDots` rows + bottom `trailingDots` rows + left/right
  // `leftDots`/`rightDots` cols stay white. This is the authored
  // bitmap the preview displays (with dead-zone overlays striped on
  // top per §7) and that the wire encoder consumes.
  const authoredHeight = labelHeight ?? contentTrimmed.heightPx + leadingDots + trailingDots;
  const authored = createBitmap(labelWidthDots, authoredHeight);
  pasteBitmap(authored, contentTrimmed, leadingDots, leftDots);

  const wire = composeWireBitmap(authored, headDots, printableArea, forcedTrailingFeedMm);

  return { authored, wire, printableArea, forcedTrailingFeedMm };
}

/**
 * Copy a smaller bitmap into a larger destination at the given
 * (row, col) offset. Used to position the diagnostic content stack
 * inside the full-label-sized authored canvas, leaving the dead-zone
 * bands as white.
 */
function pasteBitmap(
  dest: LabelBitmap,
  src: LabelBitmap,
  rowOffset: number,
  colOffset: number,
): void {
  const srcBpr = bytesPerRow(src.widthPx);
  const dstBpr = bytesPerRow(dest.widthPx);
  const maxRow = Math.min(src.heightPx, dest.heightPx - rowOffset);
  const maxCol = Math.min(src.widthPx, dest.widthPx - colOffset);
  for (let y = 0; y < maxRow; y += 1) {
    for (let x = 0; x < maxCol; x += 1) {
      const srcByte = src.data[y * srcBpr + (x >> 3)] ?? 0;
      const srcBit = ((srcByte >> (7 - (x & 7))) & 1) === 1;
      if (!srcBit) continue;
      const dstX = colOffset + x;
      const dstY = rowOffset + y;
      const dstByteIdx = dstY * dstBpr + (dstX >> 3);
      dest.data[dstByteIdx] = (dest.data[dstByteIdx] ?? 0) | (1 << (7 - (dstX & 7)));
    }
  }
}

/**
 * Resolve the effective printable area for this session. Starts from
 * `getPrintableArea(engine, media)` (zeros today, populated values
 * later) and overlays any per-session operator overrides on top.
 */
function resolvePrintableArea(input: DiagnosticPrintInput): PrintableArea {
  const engine = input.device.engines[0];
  if (!engine) return ZERO_PRINTABLE_AREA;
  const base = getPrintableArea(engine, input.media);
  const ov = input.override;
  if (!ov) return base;
  return {
    leading: ov.leadingMm ?? base.leading,
    trailing: ov.trailingMm ?? base.trailing,
    left: ov.leftMm ?? base.left,
    right: ov.rightMm ?? base.right,
  };
}

function resolveForcedTrailingFeedMm(input: DiagnosticPrintInput): number {
  const engine = input.device.engines[0];
  if (!engine) return 0;
  const base = getForcedTrailingFeedMm(engine);
  return input.override?.forcedTrailingFeedMm ?? base;
}

/**
 * Build the wire bitmap from the authored bitmap per plan 08 §6.
 *
 * For LW: head-sized × `(authoredHeight - leadingDots - trailingDots)`
 * rows; the authored content is pasted at wire row 0, column
 * `leftDots` (LW labels are left-aligned — `labelLeftEdgeDot = 0`).
 * The wire bitmap is shorter than the label by `leadingDots +
 * trailingDots` rows — that's the "send fewer rows" mechanism.
 *
 * When `printableArea` is all zeros AND `forcedTrailingFeedMm` is
 * zero AND the authored bitmap is already head-sized (i.e. matches
 * `headDots`), we return the authored bitmap unchanged so today's
 * byte stream is preserved exactly. This is the phase-1 invariant.
 *
 * Note: today's authored bitmap is `labelWidthDots`-wide, not
 * `headDots`-wide. The `encodeLabel` driver pipeline pads the bitmap
 * to head width before emitting — so even in the no-override path
 * the wire stream the printer sees is identical regardless of
 * whether we widen here or downstream. We widen here when we need to
 * apply a `leftDots` offset, and pass through narrow when we don't,
 * so byte-identity holds for the no-override case.
 */
function composeWireBitmap(
  authored: LabelBitmap,
  headDots: number,
  printableArea: PrintableArea,
  forcedTrailingFeedMm: number,
): LabelBitmap {
  const leadingDots = mmToDots(printableArea.leading);
  const trailingDots = mmToDots(printableArea.trailing);
  const leftDots = mmToDots(printableArea.left);
  const rightDots = mmToDots(printableArea.right);
  const trailingFeedDots = mmToDots(forcedTrailingFeedMm);

  // Phase-1 fast path: nothing to do, return the authored bitmap
  // verbatim so the wire stream stays byte-identical to today's.
  if (
    leadingDots === 0 &&
    trailingDots === 0 &&
    leftDots === 0 &&
    rightDots === 0 &&
    trailingFeedDots === 0
  ) {
    return authored;
  }

  // Compute wire dimensions. LW skips leading and trailing rows;
  // forcedTrailingFeedMm is 0 for LW today (variable form-feed) so
  // the trailing-feed pad is harmless if a future engine populates
  // it.
  const skipTop = Math.min(leadingDots, authored.heightPx);
  const skipBottom = Math.min(trailingDots, Math.max(0, authored.heightPx - skipTop));
  const wireRows = Math.max(0, authored.heightPx - skipTop - skipBottom) + trailingFeedDots;
  const wire = createBitmap(headDots, Math.max(1, wireRows));

  if (wireRows === 0) return wire;

  // Cross-feed paste: copy authored cols [leftDots, labelWidthDots -
  // rightDots) into wire cols [leftDots, labelWidthDots - rightDots).
  // LW labels are left-aligned, so labelLeftEdgeDot = 0.
  const labelWidthDots = authored.widthPx;
  const srcColStart = Math.min(leftDots, labelWidthDots);
  const srcColEnd = Math.max(srcColStart, labelWidthDots - rightDots);
  const dstColStart = srcColStart;

  const srcBpr = bytesPerRow(authored.widthPx);
  const dstBpr = bytesPerRow(wire.widthPx);
  const contentRows = authored.heightPx - skipTop - skipBottom;

  for (let y = 0; y < contentRows; y += 1) {
    const srcY = y + skipTop;
    const dstY = y;
    for (let x = srcColStart; x < srcColEnd; x += 1) {
      const srcByteIdx = srcY * srcBpr + (x >> 3);
      const srcBit = (((authored.data[srcByteIdx] ?? 0) >> (7 - (x & 7))) & 1) === 1;
      if (!srcBit) continue;
      const dstX = dstColStart + (x - srcColStart);
      if (dstX >= wire.widthPx) break;
      const dstByteIdx = dstY * dstBpr + (dstX >> 3);
      wire.data[dstByteIdx] = (wire.data[dstByteIdx] ?? 0) | (1 << (7 - (dstX & 7)));
    }
  }

  // forcedTrailingFeedMm rows are already allocated all-white by
  // createBitmap — no extra work needed.
  return wire;
}

function mmToDots(mm: number): number {
  return Math.round((mm * DPI) / 25.4);
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
 *
 * Pass `result.wire` (not `result.authored`) — the wire bitmap is
 * what the printer is supposed to receive.
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
