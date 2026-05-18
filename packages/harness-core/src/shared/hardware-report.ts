/**
 * `HardwareReport` — the wire format produced by the harness, embedded in
 * GitHub issue bodies, and parsed by the triage runbook (plan 04) into a
 * matrix-promotion PR (plan 02).
 *
 * Contract is shared across both harness runtimes (browser per plan 06; CLI
 * per plan 05) and across all driver repos. `schemaVersion` is bumped on any
 * field-shape change so plan 04's parser can branch on it.
 */

import type { TransportType } from '@thermal-label/contracts';
import type { LeanStatus } from './serialize-status.js';

/**
 * Per-pattern result reported by the harness.
 *
 * - `'pass'` — pattern executed and bytes were sent (the printer responded
 *   physically — something came out, even if visually flawed).
 * - `'fail'` — bytes did not reach the printer (transport-layer failure,
 *   device unreachable, write rejected).
 * - `'skipped'` — operator declined to run this pattern.
 *
 * Whether the *output* looked correct is the operator's call, captured on
 * `TransportReport.rung` directly — not derived from these mechanics.
 */
export type PatternResult = 'pass' | 'fail' | 'skipped';

/**
 * The rung the operator proposes for a transport, captured directly from the
 * harness UI after they've inspected the diagnostic print. Plan 04's parser
 * lifts this verbatim — the maintainer may still override during triage, but
 * the harness does not synthesise it from booleans (only a human can tell if
 * a thermal print "looks right").
 */
export type ProposedRung = 'verified' | 'partial' | 'failing';

/**
 * Identity-probe snapshot of a connected device, captured before any test
 * patterns run. Drivers that have a vendor-doc'd "what model are you?"
 * protocol fill `fwVersion` / `mtu` / etc.; reverse-engineered drivers may
 * leave most fields undefined and rely on the operator's `confirmed` block.
 *
 * This is intentionally a shallow record — every field is a hint for the
 * triage reviewer, not a load-bearing parse target.
 */
export interface IdentitySnapshot {
  /** Advertised name from the discovery layer (BLE adv data, USB iProduct). */
  advertisedName?: string;
  /** USB vendor id, when transport exposes one. */
  vid?: number;
  /** USB product id, when transport exposes one. */
  pid?: number;
  /** GATT services (UUID strings) discovered during BLE connect. */
  gattServices?: readonly string[];
  /**
   * Single observed GATT service UUID — populated on `bluetooth-gatt`
   * connects so the harness identity panel renders a stable one-line
   * identifier without joining the `gattServices` array. Plan 11
   * addition (per `IdentitySnapshot` rendering section).
   */
  serviceUuid?: string;
  /**
   * Serial port path / display name when the transport is `serial`
   * or OS-paired `bluetooth-spp`. Web Serial does not surface a
   * machine-readable port name; this is best-effort copy for the
   * triage reviewer. Plan 11 addition.
   */
  serialPath?: string;
  /**
   * Serial baud rate as opened. Useful for triage when an SPP /
   * USB-serial bridge default is wrong. Plan 11 addition.
   */
  serialBaud?: number;
  /** Firmware version, if the driver's identity probe extracts one. */
  fwVersion?: string;
  /** Negotiated MTU, when relevant (BLE GATT). */
  mtu?: number;
  /**
   * Free-form additional fields — drivers may surface protocol-specific
   * forensics here (paper sensor reading, head temperature, etc.). The
   * triage reviewer eyeballs these; the parser does not.
   */
  extra?: Readonly<Record<string, unknown>>;
}

/**
 * One transport's worth of test results inside a `HardwareReport`.
 *
 * `name` is a `TransportType` from `@thermal-label/contracts` (single source
 * of truth — see plan 0). `patterns` maps `TestPattern.id` → `PatternResult`,
 * recording mechanics only ("bytes went out" / "transport failed"); standard
 * convention is a single entry `{ diagnostic: 'pass' | 'fail' | 'skipped' }`
 * — the diagnostic-print pattern (plan 06). `rung` is the operator's direct
 * assessment of what came out of the printer, not derived from `patterns`.
 */
