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
    return { state: 'unknown', label: 'Probing printer…' };
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
 * Map a `PrinterStatus.battery` to a battery glyph pill, or `null`
 * when the device reports no battery (deferred from plan 13 Phase 1;
 * lands with `status.battery` in Phase 2).
 *
 * AC/USB-powered drivers (LabelWriter, brother-ql, LabelManager)
 * leave `battery` undefined → this returns `null` and the caller
 * renders nothing. Battery-bearing drivers (LetraTag) populate it.
 *
 * The pill label is a charge percentage from the normalised
 * `fraction` (0..1), prefixed `Charging — ` while the cable is in.
 * Traffic-light state: `bad` ≤ 15%, `warn` ≤ 35%, else `good`;
 * `unknown` when `fraction` is absent. A device that reports only a
 * charging flag still gets a pill ("Charging" / "On battery").
 */
export function statusToBatteryPill(status: PrinterStatus | null): Pill | null {
  const battery = status?.battery;
  if (!battery) return null;

  const { fraction, charging } = battery;
  if (fraction === undefined) {
    return {
      state: 'unknown',
      label: charging ? 'Charging' : 'On battery',
    };
  }

  const pct = Math.round(fraction * 100);
  const state: PillState = fraction <= 0.15 ? 'bad' : fraction <= 0.35 ? 'warn' : 'good';
  return {
    state: charging ? 'good' : state,
    label: charging ? `Charging — ${String(pct)}%` : `Battery ${String(pct)}%`,
  };
}

/**
 * Map a `PrinterStatus` to the §3 "media loaded" pill.
 */
export function statusToMediaPill(status: PrinterStatus | null, noun: string): Pill {
  if (!status) {
    return { state: 'unknown', label: `Detecting ${noun}…` };
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
