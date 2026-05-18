/**
 * `PrinterStatus` → JSON-safe projections used across the harness.
 *
 * `PrinterStatus.rawBytes` is a `Uint8Array`; it stringifies to an
 * unreadable keyed object (`{"0":15,"1":160,…}`) under `JSON.stringify`.
 * Anything that embeds a status in a JSON artifact must run it through
 * one of the two projections here first:
 *
 *  - {@link serializeStatus} → {@link SerializedStatus} — the *full*
 *    projection (`rawBytes` hex; every other field verbatim). Used by
 *    the connect-time `DiagnosticsSnapshot` (plan `diagnostics-json-copy`),
 *    a copy-only artifact with no size budget.
 *  - {@link leanStatus} → {@link LeanStatus} — the *lean* projection
 *    (`rawBytes` hex + `ready` / `mediaLoaded` / `errors` only). Used by
 *    the `ReportDiagnostics` block inside `HardwareReport` (plan 13 §C),
 *    which rides in a length-capped GitHub prefill URL — see
 *    {@link LeanStatus} for why the decoded fields are dropped.
 *
 * Both share `toHex` as the single byte→hex primitive, so there is no
 * second hex helper to drift out of sync.
 */

import type { PrinterStatus } from '@thermal-label/contracts';

/**
 * JSON-safe projection of a {@link PrinterStatus}.
 *
 * Identical to `PrinterStatus` except `rawBytes` is a lowercase,
 * unspaced hex string (`"0fa000ff"`) rather than a `Uint8Array`. Every
 * other field — `ready`, `mediaLoaded`, `detectedMedia`, `errors`,
 * `details` — is already JSON-safe and carried verbatim.
 *
 * The hex string is unspaced to stay consistent with the format the
 * already-shipped `DiagnosticsSnapshot` emits (plan 13 §B's open
 * "spaced vs unspaced" question, resolved unspaced — one format across
 * both artifacts, no migration of the landed copy block).
 */
export interface SerializedStatus extends Omit<PrinterStatus, 'rawBytes'> {
  /** Lowercase, unspaced hex of the raw status bytes, e.g. `"0fa000ff"`. */
  rawBytes: string;
}

/** Lower-case unspaced hex of a byte buffer, e.g. `[0x0f, 0xa0]` → `"0fa0"`. */
export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Project a `PrinterStatus` into a {@link SerializedStatus} — the only
 * change is `rawBytes` becoming a hex string; everything else passes
 * through unchanged.
 */
export function serializeStatus(status: PrinterStatus): SerializedStatus {
  const { rawBytes, ...rest } = status;
  return { ...rest, rawBytes: toHex(rawBytes) };
}

/**
 * Lean projection of a {@link PrinterStatus} for the URL-bound
 * `ReportDiagnostics` block inside a `HardwareReport`.
 *
 * Carries `rawBytes` (hex) plus `ready` / `mediaLoaded` / `errors`, and
 * deliberately drops the decoded `details[]` table, `detectedMedia`,
 * and `battery` that {@link SerializedStatus} keeps. Those are all
 * re-derivable from `rawBytes` (verify-cli replays the driver decode),
 * and a report's roll/media forensics already live in its `skuInfo` —
 * so carrying the decoded fields again, twice (pre- and post-print),
 * is pure duplication. That duplication is the single biggest reason a
 * standard single-engine LW 5xx report overflows GitHub's prefill-URL
 * limit; the lean shape is what lets the common case submit in one
 * click instead of falling back to title-only paste recovery.
 *
 * The copy-only `DiagnosticsSnapshot` is not URL-bound and keeps the
 * full {@link SerializedStatus} — this lean shape is report-only.
 */
export type LeanStatus = Pick<SerializedStatus, 'ready' | 'mediaLoaded' | 'errors' | 'rawBytes'>;

/**
 * Project a `PrinterStatus` into a {@link LeanStatus} — `rawBytes`
 * becomes a hex string; `ready` / `mediaLoaded` / `errors` pass through
 * verbatim; the decoded `details[]`, `detectedMedia`, and `battery` are
 * dropped (reconstructible from `rawBytes` — see {@link LeanStatus}).
 */
export function leanStatus(status: PrinterStatus): LeanStatus {
  return {
    ready: status.ready,
    mediaLoaded: status.mediaLoaded,
    errors: status.errors,
    rawBytes: toHex(status.rawBytes),
  };
}
