/**
 * Smoke test for `<HarnessShell>`.
 *
 * Mounts the shell against a synthetic adapter — no driver-core
 * imports, no real WebUSB, no encoder. Proves the abstraction holds:
 *
 *  - `<HarnessShell>` mounts and renders the page chrome (heading,
 *    intro blurb, connect-section copy).
 *  - The adapter's `driverDisplayName` reaches the heading.
 *  - The Connect button is the visible call-to-action while
 *    disconnected.
 *  - Single-engine devices skip the engine-tabs strip even when
 *    `multiEngine` is supplied (plan-09 hard rule: 6-LW renders
 *    identically to today).
 *
 * The synthetic adapter never resolves `connect()`, so the post-
 * connect flow isn't exercised here — that's a deeper integration
 * concern. This test is the minimum guarantee that the shell can be
 * composed from a `DriverAdapter` shape, the bar that proves the
 * abstraction is sound for the next six drivers.
 */
// `useCapabilities.ts` snapshots browser capability at module-load
// time. The vitest setupFiles entry (`./setup.ts`) polyfills
// `navigator.usb` BEFORE this file's imports resolve, so the smoke
// test exercises the connected-browser path; without that polyfill,
// happy-dom (no WebUSB) drops us into `<UnsupportedBrowser>` and the
// Connect button never renders.
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, type Ref } from 'vue';
import type { MediaDescriptor, PrintEngine } from '@thermal-label/contracts';
import HarnessShell from '../HarnessShell.vue';
import { provideAdapter } from '../state/adapterContext';
import type { DriverAdapter } from '../types';

interface FakeDevice {
  key: string;
  name: string;
  engines: readonly PrintEngine[];
}

interface FakeMedia extends MediaDescriptor {
  width: number;
}

const FAKE_ENGINE: PrintEngine = {
  role: 'primary',
  protocol: 'lw-450',
  dpi: 300,
  headDots: 672,
};

const FAKE_DEVICE: FakeDevice = {
  key: 'FAKE_PRINTER',
  name: 'Fake Printer 1',
  engines: [FAKE_ENGINE],
};

const FAKE_MEDIA: FakeMedia = {
  id: 'fake-1',
  name: 'Fake Media',
  widthMm: 12,
  type: 'die-cut',
  width: 12,
};

const fakeAdapter: DriverAdapter<FakeDevice, FakeMedia, null> = {
  driverKey: 'fake',
  driverDisplayName: 'FakePrinter',
  targetRepo: 'thermal-label/fake',
  harnessVersion: '0.0.0-test',
  driverVersion: '0.0.0-test',

  devices: [FAKE_DEVICE],
  deviceKey: d => d.key,
  deviceName: d => d.name,

  // Never resolves — the smoke test only asserts the pre-connect UI.
  // eslint-disable-next-line @typescript-eslint/require-await
  connect: async () => {
    throw new Error('not implemented in smoke test');
  },

  mockTargets: {},

  media: [FAKE_MEDIA],
  mediaPicker: {
    filterByDeviceEngine: media => media,
    groupBy: () => ({ key: 'all', label: 'All', priority: 'primary' }),
    defaultMediaId: () => FAKE_MEDIA.id,
    detectionCapability: () => 'none',
  },

  encoder: {
    buildBitmap: () => {
      throw new Error('not implemented in smoke test');
    },
    encodeBytes: () => {
      throw new Error('not implemented in smoke test');
    },
  },

  buildReport: () => {
    throw new Error('not implemented in smoke test');
  },
};

/**
 * Smoke wrapper that provides the adapter inside a Vue setup() so
 * `<HarnessShell>` can `inject` it. We don't go through `createHarness`
 * because that uses `app.mount()` and doesn't return a wrapper we can
 * query.
 */
function mountShell(adapter: DriverAdapter<FakeDevice, FakeMedia, null>): ReturnType<typeof mount> {
  const Wrapper = defineComponent({
    name: 'TestWrapper',
    setup() {
      provideAdapter(adapter);
      return () => h(HarnessShell);
    },
  });
  return mount(Wrapper, {
    global: {
      // Silence the harness-components peer-dep warnings; the picker
      // isn't reached pre-connect anyway.
      stubs: {},
    },
  });
}

describe('<HarnessShell> smoke', () => {
  it('renders the page heading from the adapter', () => {
    const w = mountShell(fakeAdapter);
    expect(w.find('h1').text()).toContain('FakePrinter');
  });

  it('shows the Connect button before any connection', () => {
    const w = mountShell(fakeAdapter);
    const buttons = w.findAll('button');
    const connect = buttons.find(b => b.text().toLowerCase().includes('connect'));
    expect(connect).toBeTruthy();
  });

  it('does NOT render engine tabs for single-engine devices, even with multiEngine present', () => {
    const adapterWithMultiEngine: DriverAdapter<FakeDevice, FakeMedia, null> = {
      ...fakeAdapter,
      multiEngine: {
        // Single-engine device — `isMultiEngine` returns false, so
        // tabs must stay hidden.
        isMultiEngine: device => device.engines.length > 1,
      },
    };
    const w = mountShell(adapterWithMultiEngine);
    expect(w.find('#engine-tabs').exists()).toBe(false);
  });

  it('uses the adapter introBlurb when supplied', () => {
    const adapterWithBlurb: DriverAdapter<FakeDevice, FakeMedia, null> = {
      ...fakeAdapter,
      introBlurb: 'Bench-test the FakePrinter in two minutes.',
    };
    const w = mountShell(adapterWithBlurb);
    expect(w.text()).toContain('Bench-test the FakePrinter in two minutes.');
  });
});

// Future-compat — the shell's status pill abstraction is used by the
// real adapters; we don't assert against it here because the smoke
// adapter declares no status config (suppressed-pill path).
interface _SubscribeShape {
  unsubscribe: () => Promise<void>;
  latest: Ref<null>;
}
// Reference the type so import-x doesn't flag it as unused. Keeps
// the polling-shape intentionally documented in the test file —
// future BLE driver tests can lift this template.
const _shape: _SubscribeShape | null = null;
void _shape;
