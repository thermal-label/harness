/**
 * Brother-QL diagnostic-image builder for the browser harness.
 *
 * Two-color rolls flow through `media.palette` straight into the shared
 * builder; the driver's `renderMultiPlaneImage` classifies pixels into
 * the right plane. QL family auto-cuts on die-cut media — when the
 * loaded media is die-cut, we enable the cutter-offset ladder and back
 * the feed length off by `CUTTER_OFFSET_DOTS_QL` so the firmware's
 * post-print advance lands the cut in the registration gap (bench
 * observation on QL-820NWBc: ~7 mm at 300 dpi ≈ 84 dots).
 */
import type { RawImageData } from '@thermal-label/contracts';
import type {
  BrotherQLDevice,
  BrotherQLMedia,
  PrintEngine,
} from '@thermal-label/brother-ql-core';
import { buildDiagnosticImage as buildShared } from '@thermal-label/harness-core/shared';

interface DiagnosticPrintInput {
  device: BrotherQLDevice;
  engine: PrintEngine;
  media: BrotherQLMedia;
  harnessVersion: string;
  driverVersion: string;
}

const DPI = 300;
const CONTINUOUS_DEFAULT_HEIGHT_DOTS = 800;
const CUTTER_OFFSET_DOTS_QL = 84;

export function buildDiagnosticImage(input: DiagnosticPrintInput): RawImageData {
  const m = input.media;
  const family = input.engine.headDots === 128 ? 'narrow' : 'wide';
  const widthDots = m.printableDots ?? m.geometry?.[family]?.printableDots;
  if (typeof widthDots !== 'number') {
    throw new Error(
      `${m.name} has no printableDots (DK) and no geometry.${family} entry — encoder cannot resolve head-perpendicular width.`,
    );
  }
  const isDieCut = m.type === 'die-cut';
  const rawHeight =
    m.dieCutMaskedAreaDots ?? (m.heightMm !== undefined ? Math.round((m.heightMm * DPI) / 25.4) : undefined);
  const heightDots = rawHeight !== undefined
    ? Math.max(16, rawHeight - (isDieCut ? CUTTER_OFFSET_DOTS_QL : 0))
    : CONTINUOUS_DEFAULT_HEIGHT_DOTS;
  return buildShared({
    widthDots,
    heightDots,
    ...(m.palette ? { palette: m.palette } : {}),
    ...(isDieCut ? { cutterOffsetDots: CUTTER_OFFSET_DOTS_QL } : {}),
    harnessVersion: input.harnessVersion,
    driverVersion: input.driverVersion,
    driverKey: 'brother-ql',
    deviceKey: input.device.key,
    mediaId: String(m.id),
  });
}
