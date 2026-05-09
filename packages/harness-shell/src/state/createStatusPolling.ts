/**
 * Generic status polling helper.
 *
 * Reads the adapter's `status` config:
 *
 *   - `kind: 'poll'` — sets up a `setInterval` calling `read(transport,
 *     device)` every `intervalMs` (default 4 s). Status snapshots flow
 *     into `session.printerStatus`.
 *   - `kind: 'subscribe'` — calls `subscribe(transport, device)` and
 *     pipes the returned `latest` ref into `session.printerStatus`.
 *
 * Multi-engine devices: today's drivers poll the FIRST engine's
 * transport (LW Duo polls the label engine, tape engine status is
 * unchecked — documented placeholder). Per-engine polling is a
 * follow-on. The helper accepts a `transport` argument so adapters
 * can drive per-engine polling later by calling it once per engine.
 */
import type { PrintEngine, Transport } from '@thermal-label/contracts';
import type { StatusConfig } from '../types';

export interface PollHandle {
  stop: () => void | Promise<void>;
}

/**
 * Setter for status snapshots — abstract so the caller can route
 * them per-engine (`engineStatuses[role] = status`) or into a
 * single ref. The shell uses the per-engine variant on multi-engine
 * devices so the active-tab pill reflects the right engine.
 */
export type StatusSink<TStatus> = (status: TStatus | null) => void;

export function startStatusPolling<TDevice, TStatus>(opts: {
  config: StatusConfig<TDevice, TStatus>;
  transport: Transport;
  device: TDevice;
  /**
   * The engine this poller is running against. Passed through to
   * `read(transport, device, engine)` so adapters can branch on
   * `engine.protocol` (LW Duo: `lw-450` paper vs `d1-tape` tape
   * use different parsers off the same `ESC A` reply byte).
   */
  engine: PrintEngine;
  /** Where to write status snapshots. */
  sink: StatusSink<TStatus>;
  /** Optional initial seed — set once before the first read lands. */
  initial?: TStatus | null;
}): PollHandle {
  if (opts.initial !== undefined) {
    opts.sink(opts.initial);
  }

  if (opts.config.kind === 'subscribe') {
    const subConfig = opts.config;
    let unsub: (() => Promise<void>) | null = null;
    // Wrapped in a single-element box so the async iife can read the
    // latest value after `stop()` has flipped it. ESLint flags `let`
    // + closure read as "always falsy when read" because of CFA
    // narrowing inside the iife; the box sidesteps that and reflects
    // the real concurrent-write semantics.
    const cancelled: { value: boolean } = { value: false };
    void (async () => {
      try {
        const handle = await subConfig.subscribe(opts.transport, opts.device, opts.engine);
        if (cancelled.value) {
          await handle.unsubscribe();
          return;
        }
        unsub = handle.unsubscribe;
        // Mirror the latest ref into the session-level target. We
        // can't simply assign — Vue refs aren't aliasable — so we
        // watch instead. Imported lazily to avoid circular deps.
        const { watch } = await import('vue');
        watch(
          handle.latest,
          v => {
            opts.sink(v);
          },
          { immediate: true },
        );
      } catch {
        // Subscribe failed — leave target null. Caller surfaces
        // via the Connect-section error path if relevant.
        opts.sink(null);
      }
    })();
    return {
      stop: async () => {
        cancelled.value = true;
        if (unsub) {
          try {
            await unsub();
          } catch {
            // Best-effort. Subscribe drivers' unsub is idempotent.
          }
        }
      },
    };
  }

  // Poll branch.
  const interval = opts.config.intervalMs ?? 4000;
  let inFlight = false;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const status = await (opts.config as Extract<typeof opts.config, { kind: 'poll' }>).read(
        opts.transport,
        opts.device,
        opts.engine,
      );
      opts.sink(status);
      // Dev-only: surface poll cadence + raw bytes so the operator
      // can watch in DevTools whether the firmware is updating its
      // status response in real time (e.g. when removing the tape
      // mid-session). Production builds skip this.
      if (import.meta.env.DEV) {
        const raw = (status as { rawBytes?: Uint8Array } | null)?.rawBytes;
        const hex = raw
          ? Array.from(raw)
              .slice(0, 16)
              .map(b => b.toString(16).padStart(2, '0'))
              .join(' ')
          : '(no raw)';
        // eslint-disable-next-line no-console -- dev-mode diagnostic; gated by import.meta.env.DEV
        console.debug('[status] poll →', hex, status);
      }
    } catch (err) {
      // Silent — a missed poll keeps the LAST known status so
      // downstream computeds (status pills, mediaPicker.detected)
      // don't flicker between known-good and null on every transient
      // read failure. Sustained outage just freezes the snapshot;
      // disconnect clears it via the caller's stop() path.
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console -- dev-mode diagnostic; gated by import.meta.env.DEV
        console.debug('[status] poll failed →', err);
      }
    } finally {
      inFlight = false;
    }
  };
  // Fire one immediate read so the dot resolves quickly; then poll.
  void tick();
  const handle = setInterval(() => {
    void tick();
  }, interval);
  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}
