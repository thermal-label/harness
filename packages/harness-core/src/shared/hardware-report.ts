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
export type ProposedRung = 'verified' | 'partial' | 'unsupported';

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
 * Operator-supplied printable-area / forced-trailing-feed measurements
 * captured during a verification session (plan 08 §7a).
 *
 * The harness exposes optional override inputs for the four
 * `PrintableArea` edges plus `forcedTrailingFeedMm`, defaulted from
 * `getPrintableArea(engine, media)`. The operator may dial the values
 * in to match their specific printer + roll combination, then iterate
 * print → measure → re-print until the borders look right.
 *
 * The override values are NOT persisted into the driver-core registry
 * from the harness — that would let any reporter mutate the canonical
 * spec. Instead they ride along on the report as evidence, and the
 * maintainer triages and folds confirmed measurements back into the
 * registry via PR.
 *
 * Every field is optional and additive. Schema does not bump
 * `schemaVersion` — older parsers ignore unknown fields. When all
 * fields are absent or zero the operator did not adjust the defaults.
 *
 * Field naming mirrors `PrintableArea` from `@thermal-label/contracts`:
 * `leading` / `trailing` (feed-direction) and `left` / `right`
 * (head-axis), all in millimetres.
 */
export interface OffsetCalibration {
  /** Operator override for `PrintableArea.leading`, in mm. */
  leadingMm?: number;
  /** Operator override for `PrintableArea.trailing`, in mm. */
  trailingMm?: number;
  /** Operator override for `PrintableArea.left`, in mm. */
  leftMm?: number;
  /** Operator override for `PrintableArea.right`, in mm. */
  rightMm?: number;
  /** Operator override for `PrintEngine.forcedTrailingFeedMm`. */
  forcedTrailingFeedMm?: number;
  /**
   * The default values resolved from `getPrintableArea(engine, media)`
   * before the operator edited anything. Captured so triage can tell
   * "operator confirmed the default" apart from "operator typed a
   * value that happens to equal the default".
   */
  defaults?: {
    leadingMm: number;
    trailingMm: number;
    leftMm: number;
    rightMm: number;
    forcedTrailingFeedMm: number;
  };
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
 *
 * `offsetCalibration` (plan 08 §7a) is an additive evidence field —
 * the operator's per-session printable-area / trailing-feed overrides.
 * Older parsers ignore it. Absent when the operator did not surface
 * the calibration drawer or did not change any default.
 */
export interface TransportReport {
  name: TransportType;
  patterns: Readonly<Record<string, PatternResult>>;
  rung: ProposedRung;
  /** Free-form one-liner from the operator (e.g. "cut blade jammed"). */
  notes?: string;
  /**
   * Per-session printable-area / trailing-feed overrides supplied by
   * the operator for calibration (plan 08 §7a). Strictly additive —
   * absence means "operator did not adjust the defaults".
   */
  offsetCalibration?: OffsetCalibration;
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
  /** ISO-8601 timestamp at submit time. */
  submittedAt: string;
  reporter?: ReporterInfo;
}

// Photos intentionally not in the schema — operators drop them into the
// GitHub issue comment after submit using GitHub's native attachment UI. The
// harness doesn't host, upload, or carry photo bytes.
