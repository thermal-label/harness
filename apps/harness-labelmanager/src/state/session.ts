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
}
