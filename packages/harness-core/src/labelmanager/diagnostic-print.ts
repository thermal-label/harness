/**
 * Labelmanager diagnostic-print encoder — shared by both harness apps
 * (CLI: `apps/verify-cli/`; browser: `apps/harness-labelmanager/`).
 *
 * Lifted out of `apps/verify-cli/src/drivers/labelmanager/` so the
 * browser app can import the same wire-byte producer the CLI does;
 * follows the same pattern as `harness-core/labelwriter`. See that
 * sibling for the rationale behind keeping driver-named subpaths
 * inside otherwise-agnostic harness-core rather than spinning a new
 * workspace package.
 *
 * One comprehensive print, not T1–T7. Layout (per plan 06 §UX shape
 * and plan 05 §hard rules):
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
 * Cutter-offset probe is **omitted** for labelmanager: the family
 * does not auto-cut (the user pulls the manual cutter lever); ESC G
 * is a form-feed, not a cut. There's no head-to-cutter "dead zone"
 * worth probing because the operator chooses where to cut.
 *
 * Bitmap orientation contract (from `labelmanager-core/src/protocol.ts`):
 *   - `widthPx` is the head-perpendicular dimension (across the tape) —
 *     for 12 mm tape this is 64 dots.
 *   - `heightPx` is the feed direction (along the tape).
 *
 * The print runs head-aligned with no rotation; the print appears
 * "sideways" relative to the tape's natural reading direction. That
 * matches the operator's view as the tape comes out of the slot —
 * they inspect the printout in the same orientation as the encoder
 * lays it out.
 *
 * **Authored bitmap vs. wire bytes (plan 08 §6 Labelmanager).**
 *
 * Labelmanager pads top + bottom in the encoder itself
 * (`buildPrinterStream` reads `engine.printableArea.leading` +
 * `getForcedTrailingFeedMm(engine)` and pads white rows accordingly —
 * the "white-pad-rows" mechanism per plan 08 §6, distinct from
 * labelwriter's "send fewer rows"). The harness's job is therefore
 * simpler than labelwriter's: author content within the printable
 * region, hand off the bitmap as-is to the driver-core encoder, and
 * let the encoder do the padding.
 *
 * Dead-zone values come from `getPrintableArea(engine)` /
 * `getForcedTrailingFeedMm(engine)` — chassis-mechanical registry
 * metadata, no operator-facing override. The maintainer revises
 * registry values per bench measurement.
 *
 * The returned `wire` field is the same `LabelBitmap` as `authored`
 * (the labelmanager harness does not pre-skip rows), kept in the
 * result shape so this driver's API matches the labelwriter pair.
 * Callers pass `result.wire` to `encodeBitmap` exactly as they do for
 * labelwriter; the difference is invisible to the call site.
 */
import {
  buildPrinterStream,
  renderText,
  type LabelManagerDevice,
  type LabelManagerMedia,
  type LabelManagerPrintOptions,
  type TapeWidth,
} from '@thermal-label/labelmanager-core';
import { createBitmap, padBitmap, stackBitmaps, type LabelBitmap } from '@mbtech-nl/bitmap';
import {
  getPrintableArea,
  getForcedTrailingFeedMm,
  ZERO_PRINTABLE_AREA,
  type PrintableArea,
} from '@thermal-label/contracts';
import { cropToWidth, diagonalStripes, edgeProbeSection } from '../shared/index.js';

export interface DiagnosticPrintInput {
  device: LabelManagerDevice;
  /**
   * The selected D1 cartridge. Width comes from `media.tapeWidthMm`;
   * the colour pair (`text` / `background`) drives the `ESC C n`
   * tape-type byte the encoder emits internally.
   */
  media: LabelManagerMedia;
  harnessVersion: string;
  driverVersion: string;
}

/**
 * Result of `buildDiagnosticBitmap` — the authored bitmap plus the
 * resolved printable-area metadata so the caller can render preview
 * overlays (browser harness preview canvas) without re-resolving.
 *
 * `wire === authored` for labelmanager: the encoder pads top/bottom
 * itself, so the harness doesn't pre-transform. The dual field
 * mirrors the labelwriter result shape so consumer code stays
 * symmetric.
 */
