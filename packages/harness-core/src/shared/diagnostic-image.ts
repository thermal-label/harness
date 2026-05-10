/**
 * Unified diagnostic-image builder — single layout source of truth across
 * every driver harness. Each driver's `apps/harness-X/src/diagnostic-print.ts`
 * builds a `DiagnosticImageSpec` from its driver-specific media + engine, then
 * delegates here. New driver families (Niimbot, Letratag, Phomemo, …) get
 * the same layout for free by routing their spec values through this module.
 *
 * Returns RGBA `RawImageData`. The driver's `printer.print()` runs the real
 * threshold/dither/palette-split pipeline — we never hand off 1bpp here, and
 * we never do head-aligned-bitmap or wire-skip transforms (each driver's
 * `print()` already handles its own head conventions, including the LW
 * "send fewer rows" transform and any hflip).
 *
 * ## Layout (vertical stack, widthDots × heightDots)
 *
 * Header verbosity is width-driven. `widthDots < 128` is "tape territory"
 * (LM 12 mm = 64 dots, LM 19 mm = 96 dots) — fall back to a compact
 * 2-line header (deviceKey + mediaId) and only the scale-2 sample, since
 * scale-3 burns ~3 mm of feed for marginal value on narrow stock. At
 * `widthDots >= 128` we go to the full 3-line header + both sample sizes.
 *
 * `TXT 1X SAMPLE` is gone entirely — 8 px (~0.68 mm @ 300 dpi) isn't
 * honestly assessable for legibility on any real-world print. Smallest
 * sample is now scale-2 (16 px ≈ 1.36 mm); scale-3 (24 px ≈ 2 mm) is the
 * "comfortable" anchor on labels.
 *
 * Order, top → bottom:
 *   1. Header block (compact: 2 lines on tape; full: 3 lines on label)
 *   2. `TOP>` orientation marker (scale 2)
 *   3. Left edge probe (4-dot steps; step count derived from width)
 *   4. Right edge probe (same)
 *   5. `TXT 2X READABLE` sample (always)
 *   6. `TXT 3X COMFORTABLE` sample (only on widthDots >= 128)
 *   7. **Stretchable fill** — diagonal stripes; consumes whatever feed
 *      length is left between head + tail. `MIN_FILL_HEIGHT_PX = 16`
 *      floor for ultra-short labels. **Multi-ink fill**: split horizontally
 *      into one band per palette entry — two-color → black band on top
 *      half, second ink on bottom half; three-color → three equal bands;
 *      single-color → solid black. Operator verifies each ink fires.
 *   8. Cutter-offset ladder — only when `cutterOffsetDots` is supplied.
 *      Bars step inward every 8 dots, ladder-height = `min(192, heightDots
 *      / 8)`, centred around the predicted cut position
 *      (`heightDots - cutterOffsetDots`). Operator reads which bar
 *      survived the cut to learn the actual offset.
 *   9. `B` trailing orientation marker (scale 2) — always.
 *
 * Inter-section gap is `ROW_GAP_PX = 6` (matches the previous per-driver
 * builders).
 *
 * ## Multi-ink palette handling
 *
 * `PaletteEntry.rgb` carries the `[r, g, b]` tuple for each ink. The
 * generator paints set-bits with that ink's RGBA value:
 *
 *   - Header text → painted with the **secondary** ink (red on two-colour;
 *     primary on single-colour). Surfaces ink-fire visually high up the
 *     print so the operator immediately sees if the second ribbon failed.
 *   - TOP / B markers, edge probes, sample text, cutter ladder → **always
 *     primary ink** (black). These are alignment / legibility signals;
 *     mixing inks confuses them.
 *   - Fill bands → cycle through every palette entry. Each band is painted
 *     in its entry's colour.
 *
 * The driver's `renderMultiPlaneImage` classifies each pixel by colour
 * into the appropriate plane. We hand it RGBA where each ink should fire;
 * we don't compose planes ourselves.
 */
import { bytesPerRow, createBitmap, padBitmap, renderText } from '@mbtech-nl/bitmap';
import type { LabelBitmap, PaletteEntry, RawImageData } from '@thermal-label/contracts';
import { cropToWidth, diagonalStripes, edgeProbeSection } from './diagnostic-bitmap.js';

/**
 * Inputs to {@link buildDiagnosticImage}. Driver-side helpers compute
 * these from their driver-specific media + engine descriptors and
 * delegate.
 */
