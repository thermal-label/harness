// Entry point for @thermal-label/harness-core/shared.
// Env-agnostic schemas, types, serializers, and registries shared by both
// harness runtimes (browser per plan 06; CLI per plan 05) and parsed by
// plan 04's triage runbook.

export type {
  DeviceIdentity,
  HardwareReport,
  IdentitySnapshot,
  PatternResult,
  ProposedRung,
  ReporterInfo,
  ReportPhoto,
  TransportReport,
} from './hardware-report.js';

export type { TestPattern } from './test-pattern.js';
