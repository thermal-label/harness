/**
 * Reactive session state for the harness flow.
 *
 * Each section reads/writes a slice of this store; the App component
 * observes the slices to drive section state (`pending` / `active` /
 * `done`). Plain Vue refs — no Pinia, no Vuex; the surface is small
 * enough that ceremony would cost more than it would buy.
 *
 * Labelmanager-specific shape diff vs labelwriter:
 *  - The operator picks a D1 cartridge from the shared catalogue
 *    (`MEDIA_LIST` from `@thermal-label/labelmanager-core`). Tape
 *    width comes from `media.value.tapeWidthMm`; the colour pair
 *    drives the `ESC C n` tape-type byte the encoder emits.
 *  - No SKU / NFC probe state — labelmanager firmware can't detect
 *    the cartridge, so the picker is always operator-driven.
 */
import { computed, reactive, ref } from 'vue';
import type { PrinterStatus, Transport } from '@thermal-label/contracts';
import {
  DEFAULT_MEDIA,
  parseStatus,
  STATUS_REQUEST,
  type LabelManagerDevice,
  type LabelManagerMedia,
} from '@thermal-label/labelmanager-core';
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

/**
 * Selected D1 cartridge. Always set — defaults to `DEFAULT_MEDIA`
 * (12 mm Black-on-White STANDARD), the maintainer's bench tape and
 * the most common D1 SKU.
 */
export const media = ref<LabelManagerMedia>(DEFAULT_MEDIA);

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
 * Media is always set (default DEFAULT_MEDIA), so this gate fires
 * once identity is confirmed. Surfaced as a named computed for
 * symmetry with labelwriter's `hasMedia`; the section gating reads
 * it. MediaSection drives its own pending/active/done state from a
 * "touched" flag so the operator sees an `active` step until they
 * explicitly confirm the default is right.
 */
export const hasMedia = computed(() => hasIdentity.value);
export const hasPrinted = computed(() => submitState.printed);
export const hasAssessment = computed(() => assessment.rung !== null);

/**
 * Convenience computed for the "head emits N dots" hint surfaced in
 * the picker / identity sections. Derived from `media.value.tapeWidthMm`
 * so consumers don't need to import `LabelManagerMedia` just to read
 * the width.
 */
export const tapeWidth = computed(() => media.value.tapeWidthMm);

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
  stopStatusPolling();
  printerStatus.value = null;
}

// ─── Live printer-status polling ─────────────────────────────────

/**
 * Latest D1 status reply (cassette presence + ready/error bits).
 * `null` when no read has succeeded yet, or when the connection has
 * been torn down. Polled every `STATUS_POLL_MS` while connected so
 * the UI feels alive — cassette swap or paper jam shows up within a
 * few seconds without the operator having to reload.
 */
export const printerStatus = ref<PrinterStatus | null>(null);

const STATUS_POLL_MS = 4000;
const STATUS_RESPONSE_BYTES = 64;
const STATUS_TIMEOUT_MS = 1500;
let pollHandle: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;

async function readStatusOnce(transport: Transport): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    await transport.write(STATUS_REQUEST);
    const response = await transport.read(STATUS_RESPONSE_BYTES, STATUS_TIMEOUT_MS);
    printerStatus.value = parseStatus(response);
  } catch {
    // Silent — a missed poll just leaves the dot grey for one cycle.
    // A sustained outage shows up as a stale `printerStatus` (caller
    // can compare timestamps if needed); for the dot UX a single
    // failed read is noise, not signal.
    printerStatus.value = null;
  } finally {
    pollInFlight = false;
  }
}

export function startStatusPolling(transport: Transport, initial?: PrinterStatus | null): void {
  stopStatusPolling();
  if (initial) printerStatus.value = initial;
  pollHandle = setInterval(() => {
    void readStatusOnce(transport);
  }, STATUS_POLL_MS);
}

export function stopStatusPolling(): void {
  if (pollHandle !== null) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  pollInFlight = false;
}
