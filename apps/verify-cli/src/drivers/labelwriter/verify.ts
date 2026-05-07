/**
 * Labelwriter verify flow — stub. Real implementation in the next
 * commit. This file exists so the dispatcher in `../../verify.ts`
 * type-checks once the driver is wired into `SUPPORTED_DRIVERS`.
 */
import type { VerifyOptions } from '../../verify.js';

export function runLabelwriterVerify(options: VerifyOptions): Promise<void> {
  void options;
  return Promise.reject(
    new Error('labelwriter verify not yet implemented; only the workspace plumbing has landed.'),
  );
}
