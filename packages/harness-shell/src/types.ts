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
  PrinterStatus,
  RawImageData,
  TransportType,
} from '@thermal-label/contracts';
import type {
  EngineVersionSnapshot,
  HardwareReport,
  IdentitySnapshot,
  ProposedRung,
  SkuInfoSnapshot,
} from '@thermal-label/harness-core/shared';
import type { MediaGroupKey, MediaSwatch } from '@thermal-label/harness-components/types';

// ─── Connect ─────────────────────────────────────────────────────

/**
 * Browser-reachable subset of `TransportType` — what
 * `ConnectSection.vue` renders connect buttons for. `tcp` is
 * intentionally omitted because browsers cannot open raw sockets;
 * the shell filters that key out before rendering.
 *
 * Per plan 11 §Connect-section UI.
 */
export type BrowserTransport = Exclude<TransportType, 'tcp'>;

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
  /**
   * Transport the operator picked in §1 of the harness. The adapter
   * dispatches its real-connect path on this value. Drivers whose
   * registry only declares one transport will see the same key every
   * time; multi-transport drivers (brother-ql USB+SPP, labelife
   * USB+Serial+BLE) dispatch on the discriminator.
   *
   * Mock connects ignore this — the `MockSpec`'s own `transport`
   * tag carries the shape information.
   *
   * Added in plan 11; pre-plan-11 adapters that ignore this field
   * keep working as long as they declare only one transport.
   */
  transport?: BrowserTransport;
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
  /**
   * Connect-time diagnostics the adapter captured eagerly, keyed by
   * engine role (plan 13 §E.1). LW 5xx fills `engineVersion` (`ESC V`)
   * and `skuInfo` (`ESC U`) here so roll + firmware data reaches the
   * report even if the operator never runs MediaSection or the print
   * fails. Other drivers omit it. The shell folds each entry into the
   * matching `EngineSession`.
   */
  engineDiagnostics?: Record<
    string,
    {
      engineVersion?: EngineVersionSnapshot;
      skuInfo?: SkuInfoSnapshot;
    }
  >;
}

// ─── Mock targets ────────────────────────────────────────────────

/**
 * Shape-tagged filter union for `MockSpec`. The `transport` tag tells
 * the shell which `IdentitySnapshot` fields to populate on mock
 * connect, and the `filter` block carries the would-have-been picker
 * constraints so the harness can render a matching "mock target:
 * vid=0x… pid=0x…" or "mock target: service=…" banner.
 *
 * Per plan 11 §`MockSpec<TDevice>` shape.
 */
export type MockTransportFilter =
  | { transport: 'usb'; filter: { vid: number; pid: number } }
  | { transport: 'serial'; filter: { path?: string; baud?: number } }
  | { transport: 'bluetooth-spp'; filter: { name?: string; baud?: number } }
  | { transport: 'bluetooth-gatt'; filter: { serviceUuid: string; namePrefix?: string } };

/**
 * One mock target — keyed off `?mock=<key>`. The adapter resolves
 * the key to a synthesised device entry. `aliases` lets one entry
 * accept multiple URL spellings (`?mock=lm280` and `?mock=lm_280` for
 * the same target).
 *
 * Plan 11 reshape: `MockSpec` is now a transport-tagged discriminated
 * union. Pre-plan-11 USB-only adapters move from
 * `{ vid, pid, ... }` to `{ transport: 'usb', filter: { vid, pid }, ... }`.
 * BLE / Serial drivers populate their own shape variant. The shell
 * uses `transport` to decide which `IdentitySnapshot` fields to
 * render on the mock-mode banner.
 */
export type MockSpec<TDevice> = {
  /** Display name shown in the mock-mode banner. */
  displayName: string;
  /** Synthesised device for this mock. */
  device: TDevice;
  /** Extra `?mock=` aliases that resolve to this target (case-insensitive). */
  aliases?: readonly string[];
} & MockTransportFilter;

// ─── Media picker ────────────────────────────────────────────────

/**
 * Operator-confirmed dimensions for the `detected-unrecognized` flow.
 *
 * Built by `MediaPicker`'s unrecognized panel from the prefilled (and
 * editable) dimension fields plus the free-text identifier, and handed
 * to the driver's `customMedia.build` hook to synthesise a printable
 * media. `identifier` is the operator's free-text media id (a Brother
 * DK-code, a Dymo SKU, or a short description); `''` when blank.
 */
export interface CustomMediaInput {
  /** Confirmed media width in mm. */
  widthMm: number;
  /** Confirmed label length in mm. `undefined` ⇒ continuous. */
  heightMm?: number;
  /** Confirmed media type. */
  type: 'continuous' | 'die-cut';
  /** Operator free-text identifier; `''` when blank. */
  identifier: string;
}

/**
 * Media-picker bindings. Per-engine on multi-engine devices (the shell
 * calls each callback with the active engine). The shell derives
 * detection (auto-locked / auto-suggest / detected-unrecognized /
 * none) and the detected entry from `printer.getStatus().detectedMedia`
 * directly — adapters supply only the catalogue filtering + visual
 * presentation, plus the optional `customMedia` build hook.
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
  /**
   * Build a printable media from operator-confirmed dimensions, for
   * the `detected-unrecognized` flow (a detection that maps to no
   * catalogue entry). The harness cannot synthesise a *printable*
   * driver media generically — brother-ql needs `printAreaDots` /
   * margins, etc. — so the driver supplies this hook.
   *
   * Omit it if the driver cannot drive an uncatalogued media; the
   * picker then degrades to `auto-suggest` rather than hard-locking
   * the operator to a non-catalogue object.
   */
  customMedia?: {
    /** Returns a full `TMedia` with real geometry + driver-specific fields. */
    build: (input: CustomMediaInput) => TMedia;
  };
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
  /**
   * Live device-state captured across the print flow for this engine
   * (plan 13 §E). All optional — populated as the flow reaches each
   * point; a report folds whatever was captured into
   * `HardwareReport.diagnostics`.
   *
   * `connectStatus` — first polled status after connect.
   * `prePrintStatus` / `postPrintStatus` — status read immediately
   *   before and after `printer.print()` resolved (the load-bearing
   *   "nothing happens" diagnostic).
   * `engineVersion` / `skuInfo` — `ESC V` / `ESC U` blocks fetched
   *   eagerly by the adapter on connect (LW 5xx).
   */
  connectStatus?: PrinterStatus | null;
  prePrintStatus?: PrinterStatus | null;
  postPrintStatus?: PrinterStatus | null;
  engineVersion?: EngineVersionSnapshot;
  skuInfo?: SkuInfoSnapshot;
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
  /**
   * Latest polled status for the primary engine, captured at submit
   * time (the periodic poll keeps it fresh). Folded into
   * `HardwareReport.diagnostics.finalStatus` by `buildReportDiagnostics`.
   * `null` when the engine was never polled. Plan 13 §E.4.
   */
  finalStatus?: PrinterStatus | null;
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
