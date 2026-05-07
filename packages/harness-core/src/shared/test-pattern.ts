/**
 * Harness-side test-pattern type. Each `apps/harness-<driver>/` (and
 * `apps/verify-cli/`'s per-driver code) defines its own array of these,
 * importing encoder helpers from the driver's published `-core` package.
 *
 * Drivers stay completely unaware of `TestPattern` — it's a harness concern.
 * This type is intentionally not exported from `@thermal-label/contracts`.
 */
export interface TestPattern {
  /**
   * Stable id used as the key in `TransportReport.patterns`. Conventionally
   * short (`'T1'`, `'feed-only'`, etc.) — readable both in the issue body's
   * prose summary and in the embedded JSON block.
   */
  id: string;
  /** Human-readable label shown in the harness UI / TUI. */
  label: string;
  /**
   * Operator-facing instruction for what they should see if the pattern
   * works. Markdown-safe inline string — rendered as-is in the harness UI.
   */
  instructions: string;
  /**
   * Returns the bytes to send over the active transport. Pure function:
   * deterministic, no transport coupling, no I/O. The harness picks the
   * transport and dispatches the bytes.
   */
  encoder: () => Uint8Array;
}
