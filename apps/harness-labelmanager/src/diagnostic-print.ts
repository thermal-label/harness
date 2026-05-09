/**
 * Labelmanager diagnostic-image builder for the browser harness.
 *
 * Returns full-RGBA `RawImageData` so the driver's `print()` and
 * `createPreview()` run the real threshold/dither pipeline (the
 * harness is a *driver fidelity test* — it must go through the
 * driver, not bypass it).
 *
 * Composition reuses the existing 1bpp diagnostic builder in
 * `@thermal-label/harness-core/labelmanager` (still consumed by
 * verify-cli) and converts the result to RGBA via `bitmapToRgba`.
 * The driver re-quantises to 1bpp internally — that's the wire path
 * we want exercised on every run.
 */
import type { RawImageData } from '@thermal-label/contracts';
import {
  buildDiagnosticBitmap,
  type DiagnosticPrintInput,
} from '@thermal-label/harness-core/labelmanager';
import { bitmapToRgba } from '@thermal-label/harness-core/shared';

export function buildDiagnosticImage(input: DiagnosticPrintInput): RawImageData {
  const { authored } = buildDiagnosticBitmap(input);
  return bitmapToRgba(authored);
}
