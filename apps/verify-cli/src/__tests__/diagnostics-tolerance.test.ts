/**
 * verify-cli `diagnostics`-tolerance test (plan 13 §C).
 *
 * Plan 13 adds an optional `HardwareReport.diagnostics` block. The
 * field is additive — `schemaVersion` stays `1` — so verify-cli (which
 * renders a report into an issue body and re-parses the embedded JSON
 * block) must tolerate a report **with and without** `diagnostics`
 * with no change to its parse path.
 *
 * This pins that: a report carrying the new block round-trips through
 * `renderIssueBody` → JSON-block extraction unchanged, and a report
 * without it is byte-identical to a pre-plan-13 report.
 */
import { describe, expect, it } from 'vitest';
import {
  renderIssueBody,
  serializeStatus,
  type HardwareReport,
  type ReportDiagnostics,
} from '@thermal-label/harness-core/shared';
import type { PrinterStatus } from '@thermal-label/contracts';

/** Re-extract the embedded ` ```json ` block — verify-cli's parse path. */
function extractJsonReport(body: string): HardwareReport {
  const match = /```json\n([\s\S]*?)\n```/.exec(body);
  if (match?.[1] === undefined) {
    throw new Error(`No JSON block found in body:\n${body}`);
  }
  return JSON.parse(match[1]) as HardwareReport;
}

const baseReport: HardwareReport = {
  schemaVersion: 1,
  driver: 'labelwriter',
  driverVersion: '0.5.1',
  harnessVersion: '0.1.0',
  device: {
    detected: { advertisedName: 'LabelWriter 550', vid: 0x0922, pid: 0x0028 },
    confirmed: { model: 'LabelWriter 550', vid: 0x0922, pid: 0x0028 },
  },
  transports: [{ name: 'usb', patterns: { diagnostic: 'pass' }, rung: 'verified' }],
  submittedAt: '2026-05-16T12:00:00.000Z',
};

const lw550Status: PrinterStatus = {
  ready: true,
  mediaLoaded: true,
  errors: [],
  rawBytes: new Uint8Array(32).fill(0x00),
  details: [{ label: 'Print status', value: 'idle (0)', severity: 'info' }],
};

const diagnostics: ReportDiagnostics = {
  prePrintStatus: serializeStatus(lw550Status),
  postPrintStatus: serializeStatus(lw550Status),
  engineVersion: { hwVersion: 'HW1.0', fwKind: 'application', fwVersion: '0102.0003', pid: 0x0028 },
  skuInfo: { sku: '30252', material: 'paper', totalLabelCount: 220 },
};

describe('verify-cli — HardwareReport.diagnostics tolerance', () => {
  it('renders + re-parses a report WITHOUT a diagnostics block (pre-plan-13 shape)', () => {
    const body = renderIssueBody(baseReport);
    const parsed = extractJsonReport(body);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.diagnostics).toBeUndefined();
    expect(parsed).toEqual(baseReport);
  });

  it('renders + re-parses a report WITH a diagnostics block', () => {
    const withDiagnostics: HardwareReport = { ...baseReport, diagnostics };
    const body = renderIssueBody(withDiagnostics);
    const parsed = extractJsonReport(body);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.diagnostics).toBeDefined();
    expect(parsed.diagnostics?.prePrintStatus?.rawBytes).toBe(
      '0000000000000000000000000000000000000000000000000000000000000000',
    );
    expect(parsed.diagnostics?.engineVersion?.fwVersion).toBe('0102.0003');
    expect(parsed.diagnostics?.skuInfo?.sku).toBe('30252');
    // The whole block survives the JSON round-trip intact.
    expect(parsed.diagnostics).toEqual(diagnostics);
  });

  it('keeps schemaVersion at 1 — the field is additive, parsers need no branch', () => {
    const withDiagnostics: HardwareReport = { ...baseReport, diagnostics };
    expect(extractJsonReport(renderIssueBody(withDiagnostics)).schemaVersion).toBe(1);
    expect(extractJsonReport(renderIssueBody(baseReport)).schemaVersion).toBe(1);
  });

  it('a diagnostics-free report renders byte-identical to a pre-plan-13 report', () => {
    // Constructing the report with an explicit `diagnostics: undefined`
    // must not change the rendered body — old and new reports are
    // indistinguishable on the wire when no diagnostics were captured.
    const explicitUndefined: HardwareReport = { ...baseReport };
    expect(renderIssueBody(explicitUndefined)).toBe(renderIssueBody(baseReport));
  });
});
