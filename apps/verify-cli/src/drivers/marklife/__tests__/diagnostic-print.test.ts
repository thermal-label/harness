import { describe, expect, it } from 'vitest';
import {
  DEVICES,
  MEDIA,
  type MarklifeDevice,
  type MarklifeEngine,
  type MarklifeMedia,
} from '@thermal-label/marklife-core';
import { buildDiagnosticBitmap, encodeBitmap } from '../diagnostic-print.js';

const P12 = DEVICES.P12 as MarklifeDevice;
const D100 = DEVICES.D100 as MarklifeDevice; // marklife-jbig — encoder deferred
const MEDIA_15MM = MEDIA.CONTINUOUS_15MM as MarklifeMedia;

function engineOf(device: MarklifeDevice): MarklifeEngine {
  const engine = device.engines[0];
  if (!engine) throw new Error(`Test fixture ${device.key} has no engine`);
  return engine;
}

describe('marklife diagnostic-print encoder', () => {
  it('builds a head-width bitmap for the P12 (0.5" / 96-dot head)', () => {
    const bitmap = buildDiagnosticBitmap({
      device: P12,
      media: MEDIA_15MM,
      harnessVersion: '0.0.0',
      driverVersion: '0.1.0',
    });
    expect(bitmap.widthPx).toBe(96); // P12 registry headDots (HCI-capture confirmed)
    expect(bitmap.heightPx).toBeGreaterThan(100); // stacked sections
  });

  it('encodes the P12 diagnostic to a non-empty L11 wire stream', () => {
    const bitmap = buildDiagnosticBitmap({
      device: P12,
      media: MEDIA_15MM,
      harnessVersion: '0.0.0',
      driverVersion: '0.1.0',
    });
    const bytes = encodeBitmap(bitmap, engineOf(P12), MEDIA_15MM);
    // marklife-yxq job: density / wakeup / enable / raster / feed /
    // stop. Non-trivially sized once the raster payload lands.
    expect(bytes.length).toBeGreaterThan(0);
  });

  it('rejects a chassis whose engine has no encoder (JBIG, deferred)', () => {
    // D100 binds marklife-jbig — the payload encoder is deferred
    // (marklife DECISIONS.md § D4), so `isEngineDrivable` is false and
    // `encodeBitmap` must fail loudly rather than emit a broken job.
    const bitmap = buildDiagnosticBitmap({
      device: D100,
      media: MEDIA_15MM,
      harnessVersion: '0.0.0',
      driverVersion: '0.1.0',
    });
    expect(() => encodeBitmap(bitmap, engineOf(D100), MEDIA_15MM)).toThrowError(
      /no encoder in this build/,
    );
  });
});
