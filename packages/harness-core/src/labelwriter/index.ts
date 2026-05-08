// Entry point for @thermal-label/harness-core/labelwriter.
//
// Driver-specific shared helpers for the labelwriter family. Imported
// by both harness apps (`apps/verify-cli/` and
// `apps/harness-labelwriter/`) so the diagnostic-print encoder lives
// in exactly one place. See `diagnostic-print.ts` for the rationale
// behind keeping a driver-named subpath inside otherwise-agnostic
// harness-core rather than spinning a new workspace package.

export type { DiagnosticBitmapResult, DiagnosticPrintInput } from './diagnostic-print.js';
export { buildDiagnosticBitmap, encodeBitmap } from './diagnostic-print.js';
