/**
 * Capability-resolution tests for `MediaSection.vue`.
 *
 * Focus: the `detectionCapability` computed — specifically the new
 * `detected-unrecognized` branch and its graceful degrade. The
 * resolved mode is observable on the rendered `<MediaPicker>`'s
 * `data-detection` attribute.
 *
 * MediaSection reads `useAdapter()` + `useSession()`; the test mounts
 * it inside a thin wrapper that provides both and seeds the session
 * with a connected, identified device + an active status frame.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import type { MediaDescriptor, PrintEngine, PrinterStatus } from '@thermal-label/contracts';
import MediaSection from '../MediaSection.vue';
import { provideAdapter } from '../../state/adapterContext';
import { provideSession } from '../../state/session';
import type { DriverAdapter, CustomMediaInput } from '../../types';

interface FakeDevice {
  key: string;
  name: string;
  engines: readonly PrintEngine[];
  transports: Record<string, unknown>;
}

interface FakeMedia extends MediaDescriptor {
  type: 'die-cut' | 'continuous';
}

/** A detection-capable engine — drives `detectionCapability` past `'none'`. */
const DETECT_ENGINE: PrintEngine = {
  role: 'primary',
  protocol: 'lw5-raster',
  dpi: 300,
  headDots: 672,
  capabilities: { mediaDetection: true },
};

const CATALOGUE_MEDIA: FakeMedia = {
  id: 'address-standard',
  name: '89×28mm Address',
  widthMm: 28,
  heightMm: 89,
  type: 'die-cut',
};

const FAKE_DEVICE: FakeDevice = {
  key: 'LW_550',
  name: 'LabelWriter 550',
  engines: [DETECT_ENGINE],
  transports: { usb: { vid: '0922', pid: '0028' } },
};

function buildCustomMedia(input: CustomMediaInput): FakeMedia {
  return {
    id: 'custom',
    name: input.identifier || `Custom ${String(input.widthMm)} mm`,
    widthMm: input.widthMm,
    type: input.type,
    ...(input.heightMm !== undefined ? { heightMm: input.heightMm } : {}),
  };
}

function makeAdapter(withCustomMedia: boolean): DriverAdapter<FakeDevice, FakeMedia> {
  return {
    driverKey: 'fake',
    driverDisplayName: 'Fake',
    targetRepo: 'thermal-label/fake',
    harnessVersion: '0.0.0-test',
    driverVersion: '0.0.0-test',
    devices: [FAKE_DEVICE],
    media: [CATALOGUE_MEDIA],
    deviceKey: d => d.key,
    deviceName: d => d.name,
    // eslint-disable-next-line @typescript-eslint/require-await
    connect: async () => {
      throw new Error('not implemented in capability test');
    },
    mockTargets: {},
    mediaPicker: {
      filterByDeviceEngine: media => media,
      groupBy: () => ({ key: 'all', label: 'All', priority: 'primary' }),
      ...(withCustomMedia ? { customMedia: { build: buildCustomMedia } } : {}),
    },
    buildDiagnosticImage: () => {
      throw new Error('not implemented in capability test');
    },
    buildReport: () => {
      throw new Error('not implemented in capability test');
    },
  };
}

/**
 * Mount MediaSection with a connected, identified session whose active
 * status carries `detectedMedia`. Returns the rendered detection mode
 * read off the `<MediaPicker>`'s `data-detection` attribute.
 */
async function mountWithDetection(opts: {
  withCustomMedia: boolean;
  detectedMedia: MediaDescriptor | undefined;
}): Promise<string | undefined> {
  const adapter = makeAdapter(opts.withCustomMedia);
  let detectionMode: string | undefined;

  // `provide` is visible to descendants only — the providing
  // component's own `setup` can't `inject` it. So the adapter is
  // provided by a parent and the session (which internally calls
  // `useAdapter`) is set up in a child, with MediaSection a grandchild.
  const SessionHost = defineComponent({
    setup() {
      const session = provideSession<FakeDevice, FakeMedia>();
      // Seed a connected + identified session.
      session.connection.printers = {};
      session.connection.identity = { advertisedName: 'LabelWriter 550' };
      session.device.value = FAKE_DEVICE;
      session.syncEngineSessions(FAKE_DEVICE);
      const status: PrinterStatus = {
        ready: true,
        mediaLoaded: true,
        errors: [],
        rawBytes: new Uint8Array(0),
        ...(opts.detectedMedia ? { detectedMedia: opts.detectedMedia } : {}),
      };
      session.printerStatus.primary = status;
      return () => h(MediaSection);
    },
  });

  const Harness = defineComponent({
    setup() {
      provideAdapter(adapter);
      return () => h(SessionHost);
    },
  });

  const wrapper = mount(Harness);
  await nextTick();
  const picker = wrapper.find('.media-picker');
  if (picker.exists()) detectionMode = picker.attributes('data-detection');
  return detectionMode;
}

describe('MediaSection — detectionCapability', () => {
  // An unmatched detection — id maps to no catalogue entry.
  const UNKNOWN_DETECTED: MediaDescriptor = {
    id: 'sku-99999',
    name: 'Unknown SKU',
    widthMm: 41,
    type: 'continuous',
  };

  it('resolves detected-unrecognized when detection is unmatched and the adapter supplies customMedia', async () => {
    const mode = await mountWithDetection({
      withCustomMedia: true,
      detectedMedia: UNKNOWN_DETECTED,
    });
    expect(mode).toBe('detected-unrecognized');
  });

  it('degrades to auto-suggest when detection is unmatched and there is no customMedia hook', async () => {
    const mode = await mountWithDetection({
      withCustomMedia: false,
      detectedMedia: UNKNOWN_DETECTED,
    });
    expect(mode).toBe('auto-suggest');
  });

  it('resolves auto-locked when the detected media matches a catalogue entry', async () => {
    const mode = await mountWithDetection({
      withCustomMedia: true,
      detectedMedia: { ...CATALOGUE_MEDIA },
    });
    expect(mode).toBe('auto-locked');
  });

  it('resolves auto-suggest when detection-capable but nothing detected', async () => {
    const mode = await mountWithDetection({
      withCustomMedia: true,
      detectedMedia: undefined,
    });
    expect(mode).toBe('auto-suggest');
  });
});
