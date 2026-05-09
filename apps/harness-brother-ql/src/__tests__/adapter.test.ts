/**
 * TODO(harness-v2): rewrite for PrinterAdapter
 *
 * The previous adapter test exercised the bloated DriverAdapter
 * (status config, multiEngine, encoder pair, detection callback).
 * Post-v2 those are gone — the adapter is a thin shape that hands
 * a `PrinterAdapter` to the shell and the shell drives status /
 * detection / preview / print through that printer instance.
 *
 * Replacement is a separate pass per the maintainer's plan:
 * smoke-test the v2 adapter shape, then re-add coverage that
 * mounts a synthetic PrinterAdapter and asserts the picker, the
 * print path, and the report builder.
 */
import { describe, it } from 'vitest';

describe.skip('brother-ql adapter — TODO(harness-v2): rewrite for PrinterAdapter', () => {
  it('placeholder', () => {
    // intentionally empty
  });
});
