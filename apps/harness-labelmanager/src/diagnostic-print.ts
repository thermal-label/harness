/**
 * Labelmanager diagnostic-image builder for the browser harness.
 *
 * Single-engine D1 tape device — manual cut, no autocut ladder. Width
 * comes straight from `media.printableDots` (always present in the
 * catalogue); height is a fixed feed budget that gives the diagnostic
 * room to land all sections without burning excessive tape.
 *
 * RGBA out — driver runs threshold/dither/palette-split.
 */
import type { RawImageData } from '@thermal-label/contracts';
import type { LabelManagerDevice, LabelManagerMedia } from '@thermal-label/labelmanager-core';
import { buildDiagnosticImage as buildShared } from '@thermal-label/harness-core/shared';

export interface DiagnosticPrintInput {
  device: LabelManagerDevice;
  media: LabelManagerMedia;
  harnessVersion: string;
  driverVersion: string;
}

/** Diagnostic feed length on tape, in mm. Anchored in mm and scaled
 *  by `engine.dpi` so a single fixed dot-count doesn't produce wildly
 *  different physical lengths across engines (LM_PNP is 180 dpi). */
const TAPE_DEFAULT_MM = 35;
const TAPE_WIDTH_FALLBACK_DOTS: Record<number, number> = { 6: 32, 9: 48, 12: 64, 19: 96 };

export function buildDiagnosticImage(input: DiagnosticPrintInput): RawImageData {
  const engine = input.device.engines[0];
  const headDots = engine?.headDots ?? 64;
  const dpi = engine?.dpi ?? 180;
  const fromMedia =
    typeof input.media.printableDots === 'number'
      ? input.media.printableDots
      : (TAPE_WIDTH_FALLBACK_DOTS[input.media.tapeWidthMm] ?? headDots);
  return buildShared({
    widthDots: Math.min(fromMedia, headDots),
    heightDots: Math.round((TAPE_DEFAULT_MM * dpi) / 25.4),
    harnessVersion: input.harnessVersion,
    driverVersion: input.driverVersion,
    driverKey: 'labelmanager',
    deviceKey: input.device.key,
    mediaId: String(input.media.id),
  });
}
