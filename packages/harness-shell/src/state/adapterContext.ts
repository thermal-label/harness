/**
 * Provide / inject helpers for the driver adapter.
 *
 * The adapter is supplied at the root via `provideAdapter(adapter)`
 * (called inside `createHarness`) and read by every section via
 * `useAdapter()`. This avoids threading the adapter through every
 * component prop, which would be untenable given the section
 * components' depth.
 *
 * The shape is intentionally untyped at the boundary — Vue's
 * `provide/inject` doesn't carry generics through the symbol. Each
 * `useAdapter()` consumer narrows back to the same shape via the
 * type-asserted return; in practice the shell only has one adapter
 * mounted per page, so the cast is sound.
 */
import { inject, provide, type InjectionKey } from 'vue';
import type { MediaDescriptor } from '@thermal-label/contracts';
import type { DriverAdapter } from '../types';

// `unknown` generics here; consumers cast to the concrete shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAdapter = DriverAdapter<any, any>;

const ADAPTER_KEY: InjectionKey<AnyAdapter> = Symbol('thermal-label.harness.adapter');

export function provideAdapter<TDevice, TMedia extends MediaDescriptor>(
  adapter: DriverAdapter<TDevice, TMedia>,
): void {
  provide(ADAPTER_KEY, adapter);
}

export function useAdapter<TDevice, TMedia extends MediaDescriptor>(): DriverAdapter<
  TDevice,
  TMedia
> {
  const adapter = inject(ADAPTER_KEY);
  if (!adapter) {
    throw new Error(
      'useAdapter() called outside of HarnessShell — make sure your app uses createHarness()',
    );
  }
  return adapter as DriverAdapter<TDevice, TMedia>;
}
