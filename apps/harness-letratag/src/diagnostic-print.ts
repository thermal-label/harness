/**
 * Letratag diagnostic-image builder for the browser harness.
 *
 * LT-200B is single-engine, single-cassette-width (12 mm tape, 30
 * printable dots @ 200 dpi). The shared `buildDiagnosticImage` in
 * harness-core already drops the verbose header line + the scale-3
 * sample below `NARROW_WIDTH_THRESHOLD_DOTS = 128` dots, so a 30-dot
 * print gets the compact 2-line header + scale-2 sample + edge
 * probes + diagonal fill + trailing `B` marker automatically.
 *
 * No cutter-offset ladder — the LT-200B cuts on the `END` opcode
 * with no head-to-blade offset to probe (per plan 12 §Diagnostic
 * image — 30 dots wide). Single-ink (every cassette carries one
 * ribbon colour) — no palette branch needed.
 *
 * Returns RGBA so the driver's threshold + chunking pipeline runs
 * end-to-end. The harness is a fidelity test, not a bypass.
 */
import type { RawImageData } from '@thermal-label/contracts';
import type { LetraTagDevice, LetraTagMedia } from '@thermal-label/letratag-core';
import { buildDiagnosticImage as buildShared } from '@thermal-label/harness-core/shared';

export interface DiagnosticPrintInput {
  device: LetraTagDevice;
  media: LetraTagMedia;
  harnessVersion: string;
  driverVersion: string;
}

/**
 * Feed length on tape, in mm. ~50 mm gives the diagnostic room to
 * land the header, two edge probes, sample text, a diagonal fill,
 * and the trailing marker without consuming excessive tape. Plan 12
 * flags photo-triage of a 4 mm × 50 mm strip as harder than wider
 * sibling outputs — operators should photograph close-up. Not
 * something to compensate for here.
 */
const TAPE_DEFAULT_MM = 50;

export function buildDiagnosticImage(input: DiagnosticPrintInput): RawImageData {
  const engine = input.device.engines[0];
  // LT-200B engine declares `headDots: 30` and `dpi: 200` — fall
  // back defensively so a future registry edit doesn't crash.
  const headDots = engine?.headDots ?? 30;
  const dpi = engine?.dpi ?? 200;
  // Every LT cassette is 12 mm with `printableDots: 30` — read it
  // off the media descriptor so we honour any future edge-case
  // narrowing (e.g. iron-on cassettes that print fewer rows).
  const widthDots = Math.min(input.media.printableDots, headDots);
  return buildShared({
    widthDots,
    heightDots: Math.round((TAPE_DEFAULT_MM * dpi) / 25.4),
    harnessVersion: input.harnessVersion,
    driverVersion: input.driverVersion,
    driverKey: 'letratag',
    deviceKey: input.device.key,
    mediaId: String(input.media.id),
  });
}