export interface DiagnosticImageSpec {
  /** Print-area width in dots (head-perpendicular). */
  widthDots: number;
  /**
   * Feed-direction target height in dots. The fill region stretches to
   * consume whatever feed is left after the head + tail sections; a
   * `MIN_FILL_HEIGHT_PX` floor protects ultra-short labels from
   * collapsing the fill entirely.
   */
  heightDots: number;
  /**
   * Multi-ink palette straight from `media.palette`. Undefined or single-
   * entry → single-color (header text + fill in primary). Two-or-more
   * entries → fill region splits into one horizontal band per ink so the
   * operator can verify each plane fires.
   */
  palette?: readonly PaletteEntry[];
  /**
   * Cutter-offset ladder. Omit on devices that don't autocut or where
   * head-to-cutter geometry is unmeasured. Presence enables the ladder
   * above the trailing marker; the value is the measured head-to-cutter
   * distance in dots, used to size the ladder so it straddles the actual
   * cut position.
   */
  cutterOffsetDots?: number;

  // Identifying metadata, rendered in the header block.
  harnessVersion: string;
  driverVersion: string;
  /** e.g. `"brother-ql"`, `"labelwriter"`, `"labelmanager"`. */
  driverKey: string;
  /** e.g. `"QL_820NWBc"`. */
  deviceKey: string;
  /** String-cast media id (driver media ids are sometimes `string | number`). */
  mediaId: string;
}

const ROW_GAP_PX = 6;
const MIN_FILL_HEIGHT_PX = 16;
/**
 * Width-driven header / sample verbosity. Tape stock (LM 12 mm = 64 dots,
 * LM 19 mm = 96 dots) drops the full version line and the scale-3 sample;
 * label stock (>= 128 dots ≈ 10.8 mm @ 300 dpi) gets the full layout.
 */
const NARROW_WIDTH_THRESHOLD_DOTS = 128;
/** Edge-probe step count, dimensioned to the head's reach. */
const EDGE_PROBE_DOTS_PER_STEP = 4;
/** Cutter-offset ladder bar pitch (dots between bars). */
const CUTTER_PROBE_STEP_DOTS = 8;
/** Cutter-offset ladder bar thickness (rows). */
const CUTTER_PROBE_STEP_HEIGHT_PX = 2;
/** Maximum cutter-offset ladder height; on short labels it shrinks proportionally. */
const CUTTER_LADDER_MAX_HEIGHT_PX = 192;

/**
 * Build the diagnostic image for a driver harness. RGBA out — driver
 * does threshold/dither.
 */
export function buildDiagnosticImage(spec: DiagnosticImageSpec): RawImageData {
  const widthDots = Math.max(8, Math.floor(spec.widthDots));
  const heightDots = Math.max(MIN_FILL_HEIGHT_PX, Math.floor(spec.heightDots));
  const palette = (spec.palette ?? []).filter(entryHasRgb);
  const isMultiInk = palette.length >= 2;
  const isNarrow = widthDots < NARROW_WIDTH_THRESHOLD_DOTS;

  const primary: PaletteEntry = palette[0] ?? { name: 'black', rgb: [0, 0, 0] };
  const secondary: PaletteEntry = palette[1] ?? primary;

  // ─── Head sections ─────────────────────────────────────────────
  const headSections: ColouredSection[] = [];

  const headerLines = isNarrow
    ? [spec.deviceKey, spec.mediaId.toUpperCase()]
    : [
        `v${spec.harnessVersion} ${spec.driverKey} ${spec.driverVersion}`,
        spec.deviceKey,
        spec.mediaId.toUpperCase(),
      ];
  const headerInk = isMultiInk ? secondary : primary;
  for (const line of headerLines) {
    headSections.push({ bitmap: textSection(line, widthDots, 2), ink: headerInk });
  }

  // Orientation marker.
  headSections.push({ bitmap: textSection('TOP>', widthDots, 2), ink: primary });

  // Edge probes — step count derived from width (every 4 dots), capped so
  // the ladder height stays sane on wide heads.
  const probeStepCount = Math.max(8, Math.floor(widthDots / EDGE_PROBE_DOTS_PER_STEP));
  headSections.push({
    bitmap: edgeProbeSection(widthDots, 'left', {
      dotsPerStep: EDGE_PROBE_DOTS_PER_STEP,
      stepCount: probeStepCount,
    }),
    ink: primary,
  });
  headSections.push({
    bitmap: edgeProbeSection(widthDots, 'right', {
      dotsPerStep: EDGE_PROBE_DOTS_PER_STEP,
      stepCount: probeStepCount,
    }),
    ink: primary,
  });

  // Sample text — always scale 2; scale 3 only on labels.
  headSections.push({ bitmap: textSection('TXT 2X READABLE', widthDots, 2), ink: primary });
  if (!isNarrow) {
    headSections.push({ bitmap: textSection('TXT 3X COMFORTABLE', widthDots, 3), ink: primary });
  }

  // ─── Tail sections ────────────────────────────────────────────
  const tailSections: ColouredSection[] = [];
  if (typeof spec.cutterOffsetDots === 'number' && spec.cutterOffsetDots > 0) {
    tailSections.push({
      bitmap: cutterLadderSection(widthDots, heightDots),
      ink: primary,
    });
  }
  tailSections.push({ bitmap: textSection('B', widthDots, 2), ink: primary });

  // ─── Stretchable fill ─────────────────────────────────────────
  const headHeight = sumHeightsWithGaps(headSections);
  const tailHeight = sumHeightsWithGaps(tailSections);
  const fillHeight = computeFillHeight(headHeight, tailHeight, heightDots);
  const fillSections = buildFillBands(widthDots, fillHeight, palette);

  // ─── Compose ──────────────────────────────────────────────────
  const allSections: ColouredSection[] = [...headSections, ...fillSections, ...tailSections];
  const rgba = composeRgba(widthDots, allSections, primary);
  return rgba;
}

