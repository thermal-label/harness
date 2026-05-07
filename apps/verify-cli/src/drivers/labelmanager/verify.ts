/**
 * Labelmanager `verify` flow (plan 05 §sequencing — first driver).
 *
 * Skeleton today: validates the model key against the driver's registry
 * and surfaces a stub error. Subsequent commits fill in:
 *   - wizard prompts + flag bypass (step 2)
 *   - diagnostic-print encoder (step 3)
 *   - transport wiring (step 4)
 *   - submit flow (step 5)
 */
import type { VerifyOptions } from '../../verify.js';

export async function runLabelmanagerVerify(_options: VerifyOptions): Promise<void> {
  await Promise.resolve();
  throw new Error(
    'labelmanager verify flow is being scaffolded — wizard prompts, diagnostic ' +
      'print, transport wiring, and submit land in subsequent commits per plan 05.',
  );
}
