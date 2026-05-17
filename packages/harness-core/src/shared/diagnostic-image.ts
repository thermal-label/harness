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
 * The builder honours `heightDots` as a STRICT ceiling: the output RGBA
 * height is always ≤ `heightDots`. Sections never overflow onto a second
 * physical label. On printers with short die-cut stock (a Niimbot B1
 * with 50×30 mm stickers ≈ 240 dots tall) the full layout doesn't fit,
 * so lower-priority sections are dropped until the rest fits the budget.
 *
 * Section verbosity is no longer width-driven by a hard threshold. Every
 * candidate section carries a {@link SectionTier} priority; the builder
 * drops the lowest tier first until the stack fits `heightDots`. Narrow
 * stock keeps fewer sections simply because wide-only sections (scale-3
 * sample, second edge probe) cost feed length that a short budget can't
 * spare — the *mechanism* is uniform, no `widthDots < N` branch.
 *
 * Priority tiers:
 *   - `required` — never dropped: `TOP>` marker, `B` marker, the
 *     `deviceKey` header line.
 *   - `preferred` — dropped only after every `optional` is gone: the
 *     `mediaId` header line, the left edge probe, the `TXT 2X` sample,
 *     and the cutter-offset ladder *when `cutterOffsetDots` was supplied*
 *     (the caller explicitly asked for it). Multi-ink fill is also
 *     `preferred` — see below.
 *   - `optional` — dropped first: the version-info header line, the
 *     right edge probe, the `TXT 3X` sample.
 *
 * Order, top → bottom:
 *   1. Header block — version line (optional), deviceKey (required),
 *      mediaId (preferred)
 *   2. `TOP>` orientation marker (scale 2, required)
 *   3. Left edge probe (preferred) / right edge probe (optional)
 *   4. `TXT 2X READABLE` sample (preferred)
 *   5. `TXT 3X COMFORTABLE` sample (optional)
 *   6. **Stretchable fill** — diagonal stripes; consumes whatever feed
 *      length is left between the last kept head section and the tail.
 *      Fill can shrink to 0 (omitted) if nothing is left. Single-ink
 *      fill is elastic / `optional`-grade; **multi-ink fill** is
 *      `preferred` — it's the only place each ink is verified, so it
 *      survives until the budget genuinely can't hold it.
 *   7. Cutter-offset ladder — only when `cutterOffsetDots` is supplied;
 *      `preferred` tier. Bars step inward every 8 dots, ladder-height
 *      = `min(192, heightDots / 8)`.
 *   8. `B` trailing orientation marker (scale 2, required).
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
   * Feed-direction target height in dots, treated as a STRICT ceiling:
   * the output RGBA height is always ≤ this value. Lower-priority
   * sections are dropped until the stack fits; the fill region then
   * stretches to consume whatever feed is left.
   *
   * Optional: omit it for continuous stock (tape / continuous roll —
   * no per-page boundary). When omitted the builder substitutes
   * `DEFAULT_CONTINUOUS_HEIGHT_DOTS`, a generous fixed budget that the
   * priority pipeline rarely needs to trim.
   */
  heightDots?: number;
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
/**
 * Smallest non-zero fill-band height. A fill region thinner than this
 * doesn't render — when less than `MIN_FILL_HEIGHT_PX` of leftover feed
 * is available, the fill is omitted entirely (height 0). It is no longer
 * a floor that forces the layout to overflow `heightDots`.
 */
const MIN_FILL_HEIGHT_PX = 16;
/**
 * Feed budget for continuous stock — substituted when `spec.heightDots`
 * is undefined (tape / continuous roll with no per-page boundary). A
 * fixed dot constant by design: the builder never needs physical
 * mm / dpi. Generous enough that the priority pipeline rarely trims.
 */
const DEFAULT_CONTINUOUS_HEIGHT_DOTS = 420;
/** Edge-probe step count, dimensioned to the head's reach. */
const EDGE_PROBE_DOTS_PER_STEP = 4;
/** Cutter-offset ladder bar pitch (dots between bars). */
const CUTTER_PROBE_STEP_DOTS = 8;
/** Cutter-offset ladder bar thickness (rows). */
const CUTTER_PROBE_STEP_HEIGHT_PX = 2;
/** Maximum cutter-offset ladder height; on short labels it shrinks proportionally. */
const CUTTER_LADDER_MAX_HEIGHT_PX = 192;

