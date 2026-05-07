import type { PatternResult, ProposedRung } from './hardware-report.js';

/**
 * Translate per-pattern results into a proposed rung, per plan 03's
 * rung-translation rule:
 *
 *  - All-pass — every pattern reports `'pass'` → `'verified'`.
 *  - Mixed — at least one `'pass'` and at least one `'fail'` → `'partial'`.
 *  - All-fail or device-unreachable (no patterns ran with `'pass'`)
 *    → `'unsupported'`.
 *  - All-skip (no `'pass'` and no `'fail'`, only `'skipped'` or empty) is
 *    rejected — the harness blocks the submit. We surface that here as a
 *    thrown error so callers can report the misuse instead of silently
 *    classifying.
 *
 * Computed in the harness and stored on `TransportReport.rung` so plan 04's
 * parser doesn't re-derive — the wire format is the single source of truth.
 */
export function computeRung(
  patterns: Readonly<Record<string, PatternResult>>,
): ProposedRung {
  const values = Object.values(patterns);
  let passCount = 0;
  let failCount = 0;
  for (const result of values) {
    if (result === 'pass') passCount += 1;
    else if (result === 'fail') failCount += 1;
  }

  if (passCount === 0 && failCount === 0) {
    throw new Error(
      'computeRung: refusing to classify all-skip / empty pattern set ' +
        '(no signal — harness must block submit per plan 03).',
    );
  }

  if (failCount === 0) return 'verified';
  if (passCount === 0) return 'unsupported';
  return 'partial';
}
