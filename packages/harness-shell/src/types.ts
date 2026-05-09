/**
 * `DriverAdapter` and supporting types — the contract between
 * `<HarnessShell>` (driver-agnostic) and the per-driver app
 * (`apps/harness-<driver>/src/adapter.ts`).
 *
 * Design intent (post-harness-v2 refactor): the harness is a *driver
 * fidelity test*. Every protocol-level operation goes through the
 * driver's `PrinterAdapter` (`@thermal-label/contracts`), so the
 * harness exercises the same code paths a real consumer of the driver
 * would. The shell owns:
 *
 *   - connect/disconnect orchestration (delegates to `adapter.connect`,
 *     which returns a `PrinterAdapter`)
 *   - status polling (`printer.getStatus()` every 4 s, or `onStatus`
 *     when the driver supplies push), pill rendering, detected-media
 *     surfacing
 *   - bitmap preview (calls `printer.createPreview(rgba, { media })`)
 *   - print (calls `printer.print(rgba, media)`)
 *   - submit / report flow / engine-tabs / "rails not walls" CTAs
 *
 * The adapter contributes only:
 *
 *   - identity (driverKey, displayName, target GitHub repo, versions)
 *   - device + media catalogues (read straight from driver-core)
 *   - the connect orchestrator (real path: `requestPrinter()` from the
 *     driver-web package; mock path: `new WebDymoPrinter(device,
 *     mockTransport)` etc.)
 *   - mock targets (URL-driven dev-only `?mock=…` aliases)
 *   - media-picker bindings (filter, group, swatch, describe — no
 *     defaultMediaId / detection / warning / customDimensions; those
 *     are derived inside the shell from `printer.getStatus()` and the
 *     driver's media metadata)
 *   - the diagnostic-image builder (returns RGBA — the driver does
 *     threshold/dither, exactly like real consumers)
 *   - report-builder (`buildReport(input) → HardwareReport`) for the
 *     submit flow
 *
 * The four hard rules from plan-09 + maintainer feedback survive
 * intact:
 *  - tabs render iff `device.engines.length > 1`. Single-engine devices
 *    stay flat.
 *  - submit gates on `≥1 engine assessed`, never on full coverage
 *    (plan-09 §rails-not-walls). Submit copy adapts: "Submit
 *    verification report" (full) vs "Submit partial report (1 of 2
 *    engines tested)" (partial). No modals, no nags.
 *  - mock mode is dev-only (`import.meta.env.DEV` gate; the shell
 *    enforces this in its `useMockMode` helper).
 *  - "Don't see your label?" is a CTA linking to the driver repo's
 *    issue tracker, not in-app custom-dimension functionality.
 */
import type {
  MediaDescriptor,
  PrintEngine,
  PrinterAdapter,
  RawImageData,
} from '@thermal-label/contracts';
import type {
  HardwareReport,
  IdentitySnapshot,
  ProposedRung,
} from '@thermal-label/harness-core/shared';
import type { MediaGroupKey, MediaSwatch } from '@thermal-label/harness-components/types';

// ─── Connect ─────────────────────────────────────────────────────

export interface ConnectOptions {
  /**
   * True when the operator opened the page with `?mock=<key>` — the
   * adapter should branch to its mock implementation. The shell still
   * passes the resolved `mockTarget` so the adapter can synthesise
   * the right device shape.
   */
  mock: boolean;
  /**
   * The mock target key (if `mock === true`). One of the keys in
   * `adapter.mockTargets`. The adapter looks it up and synthesises a
   * matching mock-backed `PrinterAdapter`.
   */
  mockTarget?: string;
}

/**
 * Connect-orchestrator result. The shell consumes the `PrinterAdapter`
 * map directly — every protocol-level operation (print, preview, status)
 * goes through whichever entry the operator's active engine selects.
 *
 * `printers` is keyed by engine role. Single-engine devices (the LM,
 * the QL family, most LW models) return a 1-key record (the engine's
 * own role). Multi-engine devices (LW Twin Turbo — `left` / `right`,
 * LW Duo family — `label` / `tape`) return one entry per engine. Each
 * entry is an independent `PrinterAdapter` scoped to that engine; for
 * the Duo specifically each entry holds its own USB-interface-claimed
 * transport, so writes hit the correct endpoint without any harness-
 * level facade.
 *
 * `device` is the registry entry for tabs / report assembly; `mocked`
 * drives the dev-only "mock mode" banner.
 */
export interface ConnectResult<TDevice> {
  /** One adapter per drivable engine on the device, keyed by engine role. */
  printers: Record<string, PrinterAdapter>;
  device: TDevice;
  /** True when this is a mock-backed PrinterAdapter. */
  mocked: boolean;
}

// ─── Mock targets ────────────────────────────────────────────────

/**
 * One mock target — keyed off `?mock=<key>`. The adapter resolves
 * the key to a synthesised device entry. `aliases` lets one entry
 * accept multiple URL spellings (`?mock=lm280` and `?mock=lm_280` for
 * the same target).
 */
export interface MockSpec<TDevice> {
  /** Display name shown in the mock-mode banner. */
  displayName: string;
  /** Synthesised device for this mock. */
  device: TDevice;
  /** Identity values that match what the adapter would build for the real device. */
  vid: number;
  pid: number;
  /** Extra `?mock=` aliases that resolve to this target (case-insensitive). */
  aliases?: readonly string[];
}

