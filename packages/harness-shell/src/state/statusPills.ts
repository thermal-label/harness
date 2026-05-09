/**
 * Generic status-pill rendering — maps `PrinterStatus` (from
 * `@thermal-label/contracts`) to `{ state, label }` pills the
 * `<StatusPill>` component renders.
 *
 * Lives in the shell so per-driver adapters don't repeat the same
 * "ready" / "no media" / "warn" branching. Engine-specific noun
 * (paper / tape / roll / cassette) is picked from `engine.protocol`
 * and the standard error codes drivers emit (`no_media`,
 * `cover_open`, `paper_jam`, `cutter_jam`, `low_media`, `media_end`).
 *
 * Drivers add new error codes by extending `PrinterError.code` —
 * unknown codes fall through to the generic "Printer not ready" pill,
 * which is fine for triage. The pill is a hint, not a contract;
 * exact wording is chosen for operator legibility.
 */
import type { PrintEngine, PrinterStatus } from '@thermal-label/contracts';

export type PillState = 'unknown' | 'good' | 'warn' | 'bad';
export interface Pill {
  state: PillState;
  label: string;
}

/** Pick the operator-facing noun for the active engine's media. */
export function engineNoun(engine: PrintEngine | null): string {
  if (!engine) return 'media';
  if (engine.protocol === 'd1-tape') return 'tape';
  if (engine.protocol === 'ql-raster' || engine.protocol === 'pt-raster') return 'roll';
  // lw-450, lw-550, etc. — paper-style continuous/die-cut labels.
  return 'paper';
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Map a `PrinterStatus` to the §1 "printer ready" pill. Returns null
 * when no status snapshot is available yet (drives the "checking…"
 * placeholder via the caller).
 */
export function statusToPrinterPill(status: PrinterStatus | null, noun: string): Pill {
  if (!status) {
    return { state: 'unknown', label: 'Printer: checking…' };
  }
  const codes = status.errors.map(e => e.code);
  const lowMedia = codes.includes('low_media');
  if (!status.ready) {
    if (codes.includes('cover_open')) return { state: 'bad', label: 'Cover open' };
    if (codes.includes('cutter_jam')) return { state: 'bad', label: 'Cutter jam' };
    if (codes.includes('paper_jam')) return { state: 'bad', label: 'Paper jam' };
    if (codes.includes('no_media')) return { state: 'bad', label: `No ${noun} loaded` };
    return { state: 'bad', label: 'Printer not ready' };
  }
  if (lowMedia) return { state: 'warn', label: `${capitalise(noun)} supply low` };
  return { state: 'good', label: 'Printer ready' };
}

/**
 * Map a `PrinterStatus` to the §3 "media loaded" pill.
 */
export function statusToMediaPill(status: PrinterStatus | null, noun: string): Pill {
  if (!status) {
    return { state: 'unknown', label: `${capitalise(noun)}: checking…` };
  }
  const codes = status.errors.map(e => e.code);
  const lowMedia = codes.includes('low_media');
  const mediaEnd = codes.includes('media_end');
  const noMedia = codes.includes('no_media');
  if (!status.mediaLoaded || noMedia) {
    return { state: 'bad', label: `No ${noun} loaded` };
  }
  if (lowMedia) return { state: 'warn', label: `${capitalise(noun)} loaded — supply low` };
  if (mediaEnd) return { state: 'warn', label: `${capitalise(noun)} near end` };
  return { state: 'good', label: `${capitalise(noun)} loaded` };
}