export interface TransportReport {
  name: TransportType;
  patterns: Readonly<Record<string, PatternResult>>;
  rung: ProposedRung;
  /** Free-form one-liner from the operator (e.g. "cut blade jammed"). */
  notes?: string;
}

/**
 * One engine's worth of assessment inside a `HardwareReport`.
 *
 * Multi-engine devices (Twin Turbo's left/right rolls, Duo's label/tape
 * engines) submit one `EngineReport` per engine the operator covered.
 * The harness emits an entry only for engines the operator actually
 * exercised; partial reports (one engine assessed, the other skipped)
 * are first-class — see plan 09 §rails-not-walls.
 *
 * `role` matches `PrintEngine.role` from `@thermal-label/contracts`
 * (`'label'`, `'tape'`, `'left'`, `'right'`, ...). `mediaKey` is the
 * media descriptor's id the operator selected for that engine (label
 * SKU on a label engine, D1 cassette id on the tape engine). `rung`
 * carries the operator's direct verdict on what came out of the head;
 * `notes` is the optional free-text caveat.
 *
 * Single-engine devices may omit the `engines[]` array on the report
 * entirely (legacy shape); the parser treats absence as "engine axis
 * not reported" and falls back to the transport-level rung.
 */
export interface EngineReport {
  /** Engine role — matches `PrintEngine.role` on the device entry. */
  role: string;
  /** Media descriptor id selected for this engine (label SKU / cassette id). */
  mediaKey: string;
  /** Operator's verdict on what came out of this engine's head. */
  rung: ProposedRung;
  /** Free-form one-liner specific to this engine's print. */
  notes?: string;
}

/**
 * The detected/confirmed identity pair captured at submit time.
 *
 * `detected` is the raw `IdentitySnapshot` from the identity probe (or what
 * the discovery layer surfaced if the driver has no probe). `confirmed`
 * carries any operator overrides — the model name they actually have in hand,
 * vid/pid corrections if the device misadvertises, etc.
 *
 * Triage compares the two. If the operator overrode anything, the issue body
 * makes it visible; the parser surfaces it for maintainer judgement.
 */
export interface DeviceIdentity {
  detected: IdentitySnapshot;
  confirmed: {
    /** Model name the operator confirmed (free-form, matched against catalog). */
    model: string;
    /** Operator-confirmed vid (overrides `detected.vid` if different). */
    vid?: number;
    /** Operator-confirmed pid (overrides `detected.pid` if different). */
    pid?: number;
    /** Any other field the operator overrode in the review/override panel. */
    overrides?: Readonly<Record<string, unknown>>;
    /**
     * Set when the operator ran a print on media the driver detected
     * but the harness catalogue couldn't name — the
     * `detected-unrecognized` flow. Carries the operator-confirmed
     * geometry and (when supplied) their free-text identifier. This is
     * the registry-contribution payload: an unknown roll reported once
     * becomes a catalogue candidate.
     *
     * Optional + additive — single-catalogue-media reports omit it,
     * and existing parsers are unaffected, so `schemaVersion` stays
     * `1` (no external schema consumers yet; maintainer-ruled while
     * the harness is pre-release).
     */
    customMedia?: {
      /** Operator free-text media id (DK-code / Dymo SKU / description). */
      identifier?: string;
      /** Operator-confirmed media width in mm. */
      widthMm: number;
      /** Operator-confirmed label length in mm; absent ⇒ continuous. */
      heightMm?: number;
      /** Operator-confirmed media type. */
      type: 'continuous' | 'die-cut';
    };
  };
}

/**
 * Optional reporter metadata. Never auto-filled with PII (see open question
 * in plan 03 §reporter PII); operator types `handle` voluntarily if they
 * want attribution.
 */
export interface ReporterInfo {
  handle?: string;
}

