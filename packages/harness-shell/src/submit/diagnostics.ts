/**
 * `buildReportDiagnostics` — folds an engine session's captured live
 * device-state into a `ReportDiagnostics` block for `HardwareReport`
 * (plan 13 §E).
 *
 * Every per-driver `buildReport` calls this with its primary session;
 * the helper runs each captured `PrinterStatus` through the shared
 * `serializeStatus` (hex-encoding `rawBytes` so the block survives
 * `JSON.stringify`) and assembles the optional fields. Returns
 * `undefined` when nothing was captured — keeps a clean report for
 * drivers / flows that produced no diagnostics.
 */
import { serializeStatus, type ReportDiagnostics } from '@thermal-label/harness-core/shared';
import type { EngineSession } from '../types';

/** Input to {@link buildReportDiagnostics}. */
export interface ReportDiagnosticsInput<TMedia> {
  /**
   * The engine session whose flow drives the report — its
   * `prePrintStatus` / `postPrintStatus` / `engineVersion` / `skuInfo`
   * are folded in.
   */
  session: EngineSession<TMedia>;
}

/**
 * Assemble a {@link ReportDiagnostics} block from a session's captured
 * state. Returns `undefined` when there is nothing to report.
 */
export function buildReportDiagnostics<TMedia>(
  input: ReportDiagnosticsInput<TMedia>,
): ReportDiagnostics | undefined {
  const { session } = input;
  const diagnostics: ReportDiagnostics = {};

  if (session.prePrintStatus) {
    diagnostics.prePrintStatus = serializeStatus(session.prePrintStatus);
  }
  if (session.postPrintStatus) {
    diagnostics.postPrintStatus = serializeStatus(session.postPrintStatus);
  }
  if (session.engineVersion) {
    diagnostics.engineVersion = session.engineVersion;
  }
  if (session.skuInfo) {
    diagnostics.skuInfo = session.skuInfo;
  }

  return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
}
