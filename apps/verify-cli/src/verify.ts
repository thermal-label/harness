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
}

export async function runVerify(options: VerifyOptions): Promise<void> {
  switch (options.driver) {
    case 'labelmanager':
      await runLabelmanagerVerify(options);
      return;
    default: {
      // Exhaustiveness guard — TypeScript narrows `options.driver` to never
      // here, so adding a new driver above without handling it is a compile
      // error rather than a runtime surprise.
      const _exhaustive: never = options.driver;
      throw new Error(`Unsupported driver: ${String(_exhaustive)}`);
    }
  }
}