/**
 * The harness runtime + OS a report was produced on, captured at
 * submit time.
 *
 * Triage context only — never a parse target. The shape is flat and
 * runtime-tagged rather than a discriminated union: matching the rest
 * of this schema, every field past `runtime` + `os` is an optional
 * hint, not load-bearing. `runtime` says which fields to expect —
 * the browser apps fill `browser` / `browserVersion` / `userAgent`;
 * the verify-cli fills `nodeVersion`.
 *
 * For the `'browser'` runtime the source is the structured User-Agent
 * Client Hints API (the harness is Chromium-only — Web USB / Web
 * Bluetooth / Web Serial), with `userAgent` as the raw fallback. For
 * `'node'` it's `process` / `os`.
 *
 * Optional + additive on `HardwareReport` — pre-environment reports
 * omit it entirely, so `schemaVersion` stays `1`.
 */
export interface EnvironmentSnapshot {
  /**
   * Which harness runtime produced the report — the browser apps set
   * `'browser'`, the verify-cli sets `'node'`. Triage reads this to
   * know which runtime-specific fields below to expect.
   */
  runtime: 'browser' | 'node';
  /** Browser family — `'Chrome'`, `'Edge'`, `'Opera'`, `'Firefox'`, `'Safari'`, `'Unknown'`. `'browser'` runtime only. */
  browser?: string;
  /** Browser version — full from Client Hints, UA-string major otherwise. `'browser'` runtime only. */
  browserVersion?: string;
  /** Node.js version, e.g. `'22.3.0'`. `'node'` runtime only. */
  nodeVersion?: string;
  /** OS / platform — `'Windows'`, `'macOS'`, `'Linux'`, `'ChromeOS'`, `'Android'`, `'iOS'`. */
  os: string;
  /** OS version, when the runtime exposes one (Client Hints high-entropy value / `os.release()`). */
  osVersion?: string;
  /** True on a mobile form factor. `'browser'` runtime only. */
  mobile?: boolean;
  /** Raw `navigator.userAgent` — the triage ground-truth. `'browser'` runtime only. */
  userAgent?: string;
}

/**
 * JSON-safe snapshot of an `ESC V`-style print-engine version block.
 *
 * Driver-agnostic identity fields a triage reader needs to confirm
 * which firmware is running. Populated by the LW 5xx adapter from the
 * driver's `EngineVersion`; other drivers leave it absent. Every field
 * is optional — a driver fills what its protocol exposes.
 */
export interface EngineVersionSnapshot {
  /** Hardware version string. */
  hwVersion?: string;
  /** Firmware kind, e.g. `'application'` / `'bootloader'`. */
  fwKind?: string;
  /** Firmware version (driver-formatted — major/minor joined). */
  fwVersion?: string;
  /** Firmware release date, driver-formatted. */
  fwReleaseDate?: string;
  /** USB product id reported by the engine. */
  pid?: number;
  /**
   * The raw `ESC V` response, hex-encoded — the verbatim bytes the
   * decoded fields above were parsed from. Lets triage re-derive the
   * block when the parse is wrong or a firmware revision adds fields,
   * with no LW 5xx unit on hand to re-probe.
   */
  rawBytes?: string;
}

/**
 * JSON-safe snapshot of an `ESC U`-style SKU / consumable dump.
 *
 * Carries the roll-instance forensics beyond what `detectedMedia`
 * holds (material, counter strategy, production date, total label
 * count, ...). Populated by the LW 5xx adapter from the driver's
 * `SkuInfo`; the shape is intentionally a loose record — the triage
 * reviewer eyeballs it, the parser does not branch on it.
 *
 * Includes a `rawBytes` key: the hex-encoded verbatim `ESC U` response,
 * so triage can re-derive the dump when the parse is wrong.
 */
export type SkuInfoSnapshot = Readonly<Record<string, string | number | boolean>>;

