/**
 * `serializeStatus` — the one shared `PrinterStatus` → JSON-safe
 * projection used across the harness.
 *
 * `PrinterStatus.rawBytes` is a `Uint8Array`; it stringifies to an
 * unreadable keyed object (`{"0":15,"1":160,…}`) under `JSON.stringify`.
 * Anything that embeds a status in a JSON artifact — the connect-time
 * `DiagnosticsSnapshot` (plan `diagnostics-json-copy`) and the
 * print-flow `ReportDiagnostics` block inside `HardwareReport`
 * (plan 13 §C) — must run it through this helper first.
 *
 * It is deliberately the *single* primitive: every other field of
 * `PrinterStatus` is already JSON-safe and passes through unchanged,
 * so there is no second hex helper to drift out of sync.
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
