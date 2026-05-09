/**
 * Reactive session state for the harness flow — generic over the
 * driver's device + media types via the adapter.
 *
 * Single store per page, provided at the root by `provideSession()`
 * (called inside HarnessShell's setup) and read by every section via
 * `useSession()`. Mirrors the shape the per-driver apps had pre-lift,
 * with one normalisation: every device is treated as multi-engine
 * internally (single-engine devices have one entry in
 * `engineSessions` keyed by the engine's role). Tab visibility is
 * decided at HarnessShell render time via the adapter's
 * `multiEngine.isMultiEngine` callback — single-engine devices stay
 * flat regardless.
 */
import {
  computed,
  inject,
  provide,
  reactive,
  ref,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from 'vue';
import type { PrintEngine, Transport } from '@thermal-label/contracts';
import type { IdentitySnapshot, ProposedRung } from '@thermal-label/harness-core/shared';
import { useAdapter } from './adapterContext';
import type { EngineSession } from '../types';

export interface ConnectionState {
  /**
   * Per-engine wire transports keyed by `PrintEngine.role`. Single-
   * engine devices and Twin-style chassis (in-band roll-select)
   * carry one entry; Duo carries two — one per USB interface. Empty
   * map means "not connected".
   */
  transports: Record<string, Transport>;
  /** Identity probe results captured at connect time. */
  identity: IdentitySnapshot | null;
  /** Whether the connection is mocked (drives UI labelling). */
  mocked: boolean;
  /** Last connection error message, if any. */
  error: string | null;
}

export interface SubmitState {
  /** Has the operator submitted the report? */
  submitted: boolean;
  /** Last issue URL (for "open again" links). */
  issueUrl: string | null;
}

export type EngineBadge = 'empty' | 'in-progress' | 'done';

export function badgeFor<TMedia>(session: EngineSession<TMedia> | undefined): EngineBadge {
  if (!session) return 'empty';
  if (session.rung !== null) return 'done';
  if (session.media !== null || session.printed) return 'in-progress';
  return 'empty';
}

export interface Session<TDevice, TMedia> {
  connection: ConnectionState;
  device: Ref<TDevice | null>;
  /** Per-engine session map, populated after connect, cleared on reset. */
  engineSessions: Record<string, EngineSession<TMedia>>;
  /** Active engine role; drives which session slot the sections read/write. */
  selectedRole: Ref<string | null>;
  submitState: SubmitState;
  /**
   * Latest status read keyed by engine role. Multi-engine devices
   * (LW Duo) get one slot per engine; single-engine and Twin (which
   * shares one transport across two engines) write to one slot
   * each. Polling fans out per-engine — see ConnectSection's
   * connect path.
   */
  engineStatuses: Record<string, unknown>;
  /**
   * Convenience computed pointing at the active engine's status
   * (`engineStatuses[selectedRole]`). Falls back to the first
   * engine's status when no engine is selected. Sections that
   * surface engine-specific UX (MediaSection's loaded-media pill)
   * read this; sections surfacing chassis-level UX (ConnectSection's
   * printer-ready pill) currently read this too — chassis-aggregate
   * is a follow-on.
   */
  printerStatus: ComputedRef<unknown>;

  // Derived computeds
  isConnected: ComputedRef<boolean>;
  hasIdentity: ComputedRef<boolean>;
  activeSession: ComputedRef<EngineSession<TMedia> | null>;
  activeEngine: ComputedRef<PrintEngine | null>;
  assessedCount: ComputedRef<number>;
  totalEngines: ComputedRef<number>;
  canSubmit: ComputedRef<boolean>;

  // Mutators (kept here so consumers don't reach into the reactive
  // structure to wire engineSessions correctly).
  syncEngineSessions: (d: TDevice | null) => void;
  resetForNewRun: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SESSION_KEY: InjectionKey<Session<any, any>> = Symbol('thermal-label.harness.session');

/**
 * Build the session store. Called from `useSession()` lazily — the
 * adapter must be available via `useAdapter()`.
 */
function createSession<TDevice, TMedia>(opts: {
  /**
   * Resolve the engine list from a connected device. Adapters whose
   * device shape carries `engines: PrintEngine[]` (LW, future
   * brother-ql) just return `device.engines`; LM-style single-engine
   * drivers synthesise a single-element list.
   */
  getEngines: (d: TDevice) => readonly PrintEngine[];
}): Session<TDevice, TMedia> {
  const connection: ConnectionState = reactive({
    transports: {},
    identity: null,
    mocked: false,
    error: null,
  });

  const device = ref<TDevice | null>(null) as Ref<TDevice | null>;
  // `reactive` widens the value type to a Proxy of the original; a
  // simple TS-level cast keeps the per-call assertions out of consumer
  // sites without changing runtime shape.
  const engineSessions = reactive({}) as Record<string, EngineSession<TMedia>>;
  const selectedRole = ref<string | null>(null);
  const submitState: SubmitState = reactive({
    submitted: false,
    issueUrl: null,
  });
  const engineStatuses = reactive({}) as Record<string, unknown>;
  const printerStatus = computed<unknown>(() => {
    const role = selectedRole.value;
    if (role && role in engineStatuses) return engineStatuses[role];
    // Fall back to the first available status — covers the case
    // where `selectedRole` hasn't been set yet (initial render).
    const firstKey = Object.keys(engineStatuses)[0];
    return firstKey ? engineStatuses[firstKey] : null;
  });

  function syncEngineSessions(d: TDevice | null): void {
    if (!d) {
      for (const role of Object.keys(engineSessions)) {
        Reflect.deleteProperty(engineSessions, role);
      }
      selectedRole.value = null;
      return;
    }
    const engines = opts.getEngines(d);
    const seen = new Set<string>();
    for (const eng of engines) {
      seen.add(eng.role);
      const existing = engineSessions[eng.role];
      if (!existing) {
        const slot: EngineSession<TMedia> = {
          engine: eng,
          media: null,
          printed: false,
          rung: null,
          notes: '',
        };
        engineSessions[eng.role] = slot;
      } else {
        existing.engine = eng;
      }
    }
    for (const role of Object.keys(engineSessions)) {
      if (!seen.has(role)) Reflect.deleteProperty(engineSessions, role);
    }
    if (selectedRole.value === null || !seen.has(selectedRole.value)) {
      selectedRole.value = engines[0]?.role ?? null;
    }
  }

  function resetForNewRun(): void {
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
    for (const role of Object.keys(engineStatuses)) {
      Reflect.deleteProperty(engineStatuses, role);
    }
  }

  const isConnected = computed(() => Object.keys(connection.transports).length > 0);
  const hasIdentity = computed(() => Boolean(connection.identity && device.value));
  const activeSession = computed<EngineSession<TMedia> | null>(() => {
    const role = selectedRole.value;
    if (!role) return null;
    return engineSessions[role] ?? null;
  });
  const activeEngine = computed<PrintEngine | null>(() => {
    return activeSession.value?.engine ?? null;
  });
  const assessedCount = computed(
    () => Object.values(engineSessions).filter(s => s.rung !== null).length,
  );
  const totalEngines = computed(() => {
    const d = device.value;
    if (!d) return 0;
    return opts.getEngines(d).length;
  });
  const canSubmit = computed(() => assessedCount.value >= 1);

  return {
    connection,
    device,
    engineSessions,
    selectedRole,
    submitState,
    engineStatuses,
    printerStatus,
    isConnected,
    hasIdentity,
    activeSession,
    activeEngine,
    assessedCount,
    totalEngines,
    canSubmit,
    syncEngineSessions,
    resetForNewRun,
  };
}

/**
 * Shape every adapter is expected to expose for engine resolution.
 * The shell falls back to reading `(d as { engines? }).engines` when
 * the adapter doesn't carry a custom resolver — safe because every
 * driver-core device shape today carries `engines: PrintEngine[]`.
 */
function resolveEngines(d: unknown): readonly PrintEngine[] {
  const engines = (d as { engines?: readonly PrintEngine[] } | null)?.engines;
  if (Array.isArray(engines)) return engines as readonly PrintEngine[];
  return [];
}

export function provideSession<TDevice, TMedia>(): Session<TDevice, TMedia> {
  // The adapter is read at session-creation time only for
  // forward-compat (the resolver could vary per-driver). Today every
  // adapter's device shape carries `engines`, so we use the default
  // `resolveEngines`.
  void useAdapter();
  const session = createSession<TDevice, TMedia>({ getEngines: resolveEngines });
  provide(SESSION_KEY, session);
  return session;
}

export function useSession<TDevice, TMedia>(): Session<TDevice, TMedia> {
  // Allow lazy provide-on-first-use so HarnessShell doesn't need a
  // separate setup hook ordering: any `useSession()` call before
  // `provideSession()` falls through to creating the store and
  // providing it. `inject()` returns undefined when nothing's
  // provided; we then call `provideSession()` to register one.
  const existing = inject(SESSION_KEY, null);
  if (existing) return existing as Session<TDevice, TMedia>;
  return provideSession<TDevice, TMedia>();
}

export type { EngineSession };

// Re-export the rung type for adapters that build sessions outside
// the shell (test harnesses).
export type { ProposedRung };
