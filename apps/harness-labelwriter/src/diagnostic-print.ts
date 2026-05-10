/**
 * LabelWriter diagnostic-image builder for the browser harness.
 *
 * Handles `lw-450`, `lw-550`, and `d1-tape` (Duo's tape engine,
 * electrically a LabelManager) through the same shared
 * `buildDiagnosticImage`. LW family uses a tear-bar, not autocut, so no
 * cutter ladder for either engine type. RGBA out — driver does its own
 * threshold/dither + the LW "send fewer rows" leading-edge skip.
 */
import type { PrintEngine, RawImageData } from '@thermal-label/contracts';
import type {
  LabelWriterAnyMedia,
  LabelWriterDevice,
  LabelWriterMedia,
  LabelWriterTapeMedia,
} from '@thermal-label/labelwriter-core';
import { buildDiagnosticImage as buildShared } from '@thermal-label/harness-core/shared';

export interface DiagnosticImageInput {
  device: LabelWriterDevice;
  engine: PrintEngine;
  media: LabelWriterAnyMedia;
  harnessVersion: string;
  driverVersion: string;
}

/** Diagnostic feed length, mm, for engines/media without a fixed length. */
const TAPE_DEFAULT_MM = 35;
const CONTINUOUS_LABEL_DEFAULT_MM = 100;
const TAPE_FALLBACK: Record<number, number> = { 6: 32, 9: 48, 12: 64, 19: 96, 24: 128 };
const mmToDots = (mm: number, dpi: number): number => Math.round((mm * dpi) / 25.4);

export function buildDiagnosticImage(input: DiagnosticImageInput): RawImageData {
  const headDots = input.engine.headDots;
  const dpi = input.engine.dpi;
  const m = input.media;
  let widthDots: number;
  let heightDots: number;
  if (input.engine.protocol === 'd1-tape') {
    const tape = m as LabelWriterTapeMedia;
    widthDots = Math.min(tape.printableDots ?? TAPE_FALLBACK[tape.tapeWidthMm] ?? headDots, headDots);
    // 180 dpi engine — anchor the diagnostic feed length in mm so a
    // 1200-dot fixed default doesn't burn 169 mm of cassette per print.
    heightDots = mmToDots(TAPE_DEFAULT_MM, dpi);
  } else {
    const lbl = m as LabelWriterMedia;
    widthDots = Math.min(mmToDots(lbl.widthMm, dpi), headDots);
    heightDots =
      lbl.lengthDots ??
      (lbl.heightMm !== undefined ? mmToDots(lbl.heightMm, dpi) : mmToDots(CONTINUOUS_LABEL_DEFAULT_MM, dpi));
  }
  return buildShared({
    widthDots,
    heightDots,
    harnessVersion: input.harnessVersion,
    driverVersion: input.driverVersion,
    driverKey: 'labelwriter',
    deviceKey: input.device.key,
    mediaId: String(m.id),
  });
}

// Re-export for type-narrowing convenience in the adapter.
export type { LabelWriterTapeMedia };
