/**
 * Multi-engine dispatch for the labelwriter harness.
 *
 * Twin Turbo (`LW_TWIN_TURBO`, `LW_450_TWIN_TURBO`) and Duo
 * (`LW_450_DUO`, `LW_DUO_96`, `LW_DUO_128`) declare more than one
 * `PrintEngine` on a single chassis. Twin shares one transport with
 * in-band roll-select; Duo splits engines across two USB interfaces
 * with two protocols (`lw-450` paper + `d1-tape`). Both harness
 * runtimes (`apps/verify-cli/` and `apps/harness-labelwriter/`) need to
 * route a print to the right encoder pair + transport per the active
 * engine — that routing logic lives here so the call sites stay thin.
 *
 * What this module provides:
 *
 *   - `dispatchEncoder(engine)` — returns a `{ buildDiagnosticBitmap,
 *     encodeBitmap }` pair scoped to `engine.protocol`. `lw-450` /
 *     `lw-550` go through `harness-core/labelwriter`; `d1-tape` goes
 *     through `harness-core/labelmanager` (same encoder the standalone
 *     LabelManager harness uses — Duo's tape head is electrically a
 *     LabelManager).
 *
 *   - `roleSelectPrefix(engine)` — returns the `ESC q <addr>` byte
 *     sequence Twin needs to prepend to a print job for in-band
 *     roll-select, derived from `engine.bind.address`. Returns `null`
 *     for engines without an address byte (Duo's interface-routed
 *     engines, single-engine devices). Roll-select is generated
 *     harness-side because `lw-450` callers without a Twin shouldn't
 *     have to carry the prefix; the bytes are exactly the same as the
 *     ones `labelwriter-core/protocol`'s `buildSelectRoll` emits when
 *     the encoder is given an explicit `engine` option, but adding it
 *     here keeps the harness's Duo path (which uses interface routing,
 *     no `ESC q`) clean.
 *
 * The Twin `ESC q` byte values are stored on `engine.bind.address` in
 * the labelwriter device registry (LW_TWIN_TURBO.json5 and
 * LW_450_TWIN_TURBO.json5: `0x31` for left, `0x32` for right — ASCII
 * '1' / '2', per LW 450 Series Tech Ref p.16). Bench-confirmed against
 * the labelwriter-core protocol tests; pending live-Twin confirmation.
 */
import { padBitmap, type LabelBitmap } from '@mbtech-nl/bitmap';
import type { PrintableArea, PrintEngine } from '@thermal-label/contracts';
import {
  buildDiagnosticBitmap as buildLabelwriterBitmap,
  encodeBitmap as encodeLabelwriterBitmap,
} from './diagnostic-print.js';
import {
  buildDiagnosticBitmap as buildLabelmanagerBitmap,
  encodeBitmap as encodeLabelmanagerBitmap,
} from '../labelmanager/diagnostic-print.js';

/**
 * **PoC bench-tuning bands** for d1-tape on oversize heads (Duo 128).
 * The standalone LM has a 64-dot head; 12mm tape uses all 64. The Duo
 * 128 has a 128-dot head, but a 12mm tape physically only covers part
 * of that head — the rest of the dots fire off-tape. Without this
 * band-table the d1-core encoder's `scaleBitmap` stretches the
 * authored 64-dot content to 128, doubling the visual size and
 * pushing half off the tape edge.
 *
 * Round 1 numbers: 12 → 64, 19 → 96, 24 → 128 (looked roughly right).
 * Round 2: try 12 → 96 to double-check whether 64 was undersized.
 * Bench-confirm by printing on each tape width; revise if wrong.
 *
 * This is a poc-stage workaround. Long-term the band table belongs
 * on `engine.printableDotsByTapeWidth` in d1-core / labelwriter /
 * labelmanager registries — schema change is queued.
 */
const TAPE_BANDS_FOR_HEAD_DOTS_128: Record<number, number> = {
  6: 32,
  9: 48,
  12: 96,
  19: 96,
  24: 128,
};
import type {
  LabelWriterDevice,
  LabelWriterMedia,
  LabelWriterTapeMedia,
} from '@thermal-label/labelwriter-core';
import type { LabelManagerDevice, LabelManagerMedia } from '@thermal-label/labelmanager-core';

/**
 * `ESC q` (roll-select) wire prefix for Twin-style devices. The byte
 * comes from the engine's stored `bind.address` (`0x31` for left,
 * `0x32` for right on the Twin Turbo). Returns `null` when the engine
 * has no in-band address (Duo's interface-routed engines, single-
 * engine devices).
 */