/**
 * Live device-state captured across the print flow, embedded in a
 * `HardwareReport`.
 *
 * Each `*Status` is a {@link LeanStatus} — `rawBytes` hex plus
 * `ready` / `mediaLoaded` / `errors`. The decoded `details[]` table and
 * `detectedMedia` are deliberately dropped: both re-derive from
 * `rawBytes` (verify-cli replays the driver decode), and the report's
 * roll/media forensics already live in `skuInfo`. Keeping the block
 * lean is what lets a standard single-engine LW 5xx report fit GitHub's
 * prefill-URL limit and submit in one click — see {@link LeanStatus}.
 *
 * Every field is optional — the harness fills whatever the flow
 * reached. For a "nothing happens" report, `prePrintStatus` vs
 * `postPrintStatus` (byte-0 sub-state + job-ID echo) reveal whether the
 * job was accepted or silently dropped. Plan 13 §C.
 */
export interface ReportDiagnostics {
  /** `ESC A` status captured immediately before `printer.print()`. */
  prePrintStatus?: LeanStatus;
  /**
   * `ESC A` status captured immediately after `printer.print()`
   * resolved. Omitted when byte-identical to `prePrintStatus` — a clean
   * run leaves the two the same, and the duplicate is dead weight in
   * the prefill URL; the pair is carried only when the print actually
   * moved device state.
   */
  postPrintStatus?: LeanStatus;
  /** `ESC V` engine version block (LW 5xx). */
  engineVersion?: EngineVersionSnapshot;
  /** `ESC U` SKU dump (LW 5xx), beyond what `detectedMedia` carries. */
  skuInfo?: SkuInfoSnapshot;
}

/**
 * Top-level wire format for a hardware report.
 *
 * Embedded in a fenced ` ```json ` block inside a GitHub issue body. Plan
 * 04's parser greps for the block and parses it directly; the prose summary
 * above the JSON is for the maintainer's eyes only.
 */
export interface HardwareReport {
  /**
   * Bumped on any field-shape change. Plan 04's parser branches on this.
   * Always `1` for now; future versions add a discriminator and a migration.
   */
  schemaVersion: 1;
  /** Driver key — matches the driver's repo name (e.g. `'letratag'`). */
  driver: string;
  /** Driver `-core` package version the harness app was built against. */
  driverVersion: string;
  /** Harness app version (the `apps/harness-<driver>/` package version). */
  harnessVersion: string;
  device: DeviceIdentity;
  transports: readonly TransportReport[];
  /**
   * Per-engine assessment, when the device has multiple engines
   * (Twin Turbo left/right; Duo label/tape). Additive and optional —
   * single-engine reports omit it entirely. Plan 04's parser uses
   * presence of this array to surface per-engine rungs in the matrix
   * (e.g. "Duo verified on label, untested on tape"); absence means
   * "engine axis not reported" and the transport-level rung wins.
   *
   * Partial submissions (one of N engines exercised) are first-class
   * (plan 09 §rails-not-walls); the array carries entries only for
   * engines the operator actually assessed.
   */
  engines?: readonly EngineReport[];
  /**
   * Live device-state captured across the print flow — the pre/post-
   * print `ESC A` pair and (LW 5xx) the `ESC V` / `ESC U` blocks.
   * Optional and additive: a report without it is unchanged for old
   * parsers, so `schemaVersion` stays `1`. Plan 13 §C — makes a failed
   * report debuggable instead of a bare verdict.
   */
  diagnostics?: ReportDiagnostics;
  /**
   * The harness runtime + OS the report was produced on. Triage
   * context — additive and optional, so old parsers are unaffected
   * and `schemaVersion` stays `1`.
   */
  environment?: EnvironmentSnapshot;
  /** ISO-8601 timestamp at submit time. */
  submittedAt: string;
  reporter?: ReporterInfo;
}

// Photos intentionally not in the schema — operators drop them into the
// GitHub issue comment after submit using GitHub's native attachment UI. The
// harness doesn't host, upload, or carry photo bytes.
