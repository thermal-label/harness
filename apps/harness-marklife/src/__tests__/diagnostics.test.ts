/**
 * Diagnostics-path coverage for the marklife harness adapter
 * (plan 13 Phase 2 step 8c).
 *
 * Exercises the `?mock=p12` connect → `getStatus()` decode →
 * `buildReport` fold. The marklife driver exposes no battery /
 * cassette / live-status telemetry — `WebMarklifePrinter.getStatus()`
 * synthesises a `MarklifeStatus` from the transport's `connected`
 * flag rather than reading the wire. So the captured status is the
 * plain `ready` / `errors` shape, and its `rawBytes` is always empty.
 *
 * Because `getStatus()` does not read device state, the pre- and
 * post-print statuses are byte-identical (both empty `rawBytes`), so
 * `buildReportDiagnostics` drops the duplicate `postPrintStatus` — the
 * diagnostics block carries only `prePrintStatus`. This is the key
 * shape difference from telemetry-bearing drivers and from the
 * letratag harness, whose post-print `[1B 52 code]` notification
 * differs from its pre-print status.
 *
 * Marklife has no `ESC V` engine version and no `ESC U` SKU dump, so
 * `engineVersion` / `skuInfo` are never populated.
 */
import { describe, expect, it } from 'vitest';
import type { EngineSession } from '@thermal-label/harness-shell';
import type { HardwareReport, IdentitySnapshot } from '@thermal-label/harness-core/shared';
import type { MarklifeMedia } from '@thermal-label/marklife-core';
import { adapter } from '../adapter';
import { buildDiagnosticImage } from '../diagnostic-print';

type MarklifeSession = EngineSession<MarklifeMedia>;

/** Connect the adapter against a mock target and return its result. */
function connectMock(mockTarget: string): ReturnType<typeof adapter.connect> {
  return adapter.connect({ mock: true, mockTarget });
}

