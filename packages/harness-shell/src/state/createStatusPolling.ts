/**
 * Status subscription helper — drives status updates against the
 * connected `PrinterAdapter`.
 *
 * Plan 11 reshape: every driver-web printer now implements
 * `onStatus(cb)`. Drivers with real push (brother-ql, letratag-via-
 * advertising) wire it to their notification stream; drivers without
 * (LM, LW) implement it via the `pollingOnStatus` shim from
 * contracts. The shell's old push-vs-pull branch is gone — we always
 * subscribe and trust the adapter to decide whether that's push or
 * polling internally.
 *
 * Failures inside a subscription keep the LAST known snapshot — the
 * status pills don't flicker on a single missed read. Sustained
 * outage just freezes the snapshot; disconnect clears it via the
 * caller's stop() path.
 */
import type { PrinterAdapter, PrinterStatus } from '@thermal-label/contracts';

export interface PollHandle {
  stop: () => void;
}

export type StatusSink = (status: PrinterStatus | null) => void;

export function startStatusPolling(opts: {
  printer: PrinterAdapter;
  sink: StatusSink;
  /**
   * @deprecated Polling cadence is owned by the driver-web printer's
   *   `onStatus` implementation (4 s default via `pollingOnStatus`
   *   from contracts). This field is retained for ABI compatibility
   *   with pre-plan-11 call sites; it has no effect.
   */
  intervalMs?: number;
}): PollHandle {
  const { printer, sink } = opts;

  if (!printer.onStatus) {
    // Every driver-web printer should implement `onStatus` after
    // plan 11 step 4. Surface a dev-mode warning if a driver
    // hasn't migrated yet so the gap is visible during the
    // transition.
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console -- dev-mode diagnostic
      console.warn(
        '[status] printer does not implement onStatus — plan 11 requires every driver-web printer to subscribe. Status pill will stay at "checking…".',
      );
    }
    return {
      stop: () => {
        // Adapter never subscribed; nothing to tear down.
      },
    };
  }

  let unsubscribe: (() => void) | null = null;
  try {
    unsubscribe = printer.onStatus(status => {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console -- dev-mode diagnostic
        console.debug('[status] frame →', status);
      }
      sink(status);
    });
  } catch (err) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console -- dev-mode diagnostic
      console.debug('[status] onStatus subscribe failed →', err);
    }
  }

  return {
    stop: () => {
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          // Best-effort.
        }
      }
    },
  };
}
