// Entry point for @thermal-label/harness-core/shared.
// Env-agnostic schemas, types, serializers, and registries shared by both
// harness runtimes (browser per plan 06; CLI per plan 05) and parsed by
// plan 04's triage runbook.

export type {
  DeviceIdentity,
  EngineReport,
  HardwareReport,
  IdentitySnapshot,
  PatternResult,
  ProposedRung,
  ReporterInfo,
  TransportReport,
} from './hardware-report.js';

export type { TestPattern } from './test-pattern.js';

export { renderIssueBody } from './issue-body.js';

export type { EdgeProbeOptions } from './diagnostic-bitmap.js';
export {
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
