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
import type { Transport } from '@thermal-label/contracts';
import type { Ref } from 'vue';
import type { StatusConfig } from '../types';

export interface PollHandle {
  stop: () => void | Promise<void>;
}

export function startStatusPolling<TDevice, TStatus>(opts: {
  config: StatusConfig<TDevice, TStatus>;
  transport: Transport;
  device: TDevice;
  /** Where to write status snapshots. */
  target: Ref<unknown>;
  /** Optional initial seed — set the ref once before the first read lands. */
  initial?: TStatus | null;
}): PollHandle {
  if (opts.initial !== undefined) {
    opts.target.value = opts.initial;
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
        const handle = await subConfig.subscribe(opts.transport, opts.device);
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
            opts.target.value = v;
          },
          { immediate: true },
        );
      } catch {
        // Subscribe failed — leave target null. Caller surfaces
        // via the Connect-section error path if relevant.
        opts.target.value = null;
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
      );
      opts.target.value = status;
    } catch {
      // Silent — a missed poll keeps the LAST known status so
      // downstream computeds (status pills, mediaPicker.detected)
      // don't flicker between known-good and null on every transient
      // read failure. Sustained outage just freezes the snapshot;
      // disconnect clears it via the caller's stop() path.
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
