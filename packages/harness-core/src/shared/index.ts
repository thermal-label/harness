// Entry point for @thermal-label/harness-core/shared.
// Env-agnostic schemas, types, serializers, and registries shared by both
// harness runtimes (browser per plan 06; CLI per plan 05) and parsed by
// plan 04's triage runbook.

export type {
  DeviceIdentity,
  EngineReport,
  EngineVersionSnapshot,
  EnvironmentSnapshot,
  HardwareReport,
  IdentitySnapshot,
  PatternResult,
  ProposedRung,
  ReportDiagnostics,
  ReporterInfo,
  SkuInfoSnapshot,
  TransportReport,
} from './hardware-report.js';

export type { LeanStatus, SerializedStatus } from './serialize-status.js';
export { leanStatus, serializeStatus, toHex } from './serialize-status.js';

export type { TestPattern } from './test-pattern.js';

export { renderIssueBody } from './issue-body.js';

export type {
  BuildDiagnosticsSnapshotInput,
  DiagnosticsEngine,
  DiagnosticsEngineInput,
  DiagnosticsMedia,
  DiagnosticsSnapshot,
} from './diagnostics-snapshot.js';
export { buildDiagnosticsSnapshot, renderDiagnosticsBlock } from './diagnostics-snapshot.js';

export type { EdgeProbeOptions } from './diagnostic-bitmap.js';
export {
  bitmapToRgba,
  blankBitmap,
  cropHeight,
  cropToWidth,
  diagonalStripes,
  edgeProbeSection,
  sumHeightsWithGaps,
  verticalStripes,
} from './diagnostic-bitmap.js';

export type { TransportInstruction } from './transport-instructions.js';
export { transportInstructions } from './transport-instructions.js';

export type { DiagnosticImageSpec } from './diagnostic-image.js';
export { buildDiagnosticImage } from './diagnostic-image.js';
