// Entry point for @thermal-label/harness-core/labelmanager.
//
// Driver-specific shared helpers for the labelmanager family.
// Imported by both harness apps (`apps/verify-cli/` and
// `apps/harness-labelmanager/`) so the diagnostic-print encoder
// lives in exactly one place. Mirrors the labelwriter subpath next
// to it; see `diagnostic-print.ts` for the rationale behind keeping
// a driver-named subpath inside otherwise-agnostic harness-core.

export type { DiagnosticBitmapResult, DiagnosticPrintInput } from './diagnostic-print.js';
export { buildDiagnosticBitmap, encodeBitmap } from './diagnostic-print.js';
