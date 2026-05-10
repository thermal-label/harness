/**
 * Status polling helper — drives `printer.getStatus()` against the
 * connected `PrinterAdapter`.
 *
 * Push semantics: when the driver supplies `printer.onStatus`, we
 * subscribe and feed snapshots straight to the sink (no polling
 * timer). Brother-QL's web printer pushes spontaneous status frames
 * via the read loop; subscribing means the harness picks up
 * lid-open / media-insert / end-of-job in real time without polling
 * cost.
 *
 * Pull semantics: drivers without `onStatus` get a 4 s `setInterval`
 * calling `printer.getStatus()`. The first read fires immediately so
 * the §1 / §3 status pills resolve quickly; subsequent reads run on
 * the interval.
 *
 * Failures during a poll keep the LAST known snapshot — the pills
 * don't flicker on a single missed read. Sustained outage just freezes
 * the snapshot; disconnect clears it via the caller's stop() path.
 */
import type { PrinterAdapter, PrinterStatus } from '@thermal-label/contracts';

const DEFAULT_INTERVAL_MS = 4000;

export interface PollHandle {
  stop: () => void;
}

export type StatusSink = (status: PrinterStatus | null) => void;

export function startStatusPolling(opts: {
  printer: PrinterAdapter;
  sink: StatusSink;
  /** Default: 4000 ms. Ignored when the driver supports push (`onStatus`). */
  intervalMs?: number;
}): PollHandle {
  const { printer, sink } = opts;
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  // Push path — driver supplies `onStatus`. Subscribe AND poll
  // periodically: pushes deliver state changes (lid open, media
  // insert, errors) in real time; the periodic getStatus() keeps the
  // pill fresh between events and acts as a heartbeat. Brother QL
  // doesn't push on a timer — without polling, the pill stays at the
  // last-seen state until something physically changes on the
  // printer.
  if (printer.onStatus) {
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = printer.onStatus(status => {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console -- dev-mode diagnostic
          console.debug('[status] push frame →', status);
        }
        sink(status);
      });
    } catch (err) {
      // Subscribe failed — degrade to nothing. Caller's status pills
      // stay at "checking…" / unknown.
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console -- dev-mode diagnostic; gated by import.meta.env.DEV
        console.debug('[status] onStatus subscribe failed →', err);
      }
    }
    // Kick getStatus() periodically. The driver's response goes
    // through the same read pipe → onStatus subscriber → sink, so we
    // don't need to await/process the result here. Errors are
    // expected (transient timeouts when the printer is busy
    // responding to other commands) and are swallowed so the loop
    // keeps ticking.
    const tick = (): void => {
      void printer.getStatus().catch((err: unknown) => {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console -- dev-mode diagnostic
          console.debug('[status] poll getStatus failed →', err);
        }
      });
    };
    tick();
    const handle = setInterval(tick, interval);
    return {
      stop: () => {
        clearInterval(handle);
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

  // Pull path — periodic getStatus().
  let inFlight = false;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const status = await printer.getStatus();
      if (!stopped) sink(status);
      if (import.meta.env.DEV) {
        const raw = status.rawBytes;
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
      // downstream computeds (status pills, detected media) don't
      // flicker between known-good and null on every transient read
      // failure.
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
