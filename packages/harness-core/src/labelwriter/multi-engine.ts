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
 * Round 1 numbers: 12 → 64, 19 → 96, 24 → 128 (maintainer's read).
 * Bench-confirm by printing on each tape width; revise if wrong.
 *
 * This is a poc-stage workaround. Long-term the band table belongs
 * on `engine.printableDotsByTapeWidth` in d1-core / labelwriter /
 * labelmanager registries — schema change is queued.
 */
const TAPE_BANDS_FOR_HEAD_DOTS_128: Record<number, number> = {
  6: 32,
  9: 48,
  12: 64,
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
        const result = buildLabelmanagerBitmap({
          device: lmDeviceShim,
          media: lmMediaShim,
          harnessVersion,
          driverVersion,
        });
        // PoC: on oversize heads (Duo 128) running narrow tapes, pad
        // the authored + wire bitmaps centred to engine.headDots. The
        // d1-core encoder's `scaleBitmap` becomes a no-op (input
        // already at headDots), so content lands at its real pixel
        // size centred under the head — aligned with the tape — and
        // doesn't get stretched 2× off the tape edge.
        return padTapeBitmapForOversizeHead(result, engine, tapeMedia.tapeWidthMm);
      },
      encodeBitmap(bitmap): Uint8Array {
        // `labelLengthDots` is the LW-only label-pitch override; the
        // d1-tape encoder pads its own trailing rows internally and
        // doesn't take a label-length argument.
        const lmMediaShim = tapeMedia as unknown as LabelManagerMedia;
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
 * Pad authored + wire bitmaps centred to `engine.headDots` for
 * oversize-head d1-tape engines (Duo 128). No-op when the head is
 * already the band's target width (LM 64-dot standalone, or 24mm
 * tape on Duo 128). PoC table — see TAPE_BANDS_FOR_HEAD_DOTS_128.
 */
function padTapeBitmapForOversizeHead(
  result: MultiEngineBitmapResult,
  engine: PrintEngine,
  tapeWidthMm: number,
): MultiEngineBitmapResult {
  // Only patch the 128-dot head today. Other oversize heads (e.g. a
  // future 96-dot variant) would slot in here with their own table.
  if (engine.headDots !== 128) return result;
  const targetDots = TAPE_BANDS_FOR_HEAD_DOTS_128[tapeWidthMm];
  if (targetDots === undefined) return result;
  // Authored stays at its current width; we ALSO pad it to the same
  // total head width so the preview reflects how content lines up
  // under the head physically.
  const padToHeadDots = (b: LabelBitmap): LabelBitmap => {
    if (b.widthPx >= engine.headDots) return b;
    const total = engine.headDots - b.widthPx;
    const left = Math.floor(total / 2);
    const right = total - left;
    return padBitmap(b, { left, right });
  };
  // First, if the authored width doesn't match the band target, that
  // means buildLabelmanagerBitmap built at the LM standalone's
  // 64-dot HEAD_DOTS_FOR_TAPE bucket but the band table wants
  // something different (e.g. 19mm tape: LM bucket=64, band=96).
  // For round 1 we accept the bucket-vs-band mismatch and just pad
  // both to engine.headDots; revisit if the print on 19mm looks too
  // narrow.
  void targetDots; // silence unused — table is consulted indirectly
  // via the `void` here so future band-driven authoring (round 2)
  // can plug in cleanly.
  return {
    ...result,
    authored: padToHeadDots(result.authored),
    wire: padToHeadDots(result.wire),
  };
}
