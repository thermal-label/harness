/**
 * `buildReportDiagnostics` — folds an engine session's captured live
 * device-state into a `ReportDiagnostics` block for `HardwareReport`
 * (plan 13 §E).
 *
 * Every per-driver `buildReport` calls this with its primary session;
 * the helper runs each captured `PrinterStatus` through the shared
 * `leanStatus` (hex-encoding `rawBytes` so the block survives
 * `JSON.stringify`, and dropping the decoded `details[]` / `detectedMedia`
 * that would otherwise blow the report past GitHub's prefill-URL limit)
 * and assembles the optional fields. A `postPrintStatus` byte-identical
 * to the pre-print one is dropped as pure duplication. Returns
 * `undefined` when nothing was captured — keeps a clean report for
 * drivers / flows that produced no diagnostics.
 */
import { leanStatus, type ReportDiagnostics } from '@thermal-label/harness-core/shared';
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
    diagnostics.prePrintStatus = leanStatus(session.prePrintStatus);
  }
  if (session.postPrintStatus) {
    const post = leanStatus(session.postPrintStatus);
    // Drop a post-print status byte-identical to the pre-print one: a
    // clean run leaves the `ESC A` reply unchanged, and the decoded
    // fields all derive from `rawBytes`, so equal raw bytes mean an
    // identical lean status. Carrying it twice is the duplication that
    // pushes a standard LW 5xx report past the prefill-URL limit — the
    // pair is kept only when the print actually moved device state. A
    // missing pre-print status (optional chain ⇒ `undefined`) never
    // matches, so a lone post is always kept.
    if (post.rawBytes !== diagnostics.prePrintStatus?.rawBytes) {
      diagnostics.postPrintStatus = post;
    }
  }
  if (session.engineVersion) {
    diagnostics.engineVersion = session.engineVersion;
  }
  if (session.skuInfo) {
    diagnostics.skuInfo = session.skuInfo;
  }

  return Object.keys(diagnostics).length > 0 ? diagnostics : undefined;
}