// ─── Media picker ────────────────────────────────────────────────

/**
 * Media-picker bindings. Per-engine on multi-engine devices (the shell
 * calls each callback with the active engine). The shell derives
 * detection (auto-locked / auto-suggest / none) and the detected
 * entry from `printer.getStatus().detectedMedia` directly — adapters
 * supply only the catalogue filtering + visual presentation.
 */
export interface MediaPickerConfig<TDevice, TMedia extends MediaDescriptor> {
  filterByDeviceEngine: (
    media: readonly TMedia[],
    device: TDevice,
    engine: PrintEngine,
  ) => readonly TMedia[];
  groupBy: (m: TMedia) => MediaGroupKey;
  swatch?: (m: TMedia) => MediaSwatch | null;
  describe?: (m: TMedia) => string;
}

// ─── Diagnostic image ────────────────────────────────────────────

export interface BuildDiagnosticImageInput<TDevice, TMedia> {
  device: TDevice;
  engine: PrintEngine;
  media: TMedia;
  harnessVersion: string;
  driverVersion: string;
}

// ─── Report builder ──────────────────────────────────────────────

/**
 * One engine's worth of operator-driven state. Single-engine drivers
 * see one entry in `engineSessions`; multi-engine drivers see one
 * per role.
 */
export interface EngineSession<TMedia> {
  /** The engine this slot belongs to. */
  engine: PrintEngine;
  /** Operator-picked media for this engine. */
  media: TMedia | null;
  /** Has a diagnostic print been written successfully? */
  printed: boolean;
  /** Operator's verdict on what came out of this engine's head. */
  rung: ProposedRung | null;
  /** Free-form notes scoped to this engine's print. */
  notes: string;
}

export interface BuildReportInput<TDevice, TMedia> {
  device: TDevice;
  identity: IdentitySnapshot;
  /**
   * The session whose rung drives the transport-level report. On a
   * single-engine device this is the only session; on multi-engine
   * devices the shell picks the active or first-assessed session so
   * the legacy transport shape carries a non-null rung. Per-engine
   * results land in `allSessions` → adapter renders the `engines[]`
   * array.
   */
  primarySession: EngineSession<TMedia>;
  /** All engine sessions the operator has assessed (rung set). */
  allSessions: readonly EngineSession<TMedia>[];
  /** True for devices declaring more than one engine. */
  multiEngine: boolean;
  /** True if the run used the mock transport. */
  mocked: boolean;
  /** Optional reporter handle from the submit form. */
  reporter?: string;
}

// ─── DriverAdapter ───────────────────────────────────────────────

export interface DriverAdapter<TDevice, TMedia extends MediaDescriptor> {
  // Identity
  /** Stable key written into HardwareReport.driver and used in URLs. */
  driverKey: string;
  /** Display name used in headers and copy ("LabelWriter", "LabelManager"). */
  driverDisplayName: string;
  /**
   * GitHub repo where reports go (`thermal-label/labelwriter`). The
   * shell builds the prefilled-issue URL against this repo.
   */
  targetRepo: string;
  /** App version string for reports (Vite-injected at build time, "0.0.0-dev" in dev). */
  harnessVersion: string;
  /** Driver-core version string for reports (matches the linked `driver-core/package.json`). */
  driverVersion: string;
  /**
   * Optional one-liner that lands at the top of the page under the
   * heading. Defaults to a generic "diagnostic print + report"
   * blurb if omitted.
   */
  introBlurb?: string;
  /** Page heading. Defaults to "How does your <displayName> actually behave?". */
  pageHeading?: string;

  // Catalogues
  /** Every device entry — used for the engine-tabs strip / report rendering. */
  devices: readonly TDevice[];
  /** Every media entry. */
  media: readonly TMedia[];
  /** Lookup function — `device.key` from one entry, returns the entry. */
  deviceKey: (d: TDevice) => string;
  /** Lookup function — `device.name` for display copy. */
  deviceName: (d: TDevice) => string;

  /**
   * Connect orchestrator. Real path: call `requestPrinter()` from
   * driver-web. Mock path: instantiate the driver-web class
   * (`WebDymoPrinter` etc.) with a `MockTransport` so the returned
   * `PrinterAdapter` is a real driver instance backed by mock bytes.
   * Throws on user-cancel or hard transport errors.
   */
  connect: (opts: ConnectOptions) => Promise<ConnectResult<TDevice>>;

  /**
   * Mock targets. Keys become valid `?mock=<key>` aliases (case-
   * insensitive); each `aliases[]` entry adds another spelling.
   * Empty object disables mock mode for this driver.
   */
  mockTargets: Record<string, MockSpec<TDevice>>;
  /** Default mock target when `?mock=1` is bare (no key). */
  defaultMockTarget?: string;

  // Media picker
  mediaPicker: MediaPickerConfig<TDevice, TMedia>;

  // Diagnostic-image builder. Returns full RGBA — the driver does the
  // threshold/dither pipeline via `printer.print()` and
  // `printer.createPreview()`.
  buildDiagnosticImage: (input: BuildDiagnosticImageInput<TDevice, TMedia>) => RawImageData;

  /** Build the HardwareReport from session state. Driver-specific assembly. */
  buildReport: (input: BuildReportInput<TDevice, TMedia>) => HardwareReport;
}
