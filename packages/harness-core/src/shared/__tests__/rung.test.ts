import { describe, expect, it } from 'vitest';
import { computeRung } from '../rung.js';

describe('computeRung', () => {
  it('returns verified when every pattern passes', () => {
    expect(computeRung({ T1: 'pass', T2: 'pass' })).toBe('verified');
  });

  it('treats skipped + pass as verified (skipped contributes no fail signal)', () => {
    expect(computeRung({ T1: 'pass', T2: 'skipped' })).toBe('verified');
  });

  it('returns partial when at least one pass and at least one fail', () => {
    expect(computeRung({ T1: 'pass', T2: 'fail' })).toBe('partial');
  });

  it('returns partial regardless of skipped entries when mixed', () => {
    expect(computeRung({ T1: 'pass', T2: 'fail', T3: 'skipped' })).toBe('partial');
  });

  it('returns unsupported when every executed pattern fails', () => {
    expect(computeRung({ T1: 'fail', T2: 'fail' })).toBe('unsupported');
  });

  it('returns unsupported when fails coexist with skips but no passes', () => {
    expect(computeRung({ T1: 'fail', T2: 'skipped' })).toBe('unsupported');
  });

  it('throws on an all-skipped pattern set (no signal — submit must be blocked)', () => {
    expect(() => computeRung({ T1: 'skipped', T2: 'skipped' })).toThrow(/all-skip/);
  });

  it('throws on an empty pattern map (no signal)', () => {
    expect(() => computeRung({})).toThrow(/all-skip/);
  });
});
