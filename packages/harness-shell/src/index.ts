// Public entry point for the shared harness shell.
//
// Per-driver apps (apps/harness-<driver>/src/main.ts) consume `createHarness`
// + the `DriverAdapter` types; the rest of the surface is exported for
// adapter authors that want to reuse a sub-section in custom layouts (rare;
// only if a driver needs an unusual variant of the page chrome).
//
// The Vue components themselves don't need re-export — they're consumed
// internally by `<HarnessShell>` and `createHarness` is the only public
// mounting entry.

export type {
  DriverAdapter,
  BrowserTransport,
  ConnectOptions,
  ConnectResult,
  MockSpec,
  MockTransportFilter,
  MediaPickerConfig,
  EngineSession,
  BuildDiagnosticImageInput,
  BuildReportInput,
} from './types';

export { createHarness } from './createHarness';
