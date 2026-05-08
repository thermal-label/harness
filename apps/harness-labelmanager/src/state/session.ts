/**
 * Reactive session state for the harness flow.
 *
 * Each section reads/writes a slice of this store; the App component
 * observes the slices to drive section state (`pending` / `active` /
 * `done`). Plain Vue refs — no Pinia, no Vuex; the surface is small
 * enough that ceremony would cost more than it would buy.
 *
 * Labelmanager-specific shape diff vs labelwriter:
 *  - No media catalog; the operator picks a `tapeWidth` (6/9/12/19 mm).
 *    Default 12 mm (the maintainer's bench unit).
 *  - No SKU / NFC probe state.
 *  - `forcedTrailingFeedMm` is load-bearing on labelmanager (the
 *    chassis post-print feed advance), unlike labelwriter where it's
 *    informational today.
 */
import { computed, reactive, ref } from 'vue';
import type { Transport } from '@thermal-label/contracts';
import type { LabelManagerDevice, TapeWidth } from '@thermal-label/labelmanager-core';
import type { IdentitySnapshot, ProposedRung } from '@thermal-label/harness-core/shared';

export interface ConnectionState {
  /** Active wire transport (real WebUsbTransport or MockTransport). */
  transport: Transport | null;
  /** Identity probe results captured at connect time. */
  identity: IdentitySnapshot | null;
  /** Whether the connection is mocked (drives UI labelling). */
  mocked: boolean;
  /** Last connection error message, if any. */
  error: string | null;
}

export interface AssessmentState {
  rung: ProposedRung | null;
  notes: string;
}

/**
 * Per-session printable-area / forced-trailing-feed overrides
 * (plan 08 §7a). Defaults populate from `getPrintableArea(engine)` /
 * `getForcedTrailingFeedMm(engine)` when the operator opens the
 * calibration drawer; on labelmanager the registry today carries
 * `leading: 8 mm` / `forcedTrailingFeedMm: 8 mm` on every entry, so
 * the defaults are non-zero out of the box.
 */
export interface CalibrationState {
  /** Has the operator surfaced the calibration drawer this run? */
  drawerOpen: boolean;
  leadingMm: number;
  trailingMm: number;
  leftMm: number;
  rightMm: number;
  forcedTrailingFeedMm: number;
  /** Snapshot of the engine defaults; report includes for evidence. */
  defaults: {
    leadingMm: number;
    trailingMm: number;
    leftMm: number;
    rightMm: number;
    forcedTrailingFeedMm: number;
  };
  /** Whether the operator changed any value away from the default. */
  edited: boolean;
}

export interface SubmitState {
  /** Has the print byte stream been written successfully? */
  printed: boolean;
  /** Has the operator submitted the report? */
  submitted: boolean;
  /** Last issue URL (for "open again" links). */
  issueUrl: string | null;
}

export const connection = reactive<ConnectionState>({
  transport: null,
  identity: null,
  mocked: false,
  error: null,
});

export const device = ref<LabelManagerDevice | null>(null);

/** Default to 12 mm — the maintainer's bench tape and the most common D1 width. */
export const tapeWidth = ref<TapeWidth>(12);

export const assessment = reactive<AssessmentState>({
  rung: null,
  notes: '',
});

export const submitState = reactive<SubmitState>({
  printed: false,
  submitted: false,
  issueUrl: null,
});

export const calibration = reactive<CalibrationState>({
  drawerOpen: false,
  leadingMm: 0,
  trailingMm: 0,
  leftMm: 0,
  rightMm: 0,
  forcedTrailingFeedMm: 0,
  defaults: {
    leadingMm: 0,
    trailingMm: 0,
    leftMm: 0,
    rightMm: 0,
    forcedTrailingFeedMm: 0,
  },
  edited: false,
});

export const isConnected = computed(() => connection.transport !== null);
export const hasIdentity = computed(() => Boolean(connection.identity && device.value));
/**
 * Tape width is always set (default 12), so this gate fires once
 * identity is confirmed. Surfaced as a named computed for symmetry
 * with labelwriter's `hasMedia`; the section gating reads it.
 */
export const hasTape = computed(() => hasIdentity.value);
export const hasPrinted = computed(() => submitState.printed);
export const hasAssessment = computed(() => assessment.rung !== null);

/**
 * Reset the session — used by "test again" flows. Keeps the device
 * pick (so picking a printer once is enough), drops everything else.
 */
export function resetForNewRun(): void {
  connection.transport = null;
  connection.identity = null;
  connection.error = null;
  // `connection.mocked` keeps its value — mock mode is URL-driven.
  assessment.rung = null;
  assessment.notes = '';
  submitState.printed = false;
  submitState.submitted = false;
  submitState.issueUrl = null;
  calibration.drawerOpen = false;
  calibration.leadingMm = calibration.defaults.leadingMm;
  calibration.trailingMm = calibration.defaults.trailingMm;
  calibration.leftMm = calibration.defaults.leftMm;
  calibration.rightMm = calibration.defaults.rightMm;
  calibration.forcedTrailingFeedMm = calibration.defaults.forcedTrailingFeedMm;
  calibration.edited = false;
}
