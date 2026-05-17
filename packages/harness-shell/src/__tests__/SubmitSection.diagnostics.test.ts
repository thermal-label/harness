/**
 * Diagnostics-block tests for `SubmitSection.vue` (plan
 * diagnostics-json-copy step 2).
 *
 * The block is copy-only and ungated by the verdict — it must render
 * the moment a device is connected, *before* any print. These tests
 * mount `SubmitSection` with a synthetic connected session and assert:
 *   - the block appears in the pending state (canSubmit === false);
 *   - the preview textarea holds the pretty-printed snapshot;
 *   - Copy puts a fenced ```json block on the clipboard;
 *   - the snapshot tracks live status polls.
 */
import { describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import type { MediaDescriptor, PrintEngine, PrinterStatus } from '@thermal-label/contracts';
import SubmitSection from '../sections/SubmitSection.vue';
import { provideAdapter } from '../state/adapterContext';
import { provideSession, type Session } from '../state/session';
import type { DriverAdapter } from '../types';

interface FakeDevice {
  key: string;
  name: string;
  engines: readonly PrintEngine[];
}

const FAKE_ENGINE: PrintEngine = { role: 'primary', protocol: 'lw-450', dpi: 300, headDots: 672 };

const FAKE_DEVICE: FakeDevice = {
  key: 'FAKE',
  name: 'Fake Printer',
  engines: [FAKE_ENGINE],
};

const fakeAdapter: DriverAdapter<FakeDevice, MediaDescriptor> = {
  driverKey: 'fake',
  driverDisplayName: 'FakePrinter',
  targetRepo: 'thermal-label/fake',
  harnessVersion: '1.2.3',
  driverVersion: '4.5.6',
  devices: [FAKE_DEVICE],
  media: [],
  deviceKey: d => d.key,
  deviceName: d => d.name,
  // eslint-disable-next-line @typescript-eslint/require-await
  connect: async () => {
    throw new Error('not used');
  },
  mockTargets: {},
  mediaPicker: {
    filterByDeviceEngine: media => media,
    groupBy: () => ({ key: 'all', label: 'All', priority: 'primary' }),
  },
  buildDiagnosticImage: () => ({ data: new Uint8Array(0), width: 0, height: 0 }),
  buildReport: () => {
    throw new Error('not used');
  },
};

function readyStatus(rawBytes: Uint8Array): PrinterStatus {
  return { ready: true, mediaLoaded: true, errors: [], rawBytes };
}

/**
 * Mount `SubmitSection` with the adapter + session provided, and hand
 * the test a reference to the live session so it can drive connection
 * state. The session is created via `provideSession()` inside setup.
 */
function mountSection(): {
  wrapper: ReturnType<typeof mount>;
  session: Session<FakeDevice, MediaDescriptor>;
} {
  let session!: Session<FakeDevice, MediaDescriptor>;
  // `provideSession` calls `useAdapter()` (an `inject`), which only
  // sees provides from an *ancestor* — so the session is created in a
  // child component nested under the adapter-providing wrapper.
  const Inner = defineComponent({
    name: 'TestInner',
    setup() {
      session = provideSession<FakeDevice, MediaDescriptor>();
      return () => h(SubmitSection);
    },
  });
  const Wrapper = defineComponent({
    name: 'TestWrapper',
    setup() {
      provideAdapter(fakeAdapter);
      return () => h(Inner);
    },
  });
  const wrapper = mount(Wrapper);
  return { wrapper, session };
}

/** Move the session into a connected, pre-print state. */
function connect(session: Session<FakeDevice, MediaDescriptor>): void {
  session.device.value = FAKE_DEVICE;
  session.syncEngineSessions(FAKE_DEVICE);
  // `printers` non-null is what `isConnected` keys off.
  session.connection.printers = { primary: {} as never };
  session.connection.identity = { advertisedName: 'Fake Printer', vid: 0x1234, pid: 0x5678 };
  session.connection.mocked = true;
}

describe('SubmitSection diagnostics block', () => {
  it('is hidden before a device is connected', () => {
    const { wrapper } = mountSection();
    expect(wrapper.find('.diagnostics').exists()).toBe(false);
  });

  it('appears in the pending state (ungated by canSubmit)', async () => {
    const { wrapper, session } = mountSection();
    connect(session);
    await nextTick();

    // No verdict picked — the submit flow is still gated.
    expect(session.canSubmit.value).toBe(false);
    // ...but the diagnostics block is present anyway.
    expect(wrapper.find('.diagnostics').exists()).toBe(true);
    expect(wrapper.text()).toContain('Triaging an existing issue?');
  });

  it('previews the pretty-printed snapshot in a read-only textarea', async () => {
    const { wrapper, session } = mountSection();
    connect(session);
    session.printerStatus.primary = readyStatus(new Uint8Array([0x0f, 0xa0]));
    await nextTick();

    const textarea = wrapper.find('.diagnostics-preview textarea');
    expect(textarea.exists()).toBe(true);
    expect(textarea.attributes('readonly')).toBeDefined();
    const value = textarea.attributes('value') ?? '';
    expect(value).toContain('"driverKey": "fake"');
    expect(value).toContain('"harnessVersion": "1.2.3"');
    expect(value).toContain('"mocked": true');
    // rawBytes serialised as a hex string.
    expect(value).toContain('"rawBytes": "0fa0"');
  });

  it('copies a fenced ```json block to the clipboard', async () => {
    const writeText = vi.fn<(t: string) => Promise<void>>().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const { wrapper, session } = mountSection();
    connect(session);
    session.printerStatus.primary = readyStatus(new Uint8Array([0x01]));
    await nextTick();

    const copyButton = wrapper.findAll('button').find(b => b.text().includes('Copy diagnostics'));
    expect(copyButton).toBeTruthy();
    await copyButton!.trigger('click');
    await nextTick();

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]![0];
    expect(copied.startsWith('```json\n')).toBe(true);
    expect(copied.endsWith('\n```')).toBe(true);
    expect(copyButton!.text()).toContain('Copied');
  });

  it('reflects the latest status after a poll updates printerStatus', async () => {
    const { wrapper, session } = mountSection();
    connect(session);
    session.printerStatus.primary = readyStatus(new Uint8Array([0xaa]));
    await nextTick();
    expect(wrapper.find('.diagnostics-preview textarea').attributes('value')).toContain(
      '"rawBytes": "aa"',
    );

    // A subsequent poll writes new bytes — the live computed must pick
    // them up without a remount.
    session.printerStatus.primary = readyStatus(new Uint8Array([0xbb, 0xcc]));
    await nextTick();
    expect(wrapper.find('.diagnostics-preview textarea').attributes('value')).toContain(
      '"rawBytes": "bbcc"',
    );
  });
});
