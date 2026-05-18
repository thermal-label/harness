/**
 * Unit coverage for `buildReportDiagnostics` — the helper that folds an
 * engine session's captured live device-state into a `HardwareReport`'s
 * `ReportDiagnostics` block.
 *
 * Two behaviours are load-bearing for keeping a standard single-engine
 * LW 5xx report under GitHub's prefill-URL limit (see
 * `REPORT_BLOAT_HANDOFF.md`):
 *  - the pre/post statuses are projected *lean* — `rawBytes` + the three
 *    booleans/`errors` only, no decoded `details[]` / `detectedMedia`;
 *  - a `postPrintStatus` byte-identical to the pre-print one is dropped.
 */
import { describe, expect, it } from 'vitest';
import type { MediaDescriptor, PrinterStatus } from '@thermal-label/contracts';
import type { EngineSession } from '../../types';
import { buildReportDiagnostics } from '../diagnostics';

/** A 32-byte `ESC A` reply with a detected media + a decoded details[]. */
const baseStatus: PrinterStatus = {
  ready: true,
  mediaLoaded: true,
  errors: [],
  rawBytes: new Uint8Array(32).fill(0x00),
  detectedMedia: { id: 'sku-30252', name: '30252', widthMm: 28, heightMm: 89, type: 'die-cut' },
  details: [
    { label: 'Print status', value: 'idle (0)', severity: 'info' },
    { label: 'Labels remaining', value: '220', severity: 'info' },
  ],
};

/** Same shape, different raw bytes — a print that moved device state. */
const movedStatus: PrinterStatus = { ...baseStatus, rawBytes: new Uint8Array(32).fill(0x01) };

/** Build an `EngineSession` carrying only the fields the helper reads. */
function sessionWith(
  over: Partial<EngineSession<MediaDescriptor>>,
): EngineSession<MediaDescriptor> {
  return {
    engine: { role: 'primary', protocol: 'lw5-raster', dpi: 300, headDots: 672 },
    media: null,
    printed: true,
    rung: 'verified',
    notes: '',
    ...over,
  };
}

describe('buildReportDiagnostics', () => {
  it('returns undefined when nothing was captured', () => {
    expect(buildReportDiagnostics({ session: sessionWith({}) })).toBeUndefined();
  });

  it('projects prePrintStatus lean — rawBytes + ready/mediaLoaded/errors only', () => {
    const diagnostics = buildReportDiagnostics({
      session: sessionWith({ prePrintStatus: baseStatus }),
    });
    const pre = diagnostics?.prePrintStatus;
    expect(pre).toBeDefined();
    expect(pre?.rawBytes).toBe('0'.repeat(64)); // 32 bytes → 64 hex chars
    expect(pre?.ready).toBe(true);
    expect(pre?.mediaLoaded).toBe(true);
    expect(pre?.errors).toEqual([]);
    // The decoded forensics are dropped — they re-derive from rawBytes,
    // and carrying them is what overflows the prefill URL.
    expect(pre).not.toHaveProperty('details');
    expect(pre).not.toHaveProperty('detectedMedia');
  });

  it('drops a postPrintStatus byte-identical to the pre-print one', () => {
    const diagnostics = buildReportDiagnostics({
      session: sessionWith({ prePrintStatus: baseStatus, postPrintStatus: { ...baseStatus } }),
    });
    expect(diagnostics?.prePrintStatus).toBeDefined();
    expect(diagnostics?.postPrintStatus).toBeUndefined();
  });

  it('keeps a postPrintStatus whose raw bytes differ from the pre-print one', () => {
    const diagnostics = buildReportDiagnostics({
      session: sessionWith({ prePrintStatus: baseStatus, postPrintStatus: movedStatus }),
    });
    expect(diagnostics?.prePrintStatus?.rawBytes).toBe('0'.repeat(64));
    expect(diagnostics?.postPrintStatus?.rawBytes).toBe('01'.repeat(32));
  });

  it('keeps a postPrintStatus when there is no pre-print status to dedup against', () => {
    const diagnostics = buildReportDiagnostics({
      session: sessionWith({ postPrintStatus: baseStatus }),
    });
    expect(diagnostics?.prePrintStatus).toBeUndefined();
    expect(diagnostics?.postPrintStatus).toBeDefined();
  });

  it('folds engineVersion / skuInfo through verbatim', () => {
    const engineVersion = { hwVersion: '1.0', fwVersion: '0102.0003', rawBytes: 'abcd' };
    const skuInfo = { sku: '30252', material: 'paper', totalLabelCount: 220 };
    const diagnostics = buildReportDiagnostics({
      session: sessionWith({ engineVersion, skuInfo }),
    });
    expect(diagnostics?.engineVersion).toEqual(engineVersion);
    expect(diagnostics?.skuInfo).toEqual(skuInfo);
  });
});