describe('marklife harness adapter — diagnostics path (mock p12)', () => {
  it('getStatus() on the mock returns the plain ready/errors status', async () => {
    const result = await connectMock('p12');
    const printer = Object.values(result.printers)[0]!;
    const status = await printer.getStatus();

    // The P12 has no out-of-job telemetry — `getStatus()` synthesises
    // an idle status: ready (transport connected), no errors.
    expect(status.ready).toBe(true);
    expect(status.errors).toEqual([]);

    // No battery telemetry exists on this device.
    expect(status.battery).toBeUndefined();
    // The synthesised status carries no raw wire bytes.
    expect(status.rawBytes.length).toBe(0);
  });

  it('print() on the mock leaves a ready post-print status', async () => {
    const result = await connectMock('p12');
    const printer = Object.values(result.printers)[0]!;
    // The mock transport silently accepts the L11 job (fire-and-
    // forget — the driver never reads a reply).
    await printer.print(
      { width: 16, height: 8, data: new Uint8Array(16 * 8 * 4).fill(255) },
      adapter.media[0],
    );
    const status = await printer.getStatus();
    expect(status.ready).toBe(true);
    expect(status.errors).toEqual([]);
  });

  it('buildReport folds the captured diagnostics into HardwareReport.diagnostics', async () => {
    const result = await connectMock('p12');
    const role = Object.keys(result.printers)[0]!;
    const printer = result.printers[role]!;
    const engine = result.device.engines[0]!;

    // Simulate the shell flow: a pre/post-print status pair. marklife
    // captures no ESC V / ESC U — the session leaves `engineVersion` /
    // `skuInfo` unset.
    const prePrintStatus = await printer.getStatus();
    await printer.print(
      { width: 16, height: 8, data: new Uint8Array(16 * 8 * 4).fill(255) },
      adapter.media[0],
    );
    const postPrintStatus = await printer.getStatus();

    const session: MarklifeSession = {
      engine,
      media: adapter.media[0]!,
      printed: true,
      rung: 'verified',
      notes: '',
      prePrintStatus,
      postPrintStatus,
    };

    const identity: IdentitySnapshot = {
      advertisedName: 'P12',
    };

    const report: HardwareReport = adapter.buildReport({
      device: result.device,
      identity,
      primarySession: session,
      allSessions: [session],
      multiEngine: false,
      mocked: true,
    });

    expect(report.diagnostics).toBeDefined();
    const d = report.diagnostics!;
    // rawBytes hex-encoded — survives JSON.stringify. marklife's
    // synthesised status has no wire bytes, so the hex is empty.
    expect(typeof d.prePrintStatus?.rawBytes).toBe('string');
    expect(d.prePrintStatus?.rawBytes).toBe('');
    // `getStatus()` does not read device state — pre and post are
    // byte-identical, so the builder drops the duplicate post.
    expect(d.postPrintStatus).toBeUndefined();
    // The captured status is the plain ready/errors shape.
    expect(d.prePrintStatus?.ready).toBe(true);
    // No ESC V / ESC U on marklife — these stay unset.
    expect(d.engineVersion).toBeUndefined();
    expect(d.skuInfo).toBeUndefined();

    // The whole report survives a JSON round-trip (no Uint8Array leaks).
    const round = JSON.parse(JSON.stringify(report)) as HardwareReport; // eslint-disable-line unicorn/prefer-structured-clone -- exercising the JSON.stringify path the report renderer uses
    expect(round.diagnostics?.prePrintStatus?.rawBytes).toBe(d.prePrintStatus?.rawBytes);
  });

  it('produces no diagnostics block when nothing was captured', async () => {
    const result = await connectMock('p12');

    const session: MarklifeSession = {
      engine: result.device.engines[0]!,
      media: adapter.media[0]!,
      printed: true,
      rung: 'verified',
      notes: '',
      prePrintStatus: null,
      postPrintStatus: null,
    };

    const report = adapter.buildReport({
      device: result.device,
      identity: { advertisedName: 'P12' },
      primarySession: session,
      allSessions: [session],
      multiEngine: false,
      mocked: true,
    });

    expect(report.diagnostics).toBeUndefined();
    expect(report.schemaVersion).toBe(1);
  });

  it('buildReport surfaces the P12 GATT service UUID on detected identity', async () => {
    const result = await connectMock('p12');
    const session: MarklifeSession = {
      engine: result.device.engines[0]!,
      media: adapter.media[0]!,
      printed: true,
      rung: 'verified',
      notes: '',
      prePrintStatus: null,
      postPrintStatus: null,
    };

    const report = adapter.buildReport({
      device: result.device,
      // No serviceUuid in the incoming identity — the adapter falls
      // back to the registry value.
      identity: { advertisedName: 'P12' },
      primarySession: session,
      allSessions: [session],
      multiEngine: false,
      mocked: true,
    });

    expect(report.device.detected.serviceUuid).toBe('0000ff00-0000-1000-8000-00805f9b34fb');
    // mock run is tagged so a stray submit isn't a real verification.
    expect(report.device.detected.extra?.mocked).toBe(true);
  });
});

// ─── Catalogue-wide selection ────────────────────────────────────

describe('device catalogue', () => {
  it('offers every drivable, browser-reachable marklife chassis', () => {
    const keys = adapter.devices.map(d => d.key);
    // One per sub-engine: l11, yxq, tspl, escpos.
    expect(keys).toContain('P12');
    expect(keys).toContain('P15');
    expect(keys).toContain('S2');
    expect(keys).toContain('A1');
    expect(keys).toContain('LP15');
    expect(keys.length).toBeGreaterThan(20);
  });

  it('excludes the JBIG chassis whose encoder is deferred', () => {
    const keys = adapter.devices.map(d => d.key);
    // These throw UnsupportedOperationError at encode time (D4) —
    // offering them would walk the operator to an impossible print.
    for (const key of ['D100', 'X4', 'X8', 'U210_BY_D210', 'L100_BY_X4']) {
      expect(keys).not.toContain(key);
    }
  });

  it('spans more than one transport, so the shell renders a button per pipe', () => {
    const seen = new Set<string>();
    for (const d of adapter.devices) for (const t of Object.keys(d.transports)) seen.add(t);
    expect(seen.has('usb')).toBe(true);
    expect(seen.has('bluetooth-spp')).toBe(true);
    expect(seen.has('bluetooth-gatt')).toBe(true);
  });

  it('mock targets all resolve to a catalogue entry', () => {
    const keys = new Set(adapter.devices.map(d => d.key));
    for (const [alias, spec] of Object.entries(adapter.mockTargets)) {
      expect(keys.has(spec.device.key), `${alias} -> ${spec.device.key}`).toBe(true);
    }
  });
});

