/**
 * Capability-resolution tests for `MediaSection.vue`.
 *
 * Focus: the `detectionCapability` computed — the `detected-unrecognized`
 * branch and its graceful degrade, the SKU-against-catalogue match that
 * round-trips an LW 5xx NFC detection back to `auto-locked`, and the
 * prefilled SKU-submission invite shown for an uncatalogued roll. The
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
  skus: ['30251', '30252'],
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
      // The capability tests exercise the auto-locked path, so opt
      // into strict enforcement (brother-ql's behaviour). Drivers
      // that only soft-hint detection (niimbot, letratag) leave this
      // unset and the picker uses 'auto-suggest' instead.
      detectionEnforced: true,
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
 * status carries `detectedMedia`. Returns the mounted wrapper; read the
 * resolved detection mode with `detectionModeOf`.
 */
async function mountWithDetection(opts: {
  withCustomMedia: boolean;
  detectedMedia: MediaDescriptor | undefined;
  /** Hex SKU dump to seed onto the active engine session's `skuInfo`. */
  skuRawBytes?: string;
  /**
   * Niimbot-style rfid block to seed onto the active status. When
   * `detectedMedia` is undefined and `rfid.barcode` is present, the
   * MediaSection synthesises a `rawDetected` from rfid so the picker
   * drops into `detected-unrecognized` mode.
   */
  rfid?: {
    source?: 'paper' | 'ribbon';
    uuid?: string;
    barcode?: string;
    serialNumber?: string;
    allPaper?: number;
    usedPaper?: number;
    labelType?: number;
    capacity?: number;
    rawHex?: string;
  };
}): Promise<ReturnType<typeof mount>> {
  const adapter = makeAdapter(opts.withCustomMedia);

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
      if (opts.skuRawBytes !== undefined) {
        const slot = session.engineSessions.primary;
        if (slot) slot.skuInfo = { rawBytes: opts.skuRawBytes };
      }
      const status: PrinterStatus & { rfid?: typeof opts.rfid } = {
        ready: true,
        mediaLoaded: true,
        errors: [],
        rawBytes: new Uint8Array(0),
        ...(opts.detectedMedia ? { detectedMedia: opts.detectedMedia } : {}),
        ...(opts.rfid ? { rfid: opts.rfid } : {}),
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
  return wrapper;
}

/** The detection mode the rendered `<MediaPicker>` resolved to. */
function detectionModeOf(wrapper: ReturnType<typeof mount>): string | undefined {
  const picker = wrapper.find('.media-picker');
  return picker.exists() ? picker.attributes('data-detection') : undefined;
}

describe('MediaSection — detectionCapability', () => {
  // An unmatched detection — id maps to no catalogue entry, and the
  // SKU-shaped name (`99999`) is in no catalogue entry's `skus[]`.
  const UNKNOWN_DETECTED: MediaDescriptor = {
    id: 'sku-99999',
    name: '99999',
    widthMm: 41,
    type: 'continuous',
  };

  it('resolves detected-unrecognized when detection is unmatched and the adapter supplies customMedia', async () => {
    const mode = detectionModeOf(
      await mountWithDetection({ withCustomMedia: true, detectedMedia: UNKNOWN_DETECTED }),
    );
    expect(mode).toBe('detected-unrecognized');
  });

  it('degrades to auto-suggest when detection is unmatched and there is no customMedia hook', async () => {
    const mode = detectionModeOf(
      await mountWithDetection({ withCustomMedia: false, detectedMedia: UNKNOWN_DETECTED }),
    );
    expect(mode).toBe('auto-suggest');
  });

  it('resolves auto-locked when the detected media matches a catalogue entry by id', async () => {
    const mode = detectionModeOf(
      await mountWithDetection({ withCustomMedia: true, detectedMedia: { ...CATALOGUE_MEDIA } }),
    );
    expect(mode).toBe('auto-locked');
  });

  it('resolves auto-locked when the detected SKU (in the name field) matches a catalogue skus[]', async () => {
    // LW 5xx NFC detection: the `id` is a synthetic `sku-<n>` that
    // equals no catalogue id, but `name` carries the vendor SKU —
    // `30252` is listed under ADDRESS_STANDARD's `skus[]`.
    const mode = detectionModeOf(
      await mountWithDetection({
        withCustomMedia: true,
        detectedMedia: {
          id: 'sku-30252',
          name: '30252',
          widthMm: 28,
          heightMm: 89,
          type: 'die-cut',
        },
      }),
    );
    expect(mode).toBe('auto-locked');
  });

  it('resolves auto-suggest when detection-capable but nothing detected', async () => {
    const mode = detectionModeOf(
      await mountWithDetection({ withCustomMedia: true, detectedMedia: undefined }),
    );
    expect(mode).toBe('auto-suggest');
  });

  it('offers a prefilled SKU-submission invite for an uncatalogued detected roll', async () => {
    const wrapper = await mountWithDetection({
      withCustomMedia: true,
      detectedMedia: UNKNOWN_DETECTED,
    });
    const invite = wrapper.find('.detected-unknown a');
    expect(invite.exists()).toBe(true);
    const href = decodeURIComponent(invite.attributes('href') ?? '');
    expect(href).toContain('issues/new');
    // The detected SKU + geometry ride into the prefilled issue body.
    expect(href).toContain('99999');
    expect(href).toContain('41 mm continuous');
  });

  it('embeds the captured raw SKU bytes in the submission invite when present', async () => {
    const wrapper = await mountWithDetection({
      withCustomMedia: true,
      detectedMedia: UNKNOWN_DETECTED,
      skuRawBytes: 'b6ca3000c0ffee',
    });
    const href = decodeURIComponent(wrapper.find('.detected-unknown a').attributes('href') ?? '');
    expect(href).toContain('Raw SKU dump');
    expect(href).toContain('b6ca3000c0ffee');
  });

  it('omits the raw-bytes block from the invite when no SKU bytes were captured', async () => {
    const wrapper = await mountWithDetection({
      withCustomMedia: true,
      detectedMedia: UNKNOWN_DETECTED,
    });
    const href = decodeURIComponent(wrapper.find('.detected-unknown a').attributes('href') ?? '');
    expect(href).not.toContain('Raw SKU dump');
  });

  it('shows the generic add-support link with the [media] title when nothing was detected', async () => {
    const wrapper = await mountWithDetection({ withCustomMedia: true, detectedMedia: undefined });
    expect(wrapper.find('.detected-unknown').exists()).toBe(false);
    const link = wrapper.find('.dont-see a');
    expect(link.exists()).toBe(true);
    // Same destination + title shape as the detected-roll invite.
    const href = decodeURIComponent(link.attributes('href') ?? '');
    expect(href).toContain('/issues/new');
    expect(href).toContain('[media] Add a label type to the fake catalogue');
  });

  it('shows no SKU-submission invite once detection matched the catalogue', async () => {
    const wrapper = await mountWithDetection({
      withCustomMedia: true,
      detectedMedia: { ...CATALOGUE_MEDIA },
    });
    expect(wrapper.find('.detected-unknown').exists()).toBe(false);
  });

  it('resolves detected-unrecognized from rfid.barcode when detectedMedia is undefined', async () => {
    // Niimbot scenario: chassis read an RFID barcode the driver
    // couldn't resolve to a catalogue entry. The shell synthesises a
    // rawDetected from rfid so the picker engages the geometry-edit
    // panel.
    const mode = detectionModeOf(
      await mountWithDetection({
        withCustomMedia: true,
        detectedMedia: undefined,
        rfid: { source: 'paper', uuid: 'deadbeef', barcode: 'NEW-OEM-XYZ' },
      }),
    );
    expect(mode).toBe('detected-unrecognized');
  });

  it('folds the full rfid payload into the prefilled catalogue invite', async () => {
    const wrapper = await mountWithDetection({
      withCustomMedia: true,
      detectedMedia: undefined,
      rfid: {
        source: 'paper',
        uuid: '1122334455667788',
        barcode: 'NEW-OEM-XYZ',
        serialNumber: 'SN42',
        allPaper: 200,
        usedPaper: 7,
        labelType: 1,
        rawHex: 'aa11bb22',
      },
    });
    const href = decodeURIComponent(wrapper.find('.detected-unknown a').attributes('href') ?? '');
    // The synthesised barcode flows into the subject.
    expect(href).toContain('NEW-OEM-XYZ');
    // The pretty-printed rfid block carries every populated field.
    expect(href).toContain('uuid: 1122334455667788');
    expect(href).toContain('barcode: NEW-OEM-XYZ');
    expect(href).toContain('serialNumber: SN42');
    expect(href).toContain('allPaper: 200');
    expect(href).toContain('usedPaper: 7');
    expect(href).toContain('labelType: 1');
    expect(href).toContain('aa11bb22');
  });

  it('omits the rfid fallback when the barcode is empty', async () => {
    // rfid present but no barcode → no synthesised detection. Picker
    // degrades to auto-suggest just like a hint-less detection.
    const mode = detectionModeOf(
      await mountWithDetection({
        withCustomMedia: true,
        detectedMedia: undefined,
        rfid: { source: 'paper', uuid: 'deadbeef' },
      }),
    );
    expect(mode).toBe('auto-suggest');
  });

  it('folds detection context into the generic add-support link when a roll matched the catalogue', async () => {
    // auto-locked: a catalogued roll is loaded, so the generic link
    // shows — and still carries what the printer reported plus the
    // raw SKU bytes, as context for the by-hand label report.
    const wrapper = await mountWithDetection({
      withCustomMedia: true,
      detectedMedia: { ...CATALOGUE_MEDIA },
      skuRawBytes: 'b6ca3000aabbcc',
    });
    expect(wrapper.find('.detected-unknown').exists()).toBe(false);
    const href = decodeURIComponent(wrapper.find('.dont-see a').attributes('href') ?? '');
    expect(href).toContain('Printer currently reports');
    expect(href).toContain('89×28mm Address');
    expect(href).toContain('b6ca3000aabbcc');
  });
});
