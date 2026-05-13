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
 * decided at HarnessShell render time from `device.engines.length`.
 *
 * Post-harness-v2: the connection holds a `PrinterAdapter` (from
 * `@thermal-label/contracts`) — every protocol-level operation is
 * delegated through the driver, not bypassed. Per-engine status
 * snapshots come from `printer.getStatus()` polled every 4 s (or
 * pushed via `printer.onStatus` when the driver supplies it).
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
import type { PrintEngine, PrinterAdapter, PrinterStatus } from '@thermal-label/contracts';
import type { IdentitySnapshot, ProposedRung } from '@thermal-label/harness-core/shared';
import { useAdapter } from './adapterContext';
import type { BrowserTransport, EngineSession } from '../types';

export interface ConnectionState {
  /**
   * The connected per-engine `PrinterAdapter` map (keyed by engine
   * role). Null when not connected. The shell looks up the active
   * adapter via `printers[selectedRole]` and exposes it through the
   * `activePrinter` computed for PrintSection / MediaSection /
   * BitmapPreview so they call `printer.print()` / `createPreview()`
   * / `getStatus()` without re-implementing the protocol layer.
   *
   * Single-engine drivers (LM, QL, most LW) populate a 1-key record;
   * multi-engine drivers (LW Twin Turbo, LW Duo family) populate one
   * entry per engine — each scoped to its own engine and (for the
   * Duo) its own claimed USB interface.
   */
  printers: Record<string, PrinterAdapter> | null;
  /** Identity probe results captured at connect time. */
  identity: IdentitySnapshot | null;
  /**
   * Transport the operator picked in §1. Drives the identity-panel
   * rendering branch in ConnectSection (USB → vid/pid, Serial/SPP →
   * port/baud, GATT → service UUID). `null` before connect.
   *
   * Plan 11 addition.
   */
  transport: BrowserTransport | null;
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
   * Latest `PrinterStatus` snapshot, keyed by engine role. Single-engine
   * drivers populate one slot; multi-engine devices (LW Duo: `label` +
   * `tape`) populate one slot per engine, each fed by its own poll
   * loop. The reactive object lets sections read
   * `printerStatus[role]` directly, and the `activeStatus` computed
   * routes the active engine's slot to the section pills without the
   * call sites having to know about engine roles.
   *
   * Pre-refactor this was a single `Ref<PrinterStatus | null>` shared
   * across every poll loop — the Duo's tape and label engines
   * clobbered each other (whichever wrote last is what every tab
   * rendered). The keyed shape resolves that.
   */
  printerStatus: Record<string, PrinterStatus | null>;

  // Derived computeds
  isConnected: ComputedRef<boolean>;
  hasIdentity: ComputedRef<boolean>;
  /**
   * The `PrinterAdapter` currently driving section interactions.
   * Resolves to `printers[selectedRole]` — flips automatically when
   * the operator switches engine tabs. Null when not connected.
   */
  activePrinter: ComputedRef<PrinterAdapter | null>;
  /**
   * Currently-displayed engine's status snapshot. Resolves to
   * `printerStatus[selectedRole]` — flips automatically on tab switch
   * without restarting either engine's poll loop.
   */
  activeStatus: ComputedRef<PrinterStatus | null>;
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
  const connection = reactive({
    printers: null,
    identity: null,
    transport: null,
    mocked: false,
    error: null,
  }) as ConnectionState;

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
  const printerStatus = reactive({}) as Record<string, PrinterStatus | null>;

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
    connection.printers = null;
    connection.identity = null;
    connection.transport = null;
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
    for (const role of Object.keys(printerStatus)) {
      Reflect.deleteProperty(printerStatus, role);
    }
  }

  const isConnected = computed(() => connection.printers !== null);
  const hasIdentity = computed(() => Boolean(connection.identity && device.value));
  const activePrinter = computed<PrinterAdapter | null>(() => {
    const map = connection.printers;
    if (!map) return null;
    const role = selectedRole.value;
    if (role && map[role]) return map[role];
    // Fallback to the first available adapter — keeps section logic
    // resilient to a transient null `selectedRole` between connect
    // and the engine-tabs init.
    const firstRole = Object.keys(map)[0];
    return firstRole ? (map[firstRole] ?? null) : null;
  });
  const activeStatus = computed<PrinterStatus | null>(() => {
    const role = selectedRole.value;
    if (!role) return null;
    return printerStatus[role] ?? null;
  });
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
    printerStatus,
    isConnected,
    hasIdentity,
    activePrinter,
    activeStatus,
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