/**
 * Section priority tier. The builder drops `optional` sections first,
 * then `preferred`; `required` sections are never dropped (see the
 * "required set doesn't fit" note in {@link buildDiagnosticImage}).
 */
type SectionTier = 'required' | 'preferred' | 'optional';

/**
 * A candidate section: an ink-tagged bitmap plus its priority tier and a
 * stable `order` key. `order` fixes the top→bottom stacking position so
 * a section keeps its place regardless of which neighbours got dropped.
 */
interface CandidateSection {
  bitmap: LabelBitmap;
  ink: PaletteEntry;
  tier: SectionTier;
  /** Top→bottom stacking key (lower = higher up the print). */
  order: number;
}

/**
 * Build the diagnostic image for a driver harness. RGBA out — driver
 * does threshold/dither.
 */
export function buildDiagnosticImage(spec: DiagnosticImageSpec): RawImageData {
  const widthDots = Math.max(8, Math.floor(spec.widthDots));
  // heightDots is a strict ceiling; undefined → continuous-stock default.
  const heightDots = Math.max(
    MIN_FILL_HEIGHT_PX,
    Math.floor(spec.heightDots ?? DEFAULT_CONTINUOUS_HEIGHT_DOTS),
  );
  const palette = (spec.palette ?? []).filter(entryHasRgb);
  const isMultiInk = palette.length >= 2;

  const primary: PaletteEntry = palette[0] ?? { name: 'black', rgb: [0, 0, 0] };
  const secondary: PaletteEntry = palette[1] ?? primary;
  const headerInk = isMultiInk ? secondary : primary;

  // ─── Candidate head sections (everything above the fill) ──────────
  // Each is tagged with a priority tier; the drop pass below removes
  // the lowest tier first until the stack fits `heightDots`. `order`
  // pins the top→bottom position so survivors keep their layout slot.
  const candidates: CandidateSection[] = [];

  // Header block — version line is `optional`, deviceKey `required`,
  // mediaId `preferred`. The version line costs feed for marginal
  // value on tight stock, so it goes first.
  candidates.push({
    bitmap: textSection(
      `v${spec.harnessVersion} ${spec.driverKey} ${spec.driverVersion}`,
      widthDots,
      2,
    ),
    ink: headerInk,
    tier: 'optional',
    order: 0,
  });
  candidates.push({
    bitmap: textSection(spec.deviceKey, widthDots, 2),
    ink: headerInk,
    tier: 'required',
    order: 1,
  });
  candidates.push({
    bitmap: textSection(spec.mediaId.toUpperCase(), widthDots, 2),
    ink: headerInk,
    tier: 'preferred',
    order: 2,
  });

  // Orientation marker — required, anchors the leading edge.
  candidates.push({
    bitmap: textSection('TOP>', widthDots, 2),
    ink: primary,
    tier: 'required',
    order: 3,
  });

  // Edge probes — step count derived from width (every 4 dots), capped
  // so the ladder height stays sane on wide heads. Left probe is
  // `preferred`, right probe `optional` (one probe still reveals a
  // margin; two is the comfortable case).
  const probeStepCount = Math.max(8, Math.floor(widthDots / EDGE_PROBE_DOTS_PER_STEP));
  candidates.push({
    bitmap: edgeProbeSection(widthDots, 'left', {
      dotsPerStep: EDGE_PROBE_DOTS_PER_STEP,
      stepCount: probeStepCount,
    }),
    ink: primary,
    tier: 'preferred',
    order: 4,
  });
  candidates.push({
    bitmap: edgeProbeSection(widthDots, 'right', {
      dotsPerStep: EDGE_PROBE_DOTS_PER_STEP,
      stepCount: probeStepCount,
    }),
    ink: primary,
    tier: 'optional',
    order: 5,
  });

  // Sample text — scale-2 is `preferred`, scale-3 `optional` (scale-3
  // burns ~3 mm of feed for marginal extra value on tight stock).
  candidates.push({
    bitmap: textSection('TXT 2X READABLE', widthDots, 2),
    ink: primary,
    tier: 'preferred',
    order: 6,
  });
  candidates.push({
    bitmap: textSection('TXT 3X COMFORTABLE', widthDots, 3),
    ink: primary,
    tier: 'optional',
    order: 7,
  });

  // ─── Tail candidate: cutter-offset ladder ─────────────────────────
  // `preferred` — the caller explicitly asked for it by passing
  // `cutterOffsetDots`. The `B` marker (added below) is `required`.
  const hasCutterLadder = typeof spec.cutterOffsetDots === 'number' && spec.cutterOffsetDots > 0;
  if (hasCutterLadder) {
    candidates.push({
      bitmap: cutterLadderSection(widthDots, heightDots),
      ink: primary,
      tier: 'preferred',
      order: 8,
    });
  }
  // Trailing orientation marker — required, anchors the trailing edge.
  candidates.push({
    bitmap: textSection('B', widthDots, 2),
    ink: primary,
    tier: 'required',
    order: 9,
  });

  // ─── Priority drop pass ───────────────────────────────────────────
  // The fill region sits between the last head section and the tail;
  // it's elastic and reserves at least `MIN_FILL_HEIGHT_PX` while we
  // decide what fits. Multi-ink fill is `preferred` (the only place
  // each ink is verified); single-ink fill is elastic / `optional`.
  // We keep fill's reservation in the budget check so a non-droppable
  // multi-ink fill isn't silently squeezed out by other sections.
  const fillTier: SectionTier = isMultiInk ? 'preferred' : 'optional';
  const fillBandCount = isMultiInk ? palette.length : 1;
  const kept = dropUntilFits(candidates, heightDots, fillTier, fillBandCount);

  // ─── Size the fill from the leftover ──────────────────────────────
  // Whatever feed remains between the kept sections (plus the gaps the
  // fill introduces) becomes the fill region. Below `MIN_FILL_HEIGHT_PX`
  // of leftover → no fill at all. Multi-ink fill splits into one band
  // per ink, so it can introduce more than one extra gap.
  const keptHeight = sumHeightsWithGaps(kept);
  const fillHeight = computeFillHeight(keptHeight, kept.length, fillBandCount, heightDots);
  const fillSections = buildFillBands(widthDots, fillHeight, palette);

  // ─── Compose ──────────────────────────────────────────────────────
  // Splice the fill sections in between the last head section (orders
  // 0–7) and the tail sections (orders 8–9), preserving stack order.
  const headKept = kept.filter(s => s.order < 8);
  const tailKept = kept.filter(s => s.order >= 8);
  const ordered: CandidateSection[] = [...headKept, ...fillSections, ...tailKept];
  return composeRgba(widthDots, ordered, primary);
}

