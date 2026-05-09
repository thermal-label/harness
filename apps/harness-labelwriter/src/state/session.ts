/**
 * Reactive session state for the harness flow.
 *
 * Each section reads/writes a slice of this store; the App component
 * observes the slices to drive section state (`pending` / `active` /
 * `done`). Plain Vue refs — no Pinia, no Vuex; the surface is small
 * enough that ceremony would cost more than it would buy.
 *
 * Multi-engine model (plan 09): engine state lives in a per-role
 * `engines: Record<role, EngineSession>` map keyed by `PrintEngine.role`
 * (`'label'` / `'tape'` for Duo, `'left'` / `'right'` for Twin,
 * `'primary'` or whatever the device's first engine declares for
 * single-engine LWs). The active engine drives which slot the
 * MediaSection / PrintSection / AssessmentSection read and write.
 *
 * Single-engine devices use the same shape — the `engines` map carries
 * one entry — so the components don't carry a multi-engine branch in
 * their state-reads. The visual difference (tab strip vs flat flow)
 * happens at the App-shell layer, not in the per-section components.
 */
import { computed, reactive, ref } from 'vue';
import type { PrintEngine, Transport } from '@thermal-label/contracts';
import type { LabelWriterAnyMedia, LabelWriterDevice } from '@thermal-label/labelwriter-core';
import type { IdentitySnapshot, ProposedRung } from '@thermal-label/harness-core/shared';

export interface ConnectionState {
  /**
   * Active wire transports keyed by `PrintEngine.role`. Single-engine
   * devices and Twin (single transport, in-band roll-select) carry
   * one entry — the engine's `role` keys it. Duo carries two entries
   * — one per USB interface — so PrintSection writes to the right
   * one for the active engine.
   */
  transports: Record<string, Transport>;
  /** Identity probe results captured at connect time. */
  identity: IdentitySnapshot | null;
  /** Whether the connection is mocked (drives UI labelling). */
  mocked: boolean;
  /** Last connection error message, if any. */
  error: string | null;
}

/**
 * One engine's worth of operator-driven state — media pick, print
 * status, assessment rung + notes. Multi-engine devices accumulate
 * one of these per `PrintEngine.role`; single-engine devices have
 * exactly one entry keyed by the engine's role.
 */
export interface EngineSession {
  /** The engine this slot belongs to (kept here for convenience). */
  engine: PrintEngine;
  /** Operator-picked media for this engine. */
  media: LabelWriterAnyMedia | null;
  /** Has a diagnostic print been written successfully? */
  printed: boolean;
  /** Operator's verdict on what came out of this engine's head. */
  rung: ProposedRung | null;
  /** Free-form notes scoped to this engine's print. */
  notes: string;
}

export interface SubmitState {
  /** Has the operator submitted the report? */
  submitted: boolean;
  /** Last issue URL (for "open again" links). */
  issueUrl: string | null;
}

export const connection = reactive<ConnectionState>({
  transports: {},
  identity: null,
  mocked: false,
  error: null,
});

export const device = ref<LabelWriterDevice | null>(null);

/**
 * Per-engine session map. Populated when `device` is set (Connect /
 * Identity flow); cleared on reset. Keys are `PrintEngine.role`.
 */
export const engineSessions = reactive<Record<string, EngineSession>>({});

/**
 * Currently-active engine role. Drives which `EngineSession` the
 * Media/Print/Assessment sections read and write. Defaults to the
 * device's first engine; switches on tab click for multi-engine
 * devices.
 */
export const selectedRole = ref<string | null>(null);

export const submitState = reactive<SubmitState>({
  submitted: false,
  issueUrl: null,
});

/**
 * Initialise per-engine session slots from a freshly-resolved device.
 * Idempotent — calling it on the same device leaves slots intact so
 * the operator's progress survives a re-render. Removes slots for any
 * engines that no longer appear (e.g. after a manual model override).
 */
export function syncEngineSessions(d: LabelWriterDevice | null): void {
  // Use Reflect.deleteProperty to satisfy
  // `@typescript-eslint/no-dynamic-delete` — the rule flags `delete
  // obj[key]` patterns even when `key` is iterated from `Object.keys`.
  if (!d) {
    for (const role of Object.keys(engineSessions)) {
      Reflect.deleteProperty(engineSessions, role);
    }
    selectedRole.value = null;
    return;
  }
  const seen = new Set<string>();
  for (const eng of d.engines) {
    seen.add(eng.role);
    const existing = engineSessions[eng.role];
    if (!existing) {
      engineSessions[eng.role] = {
        engine: eng,
        media: null,
        printed: false,
        rung: null,
        notes: '',
      };
    } else {
      // Refresh the engine reference in case the device override
      // re-pointed it (different `bind` / capabilities between
      // confusable models).
      existing.engine = eng;
    }
  }
  for (const role of Object.keys(engineSessions)) {
    if (!seen.has(role)) Reflect.deleteProperty(engineSessions, role);
  }
  if (selectedRole.value === null || !seen.has(selectedRole.value)) {
    selectedRole.value = d.engines[0]?.role ?? null;
  }
}

export const isConnected = computed(() => Object.keys(connection.transports).length > 0);
export const hasIdentity = computed(() => Boolean(connection.identity && device.value));
export const activeSession = computed<EngineSession | null>(() => {
  const role = selectedRole.value;
  if (!role) return null;
  return engineSessions[role] ?? null;
});

/**
 * Per-engine status for tab badges (empty / `…` / `✓`). Drives the
 * EngineTabs component's badge rendering and the ReportCard's
 * coverage list.
 */
export type EngineBadge = 'empty' | 'in-progress' | 'done';

export function badgeFor(session: EngineSession | undefined): EngineBadge {
  if (!session) return 'empty';
  if (session.rung !== null) return 'done';
  if (session.media !== null || session.printed) return 'in-progress';
  return 'empty';
}

/**
 * How many engines have been assessed (rung set). Used to gate the
 * Submit button copy ("Submit verification report" vs "Submit partial
 * report (1 of 2 engines tested)").
 */
export const assessedCount = computed(() => {
  return Object.values(engineSessions).filter(s => s.rung !== null).length;
});

export const totalEngines = computed(() => {
  return device.value?.engines.length ?? 0;
});

/** Submit gates on `≥1 engine assessed`. Plan 09 §rails-not-walls. */
export const canSubmit = computed(() => assessedCount.value >= 1);

/**
 * Reset the session — used by "test again" flows. Keeps the device
 * pick (so picking a printer once is enough), drops everything else.
 */
export function resetForNewRun(): void {
  for (const t of Object.values(connection.transports)) {
    void t; // closing handled at the connect layer
  }
  connection.transports = {};
  connection.identity = null;
  connection.error = null;
  // `connection.mocked` keeps its value — mock mode is URL-driven.
  for (const s of Object.values(engineSessions)) {
    s.media = null;
    s.printed = false;
    s.rung = null;
    s.notes = '';
  }
  submitState.submitted = false;
  submitState.issueUrl = null;
}
