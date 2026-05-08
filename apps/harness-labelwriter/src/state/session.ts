/**
 * Reactive session state for the harness flow.
 *
 * Each section reads/writes a slice of this store; the App component
 * observes the slices to drive section state (`pending` / `active` /
 * `done`). Plain Vue refs — no Pinia, no Vuex; the surface is small
 * enough that ceremony would cost more than it would buy.
 */
import { computed, reactive, ref } from 'vue';
import type { Transport } from '@thermal-label/contracts';
import type { LabelWriterDevice, LabelWriterMedia } from '@thermal-label/labelwriter-core';
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
 * (plan 08 §7a). Defaults populate from
 * `getPrintableArea(engine, media)` /
 * `getForcedTrailingFeedMm(engine)` when the operator opens the
 * calibration drawer; today those return zero on every LW engine
 * (phase 1 — no values populated yet). Operator can edit per session
 * and the values flow into the bitmap pipeline + ride along on the
 * submitted report.
 *
 * `null` for a field means "not yet initialised from defaults" (the
 * drawer hasn't been opened); `0` is a legitimate operator value.
 * The encoder layer reads `effective` values via
 * `useCalibration().override.value` and merges with engine defaults
 * for the no-touch case.
 */
export interface CalibrationState {
  /** Has the operator surfaced the calibration drawer this run? */
  drawerOpen: boolean;
  leadingMm: number;
  trailingMm: number;
  leftMm: number;
  rightMm: number;
  forcedTrailingFeedMm: number;
  /**
   * Snapshot of the engine defaults at drawer-open time. Captured
   * so the report's `offsetCalibration.defaults` can be filled in
   * without re-resolving and so the UI can show "default vs.
   * adjusted" diffs.
   */
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

export const device = ref<LabelWriterDevice | null>(null);
export const media = ref<LabelWriterMedia | null>(null);

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
export const hasMedia = computed(() => media.value !== null);
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
