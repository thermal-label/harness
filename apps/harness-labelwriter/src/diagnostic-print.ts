/**
 * LabelWriter diagnostic-image builder for the browser harness.
 *
 * Returns full-RGBA `RawImageData` so the driver's `print()` runs the
 * real threshold/dither pipeline. Multi-engine devices (Twin Turbo,
 * 450 Duo) dispatch the bitmap encoder by `engine.protocol`:
 *
 *   - `lw-450` / `lw-550` → `harness-core/labelwriter` builder
 *   - `d1-tape`           → `harness-core/labelmanager` builder
 *     (Duo's tape head is electrically a LabelManager)
 *
 * The wire transforms (Twin's `ESC q` roll-select prefix, the LW
 * "send fewer rows" leading-edge trim, the LM ESC-C tape-type byte)
 * are NO LONGER applied here — the driver-web `print()` does them
 * end-to-end. The harness contributes the authored content only.
 *
 * `engine` arg drives encoder choice and (on multi-engine devices)
 * is also passed through to `printer.print(rgba, media, { engine: …
 * })` by the shell so the driver routes to the correct interface.
 */
import type { PrintEngine, RawImageData } from '@thermal-label/contracts';
import { buildDiagnosticBitmap as buildLabelwriterBitmap } from '@thermal-label/harness-core/labelwriter';
import { buildDiagnosticBitmap as buildLabelmanagerBitmap } from '@thermal-label/harness-core/labelmanager';
import { bitmapToRgba } from '@thermal-label/harness-core/shared';
import type {
  LabelWriterAnyMedia,
  LabelWriterDevice,
  LabelWriterMedia,
  LabelWriterTapeMedia,
} from '@thermal-label/labelwriter-core';
import type { LabelManagerDevice, LabelManagerMedia } from '@thermal-label/labelmanager-core';

export interface DiagnosticImageInput {
  device: LabelWriterDevice;
  engine: PrintEngine;
  media: LabelWriterAnyMedia;
  harnessVersion: string;
  driverVersion: string;
}

export function buildDiagnosticImage(input: DiagnosticImageInput): RawImageData {
  const { device, engine, media, harnessVersion, driverVersion } = input;

  if (engine.protocol === 'd1-tape') {
    // Duo's tape engine speaks D1 — reuse the LM builder. The shape
    // shim mirrors what the multi-engine dispatch did pre-v2: the LM
    // builder reads `device.key` for the header and the media's
    // tape-width fields, both structurally compatible.
    const lmDeviceShim = { ...device, family: 'labelmanager' as const } as unknown as LabelManagerDevice;
    const lmMediaShim = media as unknown as LabelManagerMedia;
    const result = buildLabelmanagerBitmap({
      device: lmDeviceShim,
      media: lmMediaShim,
      harnessVersion,
      driverVersion,
    });
    return bitmapToRgba(result.authored);
  }

  // lw-450 / lw-550 — paper / die-cut labels.
  const lwMedia = media as LabelWriterMedia;
  const result = buildLabelwriterBitmap({
    device,
    media: lwMedia,
    harnessVersion,
    driverVersion,
  });
  return bitmapToRgba(result.authored);
}

// Re-export for type-narrowing convenience in the adapter.
export type { LabelWriterTapeMedia };
