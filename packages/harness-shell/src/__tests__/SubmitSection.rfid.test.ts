/**
 * Tests for `SubmitSection.vue`'s unrecognized-RFID catalogue CTA.
 *
 * Mirrors the LW 5xx unrecognized-NFC catalogue-contribution flow for
 * niimbot: when the chassis reported an RFID barcode the driver
 * couldn't resolve to a catalogue entry (`status.detectedMedia`
 * undefined, `status.rfid.barcode` populated), SubmitSection renders a
 * second CTA next to "Submit verification report" — a prefilled GitHub
 * issue at the driver repo with the operator-confirmed dimensions +
 * the full rfid payload pretty-printed for the new `media.json5` entry.
 */
import { describe, expect, it } from 'vitest';
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

const NIIMBOT_ENGINE: PrintEngine = {
  role: 'primary',
  protocol: 'niimbot-v1',
  dpi: 203,
  headDots: 384,
  capabilities: { mediaDetection: true },
};

const FAKE_DEVICE: FakeDevice = {
  key: 'B1',
  name: 'Niimbot B1',
  engines: [NIIMBOT_ENGINE],
};

const fakeAdapter: DriverAdapter<FakeDevice, MediaDescriptor> = {
  driverKey: 'niimbot',
  driverDisplayName: 'Niimbot',
  targetRepo: 'thermal-label/niimbot',
  harnessVersion: '0.0.0-test',
  driverVersion: '0.0.0-test',
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
  buildReport: () => ({
    schemaVersion: 1,
    driver: 'niimbot',
    driverVersion: '0.0.0-test',
    harnessVersion: '0.0.0-test',
    device: { detected: { advertisedName: 'Niimbot B1' }, confirmed: { model: 'Niimbot B1' } },
    transports: [{ name: 'bluetooth-gatt', patterns: { diagnostic: 'pass' }, rung: 'verified' }],
    submittedAt: '2026-05-20T00:00:00.000Z',
  }),
};

interface RfidShape {
  source?: 'paper' | 'ribbon';
  uuid?: string;
  barcode?: string;
  serialNumber?: string;
  allPaper?: number;
  usedPaper?: number;
  labelType?: number;
  capacity?: number;
  rawHex?: string;
}

interface NiimbotStatusShape extends PrinterStatus {
  rfid?: RfidShape;
}

function mountSection(): {
  wrapper: ReturnType<typeof mount>;
  session: Session<FakeDevice, MediaDescriptor>;
} {
  let session!: Session<FakeDevice, MediaDescriptor>;
  const Inner = defineComponent({
    setup() {
      session = provideSession<FakeDevice, MediaDescriptor>();
      return () => h(SubmitSection);
    },
  });
  const Wrapper = defineComponent({
    setup() {
      provideAdapter(fakeAdapter);
      return () => h(Inner);
    },
  });
  const wrapper = mount(Wrapper);
  return { wrapper, session };
}

/**
 * Drive the session into a connected, fully-assessed state with the
 * given status snapshot on the primary engine. `canSubmit` keys off
 * `assessedCount >= 1`, so each connected engine needs a rung set.
 */
function connectAndAssess(
  session: Session<FakeDevice, MediaDescriptor>,
  status: NiimbotStatusShape,
  media: MediaDescriptor | null,
): void {
  session.device.value = FAKE_DEVICE;
  session.syncEngineSessions(FAKE_DEVICE);
  session.connection.printers = { primary: {} as never };
  session.connection.identity = { advertisedName: 'Niimbot B1' };
  session.connection.mocked = true;
  session.printerStatus.primary = status;
  const slot = session.engineSessions.primary;
  if (slot) {
    slot.media = media;
    slot.printed = true;
    slot.rung = 'verified';
  }
}

const UNKNOWN_RFID_STATUS: NiimbotStatusShape = {
  ready: true,
  mediaLoaded: true,
  errors: [],
  rawBytes: new Uint8Array(0),
  rfid: {
    source: 'paper',
    uuid: '1122334455667788',
    barcode: 'NEW-OEM-BARCODE-42',
    serialNumber: 'SN9001',
    allPaper: 200,
    usedPaper: 17,
    labelType: 1,
    capacity: 100,
    rawHex: 'aa11bb22cc33',
  },
  // detectedMedia intentionally absent — the unknown-barcode shape.
};

const CONFIRMED_CUSTOM_MEDIA: MediaDescriptor = {
  id: 'unknown-NEW-OEM-BARCODE-42',
  name: 'NEW-OEM-BARCODE-42',
  widthMm: 50,
  heightMm: 30,
  type: 'die-cut',
};

