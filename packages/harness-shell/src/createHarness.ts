/**
 * Mount the shared `<HarnessShell>` against a per-driver `DriverAdapter`.
 *
 * Per-driver `apps/harness-<driver>/src/main.ts` should be a 5-line
 * file:
 *
 *   import { createHarness } from '@thermal-label/harness-shell';
 *   import '@thermal-label/harness-shell/styles';
 *   import { adapter } from './adapter';
 *   createHarness('#app', adapter);
 *
 * The adapter object lives in `./adapter.ts` next to it, wires the
 * driver-core APIs into the `DriverAdapter` shape, and is the only
 * place per-driver behaviour lives.
 */
import { createApp, h, type App } from 'vue';
import type { MediaDescriptor } from '@thermal-label/contracts';
import HarnessShell from './HarnessShell.vue';
import { provideAdapter } from './state/adapterContext';
import type { DriverAdapter } from './types';

export function createHarness<TDevice, TMedia extends MediaDescriptor, TStatus>(
  rootSelector: string,
  adapter: DriverAdapter<TDevice, TMedia, TStatus>,
): App {
  const app = createApp({
    setup() {
      provideAdapter(adapter);
      return () => h(HarnessShell);
    },
  });
  app.mount(rootSelector);
  return app;
}
