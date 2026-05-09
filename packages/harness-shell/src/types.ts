/**
 * `DriverAdapter` and supporting types — the contract between
 * `<HarnessShell>` (driver-agnostic) and the per-driver app
 * (`apps/harness-<driver>/src/adapter.ts`).
 *
 * Design intent: the harness page is the same for every driver
 * (connect → media → print → assess → submit, with optional engine
 * tabs for multi-engine devices). Per-driver behaviour lives in a
 * single `DriverAdapter<TDevice, TMedia, TStatus>` object that wires
 * up:
 *
 *   - identity (driverKey, displayName, target GitHub repo)
 *   - device + media catalogues (read straight from the driver-core
 *     packages — `DEVICES`, `MEDIA`, `DEFAULT_MEDIA`)
 *   - the connect orchestrator (returns one or more transports +
 *     identity + status probe — handles WebUSB / Web Bluetooth / Web
 *     Serial as the driver's transports demand)
 *   - mock targets (URL-driven dev-only `?mock=…` aliases)
 *   - status polling (or, for BLE-only drivers, GATT subscriptions)
 *   - media-picker bindings (filter, group, swatch, detection mode)
 *   - encoder + chunked write (`buildBitmap` + `encodeBytes`)
 *   - optional multi-engine support (engine tabs, per-engine encoder
 *     dispatch)
 *   - optional identity-probe extras (LW 5xx NFC SKU, future drivers)
 *   - report-builder (`buildReport(input) → HardwareReport`) for the
 *     submit flow
 *
 * The shell handles UI state, Vue plumbing, polling, the section
 * progression, the engine-tabs strip, the multi-engine submit-coverage
 * list, the URL-too-long fallback, the clipboard textarea, and the
 * "Test the [other-role] engine" CTA. Adding a new driver is then a
 * matter of writing one ~150-line `adapter.ts` plus a 5-line `main.ts`.
 *
 * The four hard rules from plan-09 + maintainer feedback survive
 * intact:
 *  - tabs render iff `multiEngine` is present AND `device.engines
 *    .length > 1` — single-engine devices stay flat.
 *  - submit gates on `≥1 engine assessed`, never on full coverage
 *    (plan-09 §rails-not-walls). Submit copy adapts: "Submit
 *    verification report" (full) vs "Submit partial report (1 of 2
 *    engines tested)" (partial). No modals, no nags.
 *  - mock mode is dev-only (`import.meta.env.DEV` gate; the shell
 *    enforces this in its `useMockMode` helper).
 *  - identity-probe extras are an opaque blob (`IdentityExtras`),
 *    surfaced verbatim in the Connect section's Advanced drawer. No
 *    typed shape per driver — every driver returns whatever
 *    diagnostic bytes the operator might want to triage with.
 */
import type { Ref } from 'vue';
import type { MediaDescriptor, PrintEngine, Transport } from '@thermal-label/contracts';
import type { DiagnosticBitmapResult } from '@thermal-label/harness-core/labelmanager';
import type {
  HardwareReport,
  IdentitySnapshot,
  ProposedRung,
} from '@thermal-label/harness-core/shared';
import type { LabelBitmap } from '@mbtech-nl/bitmap';
import type {
  DetectionCapability,
  MediaGroupKey,
  MediaSwatch,
} from '@thermal-label/harness-components/types';

/** Traffic-light state shared with `<StatusPill>`. */
export type StatusPillState = 'unknown' | 'good' | 'warn' | 'bad';

/**
 * Pair of pills surfaced in section headers. The shell looks for
 * `printer` on the Connect (§1) section and `media` on the Media (§3)
 * section. Adapters omit either to suppress the corresponding pill.
 */
export interface StatusPills {
  printer?: { state: StatusPillState; label: string };
  media?: { state: StatusPillState; label: string };
}

/**
 * Identity-probe extras stuffed onto `connection.identity.extra` and
 * surfaced verbatim in the Advanced drawer's hex dump. Intentionally
 * opaque — every driver returns whatever bytes are useful for triage
 * (LW: SKU + raw status bytes; LM: raw status bytes; future drivers:
 * BLE-advertisement payloads, MAC addresses, etc.). The shell does
 * not enforce a schema; consumers must defensive-cast at read time.
 */
export type IdentityExtras = Record<string, unknown>;

// ─── Connect ─────────────────────────────────────────────────────

export interface ConnectOptions<TDevice> {
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
   * matching `MockTransport` + `TDevice`.
   */
  mockTarget?: string;
  /**
   * Hint from `?device=…` (future). Ignored today — the shell never
   * supplies it. Reserved so adapters can branch on a forced device
   * key without having to introspect the URL.
   */
  forcedDeviceKey?: string;
  /**
   * Helper passed through so adapters can bypass importing it
   * directly. Future use; today every adapter calls its own connect
   * orchestrator.
   */
  _bound?: TDevice;
}