/**
 * Drop candidate sections lowest-tier-first until the stack — including
 * a `MIN_FILL_HEIGHT_PX` reservation for the elastic fill — fits
 * `heightDots`. `optional` goes before `preferred`; among one tier the
 * lowest-order (topmost) section goes first, a stable, predictable
 * choice. `required` sections are never dropped.
 *
 * Edge case — the `required` set itself doesn't fit `heightDots`: we
 * stop once only `required` sections remain and accept the (slight)
 * overflow rather than throwing. Dropping a `required` section (the
 * `TOP>`/`B` markers or the deviceKey line) would strip the operator's
 * orientation reference, which is worse than a label that runs a few
 * dots long; and a budget too small for three short text lines is a
 * caller bug the operator will see immediately. Returning the minimal
 * required set keeps the harness usable for diagnosing that bug.
 */
function dropUntilFits(
  candidates: readonly CandidateSection[],
  heightDots: number,
  fillTier: SectionTier,
  fillBandCount: number,
): CandidateSection[] {
  const kept = [...candidates].sort((a, b) => a.order - b.order);
  const dropOrder: SectionTier[] = ['optional', 'preferred'];

  for (const tier of dropOrder) {
    while (stackBudget(kept, fillTier, fillBandCount) > heightDots) {
      const idx = kept.findIndex(s => s.tier === tier);
      if (idx === -1) break; // no more sections in this tier
      kept.splice(idx, 1);
    }
    if (stackBudget(kept, fillTier, fillBandCount) <= heightDots) return kept;
  }
  // Only `required` sections (and the elastic fill reservation) remain;
  // accept the result even if it slightly overflows — see doc comment.
  return kept;
}