describe('media picker', () => {
  const mediaFor = (deviceKey: string): string[] => {
    const device = adapter.devices.find(d => d.key === deviceKey);
    if (!device) throw new Error(`no device ${deviceKey}`);
    const engine = device.engines[0]!;
    // MEDIA is keyed by name in the registry map; the entries
    // themselves carry `id`, not `key`.
    return adapter.mediaPicker
      .filterByDeviceEngine(adapter.media, device, engine)
      .map(m => String(m.id));
  };

  it('narrows a 0.5" chassis to narrow-tape stock', () => {
    const ids = mediaFor('P12');
    expect(ids).toContain('continuous-15mm');
    expect(ids).not.toContain('shipping-100x150');
  });

  it('narrows a 2" chassis to mobile stock', () => {
    const ids = mediaFor('S2');
    expect(ids).toContain('continuous-50mm');
    expect(ids).not.toContain('continuous-15mm');
  });
});

describe('buildReport transport', () => {
  it('names the transport that was actually exercised', () => {
    const device = adapter.devices.find(d => d.key === 'P15');
    const media = adapter.media.find(m => m.id === 'continuous-15mm');
    if (!device || !media) throw new Error('P15 / 15 mm roll missing from the catalogue');
    const session = {
      engine: device.engines[0],
      media,
      printed: true,
      rung: 'verified',
      notes: '',
    } as unknown as MarklifeSession;
    const report = adapter.buildReport({
      device,
      identity: {},
      primarySession: session,
      allSessions: [session],
      multiEngine: false,
      mocked: false,
      transport: 'usb',
    });
    expect(report.transports[0]?.name).toBe('usb');
    // vid/pid only belong on the report when USB was the pipe.
    expect(report.device.confirmed.vid).toBe(0x5958);
  });
});

// ─── Diagnostic canvas tracks the selected media ─────────────────

describe('diagnostic canvas', () => {
  const deviceFor = (key: string) => {
    const d = adapter.devices.find(x => x.key === key);
    if (!d) throw new Error(`no device ${key}`);
    return d;
  };
  const mediaFor = (id: string) => {
    const m = adapter.media.find(x => String(x.id) === id);
    if (!m) throw new Error(`no media ${id}`);
    return m;
  };
  const build = (deviceKey: string, mediaId: string) =>
    buildDiagnosticImage({
      device: deviceFor(deviceKey),
      media: mediaFor(mediaId),
      harnessVersion: '0.0.0',
      driverVersion: '0.0.0',
    });

  it('narrows the canvas to the loaded roll', () => {
    // Both fit inside the S2's 384-dot head, so the roll decides.
    const wide = build('S2', 'gap-50x30');
    const narrow = build('S2', 'gap-40x20');
    expect(wide.width).toBeGreaterThan(narrow.width);
  });

  it('never exceeds the head, however wide the roll', () => {
    // A 50 mm roll against a 96-dot (12 mm) head: the head wins.
    const img = build('P12', 'gap-50x30');
    const head = deviceFor('P12').engines[0]?.headDots ?? 0;
    expect(img.width).toBeLessThanOrEqual(head);
  });

  it('bounds the canvas height on die-cut stock', () => {
    // 30 mm vs 20 mm at 203 dpi — the page boundary must show up.
    const tall = build('S2', 'gap-50x30');
    const short = build('S2', 'gap-40x20');
    expect(tall.height).toBeGreaterThan(short.height);
  });

  it('leaves continuous stock to the shared feed budget', () => {
    // No page boundary, so height must not track the roll width.
    const cont = build('P12', 'continuous-15mm');
    const diecut = build('P12', 'gap-15x30');
    expect(cont.height).not.toBe(diecut.height);
    expect(cont.width).toBeGreaterThan(0);
  });
});