/**
 * Connect-orchestrator result. Single-engine devices return one
 * transport keyed by the engine's `role` (or `'primary'` for
 * single-engine drivers that don't bother with role names); Twin-style
 * devices that share a transport across engines return one entry that
 * every role-key points at; Duo-style devices return one transport
 * per engine USB interface.
 *
 * `identity.extra` is the opaque blob — adapters stuff whatever
 * status-probe bytes / SKU info / handshake responses they have. The
 * shell renders it in the Advanced drawer, no schema.
 */
export interface ConnectResult<TDevice> {
  transports: Record<string, Transport>;
  device: TDevice;
  identity: IdentitySnapshot;
  /** True when this is a mock transport. Drives mock-banner UI. */
  mocked: boolean;
}

// ─── Status (poll vs subscribe) ──────────────────────────────────

/**
 * Status wiring. Today's drivers (LW, LM) all poll; the union shape
 * is forward-compat for BLE drivers (niimbot, letratag) that subscribe
 * to GATT notifications.
 *
 * `toPills` is invoked on every status update; the shell reads the
 * `printer` + `media` pills out of the returned object and renders
 * them in §1 and §3 headers respectively. Engine-aware pills (the LW
 * tape engine wants "tape loaded" rather than "paper loaded") get the
 * active engine via `ctx.engine`.
 */
export type StatusConfig<TDevice, TStatus> =
  | {
      kind: 'poll';
      read: (transport: Transport, device: TDevice) => Promise<TStatus>;
      /** Default: 4000 ms. */
      intervalMs?: number;
      toPills: (s: TStatus | null, ctx: { engine?: PrintEngine }) => StatusPills;
    }
  | {
      kind: 'subscribe';
      subscribe: (
        transport: Transport,
        device: TDevice,
      ) => Promise<{
        unsubscribe: () => Promise<void>;
        latest: Ref<TStatus | null>;
      }>;
      toPills: (s: TStatus | null, ctx: { engine?: PrintEngine }) => StatusPills;
    };

// ─── Mock targets ────────────────────────────────────────────────

/**
 * One mock target — keyed off `?mock=<key>`. The adapter resolves
 * the key to a fake transport + device. `aliases` lets one entry
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
 * Media-picker bindings. Per-engine on multi-engine devices (the
 * shell calls each callback with the active engine), so an LW Duo's
 * label vs tape tab can return different `compatible[]` sets and
 * different `detectionCapability` values from the same adapter.
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
  /** `defaultMediaId` per engine (LW tape default differs from LW label default). */
  defaultMediaId: (device: TDevice, engine: PrintEngine) => string | number;
  detectionCapability: (device: TDevice, engine: PrintEngine) => DetectionCapability;
  /**
   * Resolve `identity.extra` payload + the engine's compatible set to
   * a single detected media descriptor (or null when nothing
   * matched). Only called when `detectionCapability !== 'none'`.
   */
  detected?: (
    identity: IdentitySnapshot,
    available: readonly TMedia[],
    engine: PrintEngine,
  ) => TMedia | null;
  /**
   * Optional section-title override per engine ("Pick the loaded
   * label" vs "Pick the loaded D1 tape"). Defaults to "Pick what's
   * loaded".
   */
  sectionTitle?: (engine: PrintEngine) => string;
  /**
   * Optional warning surfaced above the picker — used by LW today to
   * flag TCP-only models the browser can't reach. Returns null for
   * "no warning". Reads `device` so adapters can branch on
   * registry-derived facts.
   */
  warning?: (device: TDevice, engine: PrintEngine) => string | null;
  /**
   * Optional support for operator-supplied custom dimensions (LW's
   * "set custom width × length" drawer). The shell renders the
   * advanced controls; the adapter constructs the resulting media
   * descriptor. Omit on drivers where custom dimensions don't apply
   * (LM tape: width is locked by the cassette).
   */
  customDimensions?: {
    /** True when the active engine supports the custom drawer. */
    supports: (device: TDevice, engine: PrintEngine) => boolean;
    /** Build a synthesised media descriptor from operator inputs. */
    build: (input: {
      widthMm: number;
      lengthMm: number;
      device: TDevice;
      engine: PrintEngine;
    }) => TMedia;
    /** Default width hint shown in the input. */
    defaultWidthMm?: number;
    /** Default length hint shown in the input. */
    defaultLengthMm?: number;
  };
}

// ─── Encoder ─────────────────────────────────────────────────────

export interface BuildBitmapInput<TDevice, TMedia> {
  device: TDevice;
  engine: PrintEngine;
  media: TMedia;
  harnessVersion: string;
  driverVersion: string;
}

