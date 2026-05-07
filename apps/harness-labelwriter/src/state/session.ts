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
}