export function roleSelectPrefix(engine: PrintEngine): Uint8Array | null {
  const address = engine.bind?.address;
  if (address === undefined) return null;
  // `ESC q <byte>` per LW 450 Series Tech Ref p.16. Same wire bytes
  // labelwriter-core's `buildSelectRoll` emits when the encoder is
  // handed an explicit `engine` option; we generate the prefix here so
  // the harness's encoder dispatch can prepend it without going
  // through the protocol module's option threading.
  return new Uint8Array([0x1b, 0x71, address]);
}

/**
 * Common shape returned by `dispatchEncoder` for both label and tape
 * engines. The browser + CLI paths read `authored` (preview), `wire`
 * (bytes the printer sees), `printableArea` and `forcedTrailingFeedMm`
 * (overlay rendering) regardless of which encoder produced them.
 */
export interface MultiEngineBitmapResult {
  authored: LabelBitmap;
  wire: LabelBitmap;
  printableArea: PrintableArea;
  forcedTrailingFeedMm: number;
}

/**
 * Inputs the dispatch helper consumes. `device` is the full
 * `LabelWriterDevice` so the labelwriter encoder pair can read its
 * registry-resolved geometry; the tape branch pulls `device.key` for
 * the diagnostic header and ignores the rest of the LW shape.
 */
export interface DispatchInput {
  device: LabelWriterDevice;
  engine: PrintEngine;
  /**
   * The selected media for this engine. Must be a `LabelWriterMedia`
   * for `lw-450` / `lw-550` engines and a `LabelWriterTapeMedia` for
   * `d1-tape` engines. The dispatch helper narrows at runtime per
   * `engine.protocol`.
   */
  media: LabelWriterMedia | LabelWriterTapeMedia;
  harnessVersion: string;
  driverVersion: string;
}

/**
 * Encoder pair returned by `dispatchEncoder`. The shape mirrors the
 * single-protocol encoders in `harness-core/labelwriter` and
 * `harness-core/labelmanager`; the dispatch normalises the call site so
 * `PrintSection` / `verify.ts` don't carry a protocol switch of their
 * own.
 */
export interface DispatchedEncoder {
  buildBitmap(): MultiEngineBitmapResult;
  /**
   * Encode the (already-built) wire bitmap to printer-ready bytes,
   * with the Twin roll-select `ESC q` prefix prepended when the engine
   * carries one. Pass `result.wire` from `buildBitmap()`.
   *
   * `labelLengthDots` is the LW-only label-pitch override for
   * form-feed/cut sequencing — pass `result.authored.heightPx` for
   * label engines; ignored on `d1-tape`.
   */
  encodeBitmap(bitmap: LabelBitmap, labelLengthDots?: number): Uint8Array;
}

/**
 * Dispatch to the right encoder pair for `engine.protocol`.
 *
 *   - `lw-450` / `lw-550` → `harness-core/labelwriter`
 *   - `d1-tape`           → `harness-core/labelmanager`
 *
 * The returned `encodeBitmap` prepends the engine's roll-select prefix
 * when applicable (Twin's `ESC q <addr>`); single-engine devices and
 * Duo's interface-routed engines get a no-op prefix.
 */
