/**
 * Top-level orchestration for `verify-cli verify <driver> [model]`.
 *
 * The dispatcher today only knows about labelmanager; the second driver's
 * MVP (plan 05 sequencing: labelwriter 4xx) will surface the right shared
 * abstractions. Until then, an explicit if-tree keeps the dispatch flat.
 */
import type { TransportType } from '@thermal-label/contracts';
import type { ProposedRung } from '@thermal-label/harness-core/shared';
import { runLabelmanagerVerify } from './drivers/labelmanager/verify.js';

export interface VerifyOptions {
  driver: 'labelmanager';
  model: string | undefined;
  transport: TransportType | undefined;
  rung: ProposedRung | undefined;
  notes: string | undefined;
  wizard: boolean;
  dryRun: boolean;
  reporter: string | undefined;
  /** Labelmanager-specific. Defaults to 12 mm. */
  tapeWidth: 6 | 9 | 12 | 19 | undefined;
}

export async function runVerify(options: VerifyOptions): Promise<void> {
  // Single supported driver today; the second driver's MVP grows this
  // into a real switch with the exhaustiveness guard. Keeping the
  // dispatch flat per plan 05 §hard rules ("don't try to abstract for
  // other drivers in this PR").
  await runLabelmanagerVerify(options);
}
