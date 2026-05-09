/**
 * Top-level orchestration for `verify-cli verify <driver> [model]`.
 *
 * Three drivers today: labelmanager (USB-only), labelwriter (USB + TCP-9100,
 * plus the multi-transport "test another transport" loop), and brother-ql
 * (USB + TCP-9100, multi-transport too; Bluetooth-SPP deferred). The
 * dispatcher is a real `switch` with an exhaustiveness guard; plan 05
 * §sequencing nominated the second driver as the moment to grow it from a
 * flat if-tree.
 *
 * Per-driver options live behind an opaque `VerifyOptions` shape rather
 * than a discriminated union — every flag is optional at the type level,
 * and each driver's orchestrator validates the subset it cares about
 * (driver-irrelevant fields like `tapeWidth` for brother-ql are simply
 * ignored). Adding a fourth driver is one more `case` here.
 */
import type { TransportType } from '@thermal-label/contracts';
import type { ProposedRung } from '@thermal-label/harness-core/shared';
import { runLabelmanagerVerify } from './drivers/labelmanager/verify.js';
import { runLabelwriterVerify } from './drivers/labelwriter/verify.js';
import { runBrotherQlVerify } from './drivers/brother-ql/verify.js';

export type SupportedDriver = 'labelmanager' | 'labelwriter' | 'brother-ql';

export interface VerifyOptions {
  driver: SupportedDriver;
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
  /**
   * Labelmanager-only legacy shorthand: pick the canonical black-on-
   * white STANDARD cartridge for the given width. Superseded by
   * `--media <id>`; kept so old maintainer one-liners still work.
   */
  tapeWidth: 6 | 9 | 12 | 19 | undefined;
  /**
   * Loaded label / tape. Labelwriter accepts a media key (e.g.
   * `ADDRESS_STANDARD`) or SKU (`30334`); brother-ql accepts a DK
   * SKU (`DK-22205`); labelmanager accepts a D1 cartridge id
   * (e.g. `d1-standard-bw-12`). Optional when the printer
   * auto-detects (LW 5xx, brother-ql); required for LW 3xx/4xx;
   * defaults to the canonical 12 mm BoW STANDARD on labelmanager.
   */
  media: string | undefined;
  /** TCP-9100 host. Labelwriter (Wi-Fi) or brother-ql tcp transport. */
  host: string | undefined;
  /** TCP-9100 port (default 9100). Brother-ql tcp transport only. */
  port: number | undefined;
}

export async function runVerify(options: VerifyOptions): Promise<void> {
  switch (options.driver) {
    case 'labelmanager':
      await runLabelmanagerVerify(options);
      return;
    case 'labelwriter':
      await runLabelwriterVerify(options);
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