/** A bitmap whose set bits should be painted with the given ink. */
interface ColouredSection {
  bitmap: LabelBitmap;
  ink: PaletteEntry;
}

function entryHasRgb(entry: PaletteEntry): boolean {
  return Array.isArray(entry.rgb) && entry.rgb.length === 3;
}

/**
 * Render a short text string into a width-bounded bitmap. Lines wider
 * than the print area are cropped on the right (the renderer doesn't try
 * to wrap — keep strings short).
 */
function textSection(text: string, widthDots: number, scale: number): LabelBitmap {
  const rendered = renderText(text, { scaleX: scale, scaleY: scale });
  if (rendered.widthPx <= widthDots) {
    return padBitmap(rendered, { right: widthDots - rendered.widthPx });
  }
  return cropToWidth(rendered, widthDots);
}

/**
 * Cutter-offset ladder. Bars step inward from the centre every
 * `CUTTER_PROBE_STEP_DOTS`, ladder-height capped at
 * `CUTTER_LADDER_MAX_HEIGHT_PX` (or `heightDots / 8` if smaller — keeps
 * the ladder proportional on short labels).
 *
 * The ladder lives at the bottom of the bitmap; the operator reads which
 * bar survived the cut to learn the actual head-to-cutter offset.
 */
function cutterLadderSection(widthDots: number, heightDots: number): LabelBitmap {
  const targetHeight = Math.min(CUTTER_LADDER_MAX_HEIGHT_PX, Math.floor(heightDots / 8));
  const stepCount = Math.max(4, Math.floor(targetHeight / CUTTER_PROBE_STEP_DOTS));
  const heightPx = stepCount * CUTTER_PROBE_STEP_DOTS;
  const bitmap = createBitmap(widthDots, heightPx);
  const bytesPerLine = bytesPerRow(widthDots);
  const barStart = Math.floor((widthDots * 3) / 8);
  const barEnd = Math.floor((widthDots * 5) / 8);

  for (let step = 0; step < stepCount; step += 1) {
    const baseY = heightPx - (step + 1) * CUTTER_PROBE_STEP_DOTS;
    for (let r = 0; r < CUTTER_PROBE_STEP_HEIGHT_PX; r += 1) {
      const y = baseY + r;
      if (y < 0 || y >= heightPx) continue;
      for (let x = barStart; x < barEnd; x += 1) {
        const byteIdx = y * bytesPerLine + (x >> 3);
        bitmap.data[byteIdx] = (bitmap.data[byteIdx] ?? 0) | (1 << (7 - (x & 7)));
      }
    }
  }
  return bitmap;
}

/**
 * Build the fill region as one or more horizontal bands. Single-colour
 * → one band painted in primary. Multi-ink → one band per palette entry,
 * stacked top → bottom in palette order.
 */
function buildFillBands(
  widthDots: number,
  totalHeight: number,
  palette: readonly PaletteEntry[],
): ColouredSection[] {
  if (totalHeight <= 0) return [];
  const inks = palette.length >= 2 ? palette : [palette[0] ?? { name: 'black', rgb: [0, 0, 0] }];
  const bandCount = inks.length;
  const baseBand = Math.floor(totalHeight / bandCount);
  const remainder = totalHeight - baseBand * bandCount;
  const sections: ColouredSection[] = [];
  for (let i = 0; i < bandCount; i += 1) {
    // Distribute the rounding remainder across the first few bands so
    // the bands sum to exactly `totalHeight` regardless of palette size.
    const bandHeight = baseBand + (i < remainder ? 1 : 0);
    if (bandHeight <= 0) continue;
    sections.push({
      bitmap: diagonalStripes(widthDots, bandHeight),
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bounded by inks.length
      ink: inks[i]!,
    });
  }
  return sections;
}