/**
 * Height the stack would occupy: the kept sections + inter-section gaps,
 * plus a reservation for the elastic fill. Multi-ink fill (`preferred`)
 * must survive, so we reserve `MIN_FILL_HEIGHT_PX` for it plus the
 * `fillBandCount` gaps splicing it in introduces. Single-ink fill
 * (`optional`) is elastic — it collapses to 0 before any real section
 * is dropped, so it adds nothing to the budget here.
 */
function stackBudget(
  kept: readonly CandidateSection[],
  fillTier: SectionTier,
  fillBandCount: number,
): number {
  const sectionsHeight = sumHeightsWithGaps(kept);
  if (kept.length === 0) return 0;
  if (fillTier === 'preferred') {
    // Multi-ink fill must survive — reserve it plus its splice-in gaps.
    return sectionsHeight + MIN_FILL_HEIGHT_PX + ROW_GAP_PX * fillBandCount;
  }
  // Single-ink fill is elastic: it yields before any section is dropped.
  return sectionsHeight;
}

function entryHasRgb(entry: PaletteEntry): boolean {
  return Array.isArray(entry.rgb);
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
 *
 * The returned sections are tagged with `order: 8` so they splice in
 * just above the tail (cutter ladder + `B` marker, orders 8–9); their
 * tier doesn't matter post-layout — the drop pass already ran.
 */
function buildFillBands(
  widthDots: number,
  totalHeight: number,
  palette: readonly PaletteEntry[],
): CandidateSection[] {
  if (totalHeight <= 0) return [];
  const inks = palette.length >= 2 ? palette : [palette[0] ?? { name: 'black', rgb: [0, 0, 0] }];
  const bandCount = inks.length;
  const baseBand = Math.floor(totalHeight / bandCount);
  const remainder = totalHeight - baseBand * bandCount;
  const sections: CandidateSection[] = [];
  for (let i = 0; i < bandCount; i += 1) {
    // Distribute the rounding remainder across the first few bands so
    // the bands sum to exactly `totalHeight` regardless of palette size.
    const bandHeight = baseBand + (i < remainder ? 1 : 0);
    if (bandHeight <= 0) continue;
    sections.push({
      bitmap: diagonalStripes(widthDots, bandHeight),
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- bounded by inks.length
      ink: inks[i]!,
      tier: 'preferred',
      order: 8,
    });
  }
  return sections;
}

/** Sum of section heights plus inter-section gaps. */
function sumHeightsWithGaps(sections: readonly CandidateSection[]): number {
  if (sections.length === 0) return 0;
  const sectionsHeight = sections.reduce((acc, s) => acc + s.bitmap.heightPx, 0);
  const gapsHeight = ROW_GAP_PX * (sections.length - 1);
  return sectionsHeight + gapsHeight;
}

/**
 * Pick the total fill-region height from the leftover feed. `keptHeight`
 * is the kept sections + their `(keptCount - 1)` inter-section gaps.
 * Splicing `bandCount` fill bands between head and tail adds those bands
 * plus exactly `bandCount` extra gaps to the stack (the composer puts
 * one gap between every pair of adjacent sections). Below
 * `MIN_FILL_HEIGHT_PX` of leftover → return 0 so {@link buildFillBands}
 * omits the fill entirely. This is the strict-heightDots replacement for
 * the old overflow-forcing `MIN_FILL_HEIGHT_PX` floor.
 */
function computeFillHeight(
  keptHeight: number,
  keptCount: number,
  bandCount: number,
  heightDots: number,
): number {
  if (keptCount === 0 || bandCount <= 0) return 0;
  // Inserting `bandCount` sections into a `keptCount`-section stack
  // raises the gap count from `keptCount - 1` to `keptCount + bandCount
  // - 1` — i.e. `bandCount` extra gaps.
  const remaining = heightDots - keptHeight - ROW_GAP_PX * bandCount;
  return remaining >= MIN_FILL_HEIGHT_PX ? remaining : 0;
}

/**
 * Compose all sections (head + fill + tail) into a single RGBA buffer.
 * Each section's set bits are painted with its `ink.rgb`; cleared bits
 * stay white. Sections are stacked vertically with `ROW_GAP_PX` of white
 * gap between them. The drop pass + fill sizing already guaranteed the
 * stack fits `heightDots`, so the natural stack height is the output
 * height (≤ `heightDots`); no padding or truncation here.
 */
function composeRgba(
  widthDots: number,
  sections: readonly CandidateSection[],
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
