/**
 * Top-level orchestration for `verify-cli verify <driver> [model]`.
 *
 * Dispatcher kept as a flat switch with an exhaustiveness guard. Per-driver
 * orchestrators live under `./drivers/<driver>/verify.ts` and accept the
 * full `VerifyOptions` — driver-irrelevant fields (e.g. `tapeWidth` for
 * brother-ql, or `media` for labelmanager) are simply ignored by the
 * driver that doesn't use them.
 *
 * Mechanical merge note: when sibling driver agents land here in
 * parallel, each adds one `case` block. Conflicts are resolved by
 * concatenating the cases — no shared abstraction lives here yet.
 */
import type { TransportType } from '@thermal-label/contracts';
import type { ProposedRung } from '@thermal-label/harness-core/shared';
import { runLabelmanagerVerify } from './drivers/labelmanager/verify.js';
import { runBrotherQlVerify } from './drivers/brother-ql/verify.js';

export type DriverKey = 'labelmanager' | 'brother-ql';

export interface VerifyOptions {
  driver: DriverKey;
  model: string | undefined;
  transport: TransportType | undefined;
  rung: ProposedRung | undefined;
  notes: string | undefined;
  wizard: boolean;
  dryRun: boolean;
  /** Run the real print + assessment, but render the body to stdout instead of submitting. */
  noSubmit: boolean;
  /** Print the diagnostic bitmap as Braille to stdout before sending. With --dry-run, prints alone. */
  preview: boolean;
  /** Write the diagnostic bitmap as a PNG to a tmp file and auto-open it. */
  previewPng: boolean;
  reporter: string | undefined;
  /** Labelmanager-specific. Defaults to 12 mm. */
  tapeWidth: 6 | 9 | 12 | 19 | undefined;
  /** Brother-ql-specific. Tape SKU key from brother-ql-core's media catalog (e.g. DK-22205). */
  media: string | undefined;
  /** Brother-ql tcp transport host (IP / hostname). */
  host: string | undefined;
  /** Brother-ql tcp transport port (defaults to 9100). */
  port: number | undefined;
}

export async function runVerify(options: VerifyOptions): Promise<void> {
  switch (options.driver) {
    case 'labelmanager':
      await runLabelmanagerVerify(options);
      return;
    case 'brother-ql':
      await runBrotherQlVerify(options);
      return;
    default: {
      const _exhaustive: never = options.driver;
      throw new Error(`Unhandled driver: ${String(_exhaustive)}`);
    }
  }
}
