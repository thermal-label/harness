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

    expect(report.device.detected.serviceUuid).toBe(
      '0000ff00-0000-1000-8000-00805f9b34fb',
    );
    // mock run is tagged so a stray submit isn't a real verification.
    expect(report.device.detected.extra?.mocked).toBe(true);
  });
});