export interface EncoderConfig<TDevice, TMedia> {
  buildBitmap: (input: BuildBitmapInput<TDevice, TMedia>) => DiagnosticBitmapResult;
  /**
   * Encode a built wire bitmap to printer-ready bytes. `engine` is
   * passed for drivers that need engine-protocol-aware wire framing
   * (Twin's `ESC q` roll-select prefix on LW); single-engine drivers
   * ignore it.
   *
   * `labelLengthDots` is an LW-only label-pitch hint (form-feed /
   * cut sequencing). Pass `result.authored.heightPx`; ignored on
   * drivers that don't need it.
   */
  encodeBytes: (
    bitmap: LabelBitmap,
    device: TDevice,
    media: TMedia,
    engine: PrintEngine,
    labelLengthDots?: number,
  ) => Uint8Array;
  /** Bytes per chunked transport write. Default: 64. */
  chunkSize?: number;
  /** Delay between chunks, in ms. Default: 5. */
  chunkDelayMs?: number;
}

// ─── Multi-engine ────────────────────────────────────────────────

/**
 * Multi-engine support. Tabs render iff this exists AND
 * `device.engines.length > 1`. Single-engine devices skip the strip
 * even when present (plan-09 hard rule: 6-LW renders identically to
 * today). When omitted, the shell treats the device as single-engine
 * regardless.
 *
 * `engineEncoder` lets a driver swap encoders per engine (LW Duo's
 * `lw-450` paper engine + `d1-tape` tape engine). When omitted, the
 * top-level `encoder` is used for every engine.
 */
export interface MultiEngineConfig<TDevice, TMedia> {
  isMultiEngine: (device: TDevice) => boolean;
  engineEncoder?: (engine: PrintEngine) => EncoderConfig<TDevice, TMedia>;
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

export interface DriverAdapter<TDevice, TMedia extends MediaDescriptor, TStatus> {
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

  // Catalogues + connect
  /**
   * Resolve a registry device entry from a vid/pid pair returned by
   * the WebUSB picker. Adapters using non-USB transports return null
   * here and supply their own resolution path inside `connect`.
   */
  findDeviceByVidPid?: (vid: number, pid: number) => TDevice | undefined;
  /**
   * Every device entry. Surfaced in the "wrong guess?" override
   * dropdown so the operator can correct a mis-detect.
   */
  devices: readonly TDevice[];
  /** Lookup function — `device.key` from one entry, returns the entry. */
  deviceKey: (d: TDevice) => string;
  /** Lookup function — `device.name` for the dropdown. */
  deviceName: (d: TDevice) => string;
  /**
   * Connect orchestrator. The adapter handles WebUSB picker / WebBT /
   * WebSerial as needed; returns the per-engine transport map +
   * identity. Throws on user-cancel or hard transport errors.
   */
  connect: (opts: ConnectOptions<TDevice>) => Promise<ConnectResult<TDevice>>;
  /**
   * Optional cleanup hook, called when the user clicks Disconnect or
   * navigates away. Drivers that need to release Bluetooth GATT
   * connections / unclaim USB interfaces beyond what `Transport.close`
   * does, hook in here. Default: shell calls `transport.close()` on
   * each unique transport (de-duped on identity, since Twin shares one
   * transport across engines).
   */
  disconnectExtras?: (transports: Record<string, Transport>) => Promise<void>;

  /**
   * Mock targets. Keys become valid `?mock=<key>` aliases (case-
   * insensitive); each `aliases[]` entry adds another spelling.
   * Empty object disables mock mode for this driver.
   */
  mockTargets: Record<string, MockSpec<TDevice>>;
  /** Default mock target when `?mock=1` is bare (no key). */
  defaultMockTarget?: string;

  // Status
  /**
   * Status wiring (poll or subscribe). Optional — drivers without a
   * status protocol skip pills entirely and the §1 / §3 headers stay
   * pillless.
   */
  status?: StatusConfig<TDevice, TStatus>;

  // Media picker
  media: readonly TMedia[];
  mediaPicker: MediaPickerConfig<TDevice, TMedia>;

  // Encoder + chunked write
  encoder: EncoderConfig<TDevice, TMedia>;

  // Optional multi-engine support
  multiEngine?: MultiEngineConfig<TDevice, TMedia>;

  // Optional identity-probe extras (LW 5xx NFC SKU, future drivers).
  // Stuffed onto identity.extra; surfaces in the Advanced drawer.
  // The shell doesn't introspect — the adapter's `mediaPicker.detected`
  // callback reads its own keys back out at media-section render time.

  /** Build the HardwareReport from session state. Driver-specific assembly. */
  buildReport: (input: BuildReportInput<TDevice, TMedia>) => HardwareReport;
}