export interface DiagnosticBitmapResult {
  /**
   * Authored bitmap — what the harness preview renders. Width
   * matches the head dot count for the chosen tape; height grows as
   * sections stack.
   */
  authored: LabelBitmap;
  /**
   * Same bitmap as `authored`. Kept as a distinct field so the
   * call-site shape matches labelwriter: the wire transform for
   * labelmanager lives in the driver-core encoder, not here.
   */
  wire: LabelBitmap;
  /** The resolved printable area, in mm. */
  printableArea: PrintableArea;
  /** The resolved forced-trailing-feed, in mm. */
  forcedTrailingFeedMm: number;
}

const ROW_GAP_PX = 4;
const HEAD_DOTS_FOR_TAPE: Record<TapeWidth, number> = {
  6: 32,
  9: 48,
  12: 64,
  19: 64,
};

/**
 * Build the head-aligned diagnostic bitmap. Width matches the head
 * dot count for the chosen tape; height grows as sections are
 * stacked.
 *
 * The bitmap content is authored unchanged: the labelmanager-core
 * encoder pads the leading + trailing dead zones itself, so the
 * harness's contribution is a faithful "what we want printed inside
 * the printable region". The harness preview canvas overlays the
 * dead-zone bands on top via `result.printableArea` /
 * `result.forcedTrailingFeedMm` so the operator sees the full
 * "won't print" picture.
 */
export function buildDiagnosticBitmap(input: DiagnosticPrintInput): DiagnosticBitmapResult {
  const headDots = HEAD_DOTS_FOR_TAPE[input.media.tapeWidthMm];

  const sections: LabelBitmap[] = [];

  // 1. Header block — model key + harness version. Two short lines
  //    at 1x; both fit the 64-dot head used by 12 mm and 19 mm tape.
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

  // 5. Fill region — diagonal stripe pattern for density uniformity.
  sections.push(diagonalStripes(headDots, 24));

  // 6. Bottom orientation marker — different glyph from `TOP>`.
  sections.push(textSection('B', headDots, 1));

  // Stitch with a small white gap between sections.
  const gapped: LabelBitmap[] = [];
  for (const section of sections) {
    gapped.push(section);
    gapped.push(createBitmap(headDots, ROW_GAP_PX));
  }
  // Drop the trailing gap so the print ends exactly on the last
  // section — the encoder will pad its own trailing white rows.
  gapped.pop();

  const authored = stackBitmaps(gapped, 'vertical');
  const printableArea = resolvePrintableArea(input);
  const forcedTrailingFeedMm = resolveForcedTrailingFeedMm(input);

  return { authored, wire: authored, printableArea, forcedTrailingFeedMm };
}

/**
 * Encode an already-built bitmap to printer wire bytes for the
 * active USB Printer-Class endpoint. Uses `buildPrinterStream` (the
 * labelle-style raw-byte path), not the HID-report path — host-side
 * code writes to bulk EP 5 OUT.
 *
 * Split from `buildDiagnosticBitmap` so the orchestrator can preview
 * the bitmap before committing bytes to the wire.
 *
 * `engine` is required after the plan-08 refactor — the encoder
 * reads `printableArea` + `forcedTrailingFeedMm` to apply the
 * leading/trailing pads. Pass `device.engines[0]`.
 *
 * `media` is forwarded to `buildPrinterStream` so the encoder
 * resolves the `ESC C n` tape-type byte from the cartridge's
 * `text` / `background` colours via `tapeTypeFor(media)`. Without
 * the media argument the encoder would fall back to `n=0` (black-
 * on-white), which is wrong for any coloured / reverse-print
 * cartridge.
 */
export function encodeBitmap(
  bitmap: LabelBitmap,
  engine: LabelManagerDevice['engines'][number],
  media: LabelManagerMedia,
): Uint8Array {
  const options: LabelManagerPrintOptions = { copies: 1 };
  return buildPrinterStream(bitmap, engine, options, media);
}

function resolvePrintableArea(input: DiagnosticPrintInput): PrintableArea {
  const engine = input.device.engines[0];
  if (!engine) return ZERO_PRINTABLE_AREA;
  return getPrintableArea(engine);
}

function resolveForcedTrailingFeedMm(input: DiagnosticPrintInput): number {
  const engine = input.device.engines[0];
  if (!engine) return 0;
  return getForcedTrailingFeedMm(engine);
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