export function dispatchEncoder(input: DispatchInput): DispatchedEncoder {
  const { device, engine, media, harnessVersion, driverVersion } = input;
  const prefix = roleSelectPrefix(engine);

  if (engine.protocol === 'd1-tape') {
    const tapeMedia = media as LabelWriterTapeMedia;
    if ((tapeMedia as { type?: string }).type !== 'tape') {
      throw new Error(
        `Engine "${engine.role}" speaks d1-tape but the selected media is not a tape ` +
          `cassette (got type "${String((media as { type?: string }).type)}").`,
      );
    }
    return {
      buildBitmap(): MultiEngineBitmapResult {
        // The LM bitmap-builder's `device` argument is only used for
        // its `key` (printed in the header). Adapt the LW Duo's
        // device into a structurally-compatible shape — TS narrows on
        // `family: 'labelmanager'` so we cast through `unknown`. The
        // alternative (refactoring LM to take a generic device shape)
        // touches the parallel agent's territory.
        const lmDeviceShim = {
          ...device,
          family: 'labelmanager' as const,
        } as unknown as LabelManagerDevice;
        // `LabelWriterTapeMedia` extends `D1Media`; `LabelManagerMedia`
        // is a narrower D1Media variant. Both carry `tapeWidthMm`,
        // `text`, `background`, etc. — structurally compatible for the
        // diagnostic-bitmap builder.
        const lmMediaShim = tapeMedia as unknown as LabelManagerMedia;
        // PoC: on oversize heads (Duo 128) running narrow tapes,
        // author at the chassis-specific band (Duo 128 + 12mm tape:
        // 96 dots, NOT the LM standalone 64-dot bucket). Then pad
        // centred to engine.headDots so the d1-core encoder's
        // `scaleBitmap` is a no-op — content lands at its real
        // pixel size centred under the head, aligned with the tape.
        const headDotsOverride = bandFor(engine, tapeMedia.tapeWidthMm);
        const result = buildLabelmanagerBitmap({
          device: lmDeviceShim,
          media: lmMediaShim,
          harnessVersion,
          driverVersion,
          ...(headDotsOverride === undefined ? {} : { headDotsOverride }),
        });
        return padTapeBitmapForOversizeHead(result, engine);
      },
      encodeBitmap(bitmap): Uint8Array {
        // `labelLengthDots` is the LW-only label-pitch override; the
        // d1-tape encoder pads its own trailing rows internally and
        // doesn't take a label-length argument.
        //
        // **Shim `printableDots` to engine.headDots** on oversize
        // heads. The shared D1 media catalogue carries
        // `printableDots: 64` (correct for LM standalone's 64-dot
        // head). On Duo 128, that constraint causes d1-core's
        // `resolveRasterDots` to clamp the wire to 64 dots — the
        // encoder emits ESC D 8 instead of ESC D 16, fires 64 head
        // dots starting from col 0 (left-aligned), and the centred
        // tape physically catches only the right half of that
        // 64-dot raster. With the shim, the wire emits at the full
        // head width and our centred-pad places content at cols
        // 16-111 of 128 — aligned with the centred-on-head tape.
        const baseShim = tapeMedia as unknown as LabelManagerMedia;
        const lmMediaShim: LabelManagerMedia =
          engine.headDots > 64 ? { ...baseShim, printableDots: engine.headDots } : baseShim;
        const body = encodeLabelmanagerBitmap(bitmap, engine, lmMediaShim);
        return prepend(prefix, body);
      },
    };
  }

  // Default branch: `lw-450` / `lw-550` (and any future LW protocol).
  // The labelwriter encoder pair already handles both 450 and 550 via
  // its own internal switch.
  const lwMedia = media as LabelWriterMedia;
  return {
    buildBitmap(): MultiEngineBitmapResult {
      return buildLabelwriterBitmap({
        device,
        media: lwMedia,
        harnessVersion,
        driverVersion,
      });
    },
    encodeBitmap(bitmap, labelLengthDots): Uint8Array {
      const body = encodeLabelwriterBitmap(bitmap, device, labelLengthDots);
      return prepend(prefix, body);
    },
  };
}

function prepend(prefix: Uint8Array | null, body: Uint8Array): Uint8Array {
  if (!prefix || prefix.length === 0) return body;
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

/**
 * Look up the authored bitmap width in dots for an oversize-head
 * d1-tape engine. Returns the band value when the engine is on a
 * 128-dot chassis (Duo 128); returns undefined for standard 64-dot
 * heads (LM standalone) so the LM diagnostic-print falls back to
 * its own HEAD_DOTS_FOR_TAPE bucket.
 */
function bandFor(engine: PrintEngine, tapeWidthMm: number): number | undefined {
  if (engine.headDots !== 128) return undefined;
  return TAPE_BANDS_FOR_HEAD_DOTS_128[tapeWidthMm];
}

/**
 * Pad authored + wire bitmaps centred to `engine.headDots` for
 * oversize-head d1-tape engines (Duo 128). The authored bitmap was
 * already built at the chassis-specific band by passing
 * `headDotsOverride` into `buildLabelmanagerBitmap`; the pad here
 * just centres that band-width content into the head's full dot
 * count so the d1-core encoder's `scaleBitmap` is a no-op (no
 * stretching). No-op on standard 64-dot heads (LM standalone) where
 * authored already matches headDots.
 */
function padTapeBitmapForOversizeHead(
  result: MultiEngineBitmapResult,
  engine: PrintEngine,
): MultiEngineBitmapResult {
  const padToHeadDots = (b: LabelBitmap): LabelBitmap => {
    if (b.widthPx >= engine.headDots) return b;
    const total = engine.headDots - b.widthPx;
    const left = Math.floor(total / 2);
    const right = total - left;
    return padBitmap(b, { left, right });
  };
  return {
    ...result,
    authored: padToHeadDots(result.authored),
    wire: padToHeadDots(result.wire),
  };
}