/** Sum of section heights plus inter-section gaps. */
function sumHeightsWithGaps(sections: readonly ColouredSection[]): number {
  if (sections.length === 0) return 0;
  const sectionsHeight = sections.reduce((acc, s) => acc + s.bitmap.heightPx, 0);
  const gapsHeight = ROW_GAP_PX * (sections.length - 1);
  return sectionsHeight + gapsHeight;
}

/**
 * Pick the fill-region height. Stretches to consume the available feed
 * length on long labels; falls back to `MIN_FILL_HEIGHT_PX` when
 * head/tail already overflow the budget. `ROW_GAP_PX × 2` accounts for
 * the gaps between the fill region and its head / tail neighbours.
 */
function computeFillHeight(headHeight: number, tailHeight: number, heightDots: number): number {
  const remaining = heightDots - headHeight - tailHeight - ROW_GAP_PX * 2;
  return remaining > MIN_FILL_HEIGHT_PX ? remaining : MIN_FILL_HEIGHT_PX;
}

/**
 * Compose all sections (head + fill + tail) into a single RGBA buffer.
 * Each section's set bits are painted with its `ink.rgb`; cleared bits
 * stay white. Sections are stacked vertically with `ROW_GAP_PX` of white
 * gap between them, then the result is top-padded with white if the
 * stack is shorter than `heightDots` so a slight-misalignment cut
 * doesn't bias the trailing edge.
 */
function composeRgba(
  widthDots: number,
  sections: readonly ColouredSection[],
  fallbackInk: PaletteEntry,
): RawImageData {
  // Stack each ink-tagged bitmap with white gap rows between them.
  const stackedBitmaps: LabelBitmap[] = [];
  const stackedInks: PaletteEntry[] = [];
  for (let i = 0; i < sections.length; i += 1) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bounded by length
    const section = sections[i]!;
    stackedBitmaps.push(section.bitmap);
    stackedInks.push(section.ink);
    if (i < sections.length - 1) {
      stackedBitmaps.push(createBitmap(widthDots, ROW_GAP_PX));
      stackedInks.push(fallbackInk); // gap rows have no set bits, ink is irrelevant
    }
  }

  const totalHeight = stackedBitmaps.reduce((acc, b) => acc + b.heightPx, 0);
  const heightPx = Math.max(MIN_FILL_HEIGHT_PX, totalHeight);
  const data = new Uint8Array(widthDots * heightPx * 4);

  // Initialise to opaque white.
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }

  // Paint each stacked bitmap row-by-row at its accumulated y offset
  // with its ink colour.
  let yOffset = 0;
  for (let i = 0; i < stackedBitmaps.length; i += 1) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bounded by length
    const bitmap = stackedBitmaps[i]!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bounded by length
    const ink = stackedInks[i]!;
    const [r, g, b] = ink.rgb;
    paintBitmap(data, widthDots, bitmap, yOffset, r, g, b);
    yOffset += bitmap.heightPx;
  }

  return { width: widthDots, height: heightPx, data };
}

/**
 * Set RGBA pixels in `dest` at the bitmap's set bits, painting them with
 * the given ink. White (cleared bits) untouched — they were initialised
 * to opaque white at allocation.
 */
function paintBitmap(
  dest: Uint8Array,
  widthPx: number,
  bitmap: LabelBitmap,
  yOffset: number,
  r: number,
  g: number,
  b: number,
): void {
  const bpr = bytesPerRow(bitmap.widthPx);
  const drawWidth = Math.min(widthPx, bitmap.widthPx);
  for (let y = 0; y < bitmap.heightPx; y += 1) {
    for (let x = 0; x < drawWidth; x += 1) {
      const byte = bitmap.data[y * bpr + (x >> 3)] ?? 0;
      const bit = (byte >> (7 - (x & 7))) & 1;
      if (bit !== 1) continue;
      const idx = ((yOffset + y) * widthPx + x) * 4;
      dest[idx] = r;
      dest[idx + 1] = g;
      dest[idx + 2] = b;
      dest[idx + 3] = 255;
    }
  }
}
