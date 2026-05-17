/**
 * Shared types for `<MediaPicker>`.
 *
 * The picker is generic over `T extends MediaDescriptor` from
 * `@thermal-label/contracts` — each driver's media catalogue narrows
 * the base shape with family-specific fields and the consumer (LM,
 * LW, future brother-ql / niimbot) supplies its own `groupBy` +
 * `swatch` callbacks.
 */
import type { MediaDescriptor } from '@thermal-label/contracts';

/**
 * Group-membership descriptor returned by the consumer's `groupBy`
 * callback. `priority: 'secondary'` items are tucked under a
 * collapsed `<details>` disclosure (the LM consumer uses this for
 * Rhino industrial cassettes — physically D1-compatible but
 * unofficial and uncommon).
 */
export interface MediaGroupKey {
  /** Stable group key — must be unique per group. */
  key: string;
  /** Human-readable group label. */
  label: string;
  /**
   * Whether the group renders inline (`primary`) or under a
   * collapsed-by-default disclosure (`secondary`).
   */
  priority: 'primary' | 'secondary';
  /**
   * Optional sort weight; lower sorts first. Items with no sort key
   * fall back to insertion order. Applied within each priority bucket.
   */
  sort?: number;
}

/**
 * Optional swatch colours returned by the consumer's `swatch`
 * callback. The picker resolves named CSS colours directly and falls
 * back to a small lookup table for non-CSS-recognised names like
 * `clear` / `silver` / `fluorescent-*`.
 */
export interface MediaSwatch {
  /** Foreground / printed-ink colour name (e.g. `'black'`). */
  fg?: string;
  /** Background / substrate colour name (e.g. `'white'`, `'clear'`). */
  bg?: string;
}

/**
 * Detection-capability mode supplied by the driver.
 *
 * - `'none'` (LM, brother-ql QL_700): manual picker, full catalogue,
 *   no auto-selection beyond `defaultMediaId`.
 * - `'auto-suggest'` (LW 5xx NFC, future): pre-fills from a probe
 *   but operator can override. Picker shows "detected: X — confirm
 *   or pick another" with the catalogue still pickable.
 * - `'auto-locked'` (brother-ql with media-detection): printer
 *   reports media and refuses to print on anything else. Picker
 *   shows "detected: X" as a fixed pill; full catalogue is
 *   *visually disabled* but still rendered (operator can read what
 *   *would* be available if hardware swapped).
 * - `'detected-unrecognized'` (LW 5xx NFC SKU not in the catalogue,
 *   or a brother-ql roll the registry can't name): detection yields
 *   *geometry* but no catalogue *name*. The picker renders its own
 *   panel — editable dimension fields prefilled from the detected
 *   geometry plus a free-text media identifier — instead of the
 *   collapsed summary or the catalogue list. The confirmed
 *   dimensions become a printable media via the driver's
 *   `customMedia.build` hook. This state is only entered when the
 *   adapter supplies that hook; without it the shell degrades to
 *   `'auto-suggest'` (never a hard lock to a non-catalogue object).
 */
export type DetectionCapability = 'none' | 'auto-suggest' | 'auto-locked' | 'detected-unrecognized';

/**
 * Re-export so consumers writing a `groupBy: (m: T) => MediaGroupKey`
 * don't have to import `MediaDescriptor` separately for the bound.
 */
export type { MediaDescriptor };