/**
 * Decode an href the way an operator would read it. `URLSearchParams`
 * encodes spaces as `+` and `decodeURIComponent` doesn't reverse that,
 * so a manual `+` → ` ` replacement comes after.
 */
function decodeHref(href: string): string {
  return decodeURIComponent(href).replaceAll('+', ' ');
}

describe('SubmitSection — unrecognized RFID catalogue CTA', () => {
  it('renders the CTA when status carries an unrecognized rfid barcode', async () => {
    const { wrapper, session } = mountSection();
    connectAndAssess(session, UNKNOWN_RFID_STATUS, CONFIRMED_CUSTOM_MEDIA);
    await nextTick();

    const cta = wrapper.find('.catalogue-cta');
    expect(cta.exists()).toBe(true);
    expect(cta.text()).toContain('Catalogue this RFID barcode');
  });

  it('omits the CTA when detectedMedia is set (catalogued roll)', async () => {
    const { wrapper, session } = mountSection();
    const status: NiimbotStatusShape = {
      ...UNKNOWN_RFID_STATUS,
      detectedMedia: { id: 'known', name: 'Known', widthMm: 50, type: 'die-cut' },
    };
    connectAndAssess(session, status, CONFIRMED_CUSTOM_MEDIA);
    await nextTick();
    expect(wrapper.find('.catalogue-cta').exists()).toBe(false);
  });

  it('omits the CTA when rfid is absent', async () => {
    const { wrapper, session } = mountSection();
    const status: NiimbotStatusShape = {
      ready: true,
      mediaLoaded: true,
      errors: [],
      rawBytes: new Uint8Array(0),
    };
    connectAndAssess(session, status, CONFIRMED_CUSTOM_MEDIA);
    await nextTick();
    expect(wrapper.find('.catalogue-cta').exists()).toBe(false);
  });

  it('omits the CTA when rfid has no barcode field', async () => {
    const { wrapper, session } = mountSection();
    const status: NiimbotStatusShape = {
      ready: true,
      mediaLoaded: true,
      errors: [],
      rawBytes: new Uint8Array(0),
      rfid: { source: 'paper', uuid: 'deadbeef' },
    };
    connectAndAssess(session, status, CONFIRMED_CUSTOM_MEDIA);
    await nextTick();
    expect(wrapper.find('.catalogue-cta').exists()).toBe(false);
  });

  it("prefills the issue URL with the unknown barcode, operator dimensions, and rfid payload", async () => {
    const { wrapper, session } = mountSection();
    connectAndAssess(session, UNKNOWN_RFID_STATUS, CONFIRMED_CUSTOM_MEDIA);
    await nextTick();

    const cta = wrapper.find('.catalogue-cta');
    const href = decodeHref(cta.attributes('href') ?? '');
    expect(href).toContain('thermal-label/niimbot/issues/new');
    // Title carries the barcode + the operator-confirmed dimensions.
    expect(href).toContain('media(niimbot): catalogue new barcode NEW-OEM-BARCODE-42 (50×30)');
    // Body carries the operator-confirmed dimensions.
    expect(href).toContain('Operator-confirmed dimensions');
    expect(href).toContain('50 × 30 mm');
    // Body carries the full RFID payload.
    expect(href).toContain('uuid: 1122334455667788');
    expect(href).toContain('barcode: NEW-OEM-BARCODE-42');
    expect(href).toContain('serialNumber: SN9001');
    expect(href).toContain('allPaper: 200');
    expect(href).toContain('usedPaper: 17');
    expect(href).toContain('labelType: 1');
    expect(href).toContain('capacity: 100');
    // Raw hex dump rides through as a fenced block.
    expect(href).toContain('aa11bb22cc33');
  });

  it("renders the continuous-dimension shape in the title when media.type is continuous", async () => {
    const { wrapper, session } = mountSection();
    const continuousMedia: MediaDescriptor = {
      id: 'unknown-NEW-OEM-BARCODE-42',
      name: 'NEW-OEM-BARCODE-42',
      widthMm: 50,
      type: 'continuous',
    };
    connectAndAssess(session, UNKNOWN_RFID_STATUS, continuousMedia);
    await nextTick();

    const href = decodeHref(wrapper.find('.catalogue-cta').attributes('href') ?? '');
    expect(href).toContain('media(niimbot): catalogue new barcode NEW-OEM-BARCODE-42 (50×continuous)');
    expect(href).toContain('Width: 50 mm (continuous)');
  });
});
