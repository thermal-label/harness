/**
 * Diagnostics-path coverage for the letratag harness adapter
 * (plan 13 Phase 2 step 8c).
 *
 * Exercises the `?mock=lt_200b` connect → `getStatus()` decode →
 * `buildReport` fold. The LT-200B exposes no battery / cassette /
 * live-status telemetry over BLE — its only real status is the 3-byte
 * post-print `[1B 52 code]` notification. So the captured status is
 * the plain `ready` / `errors` shape; the diagnostics block folds the
 * post-print status snapshots only.
 *
 * LetraTag has no `ESC V` engine version and no `ESC U` SKU dump, so
 * `engineVersion` / `skuInfo` are never populated — the diagnostics
 * block carries only `prePrintStatus` / `postPrintStatus`.
 */
import { describe, expect, it } from 'vitest';
import type { EngineSession } from '@thermal-label/harness-shell';
import type { HardwareReport, IdentitySnapshot } from '@thermal-label/harness-core/shared';
import type { LetraTagMedia } from '@thermal-label/letratag-core';
import { adapter } from '../adapter';

type LtSession = EngineSession<LetraTagMedia>;

/** Connect the adapter against a mock target and return its result. */
function connectMock(mockTarget: string): ReturnType<typeof adapter.connect> {
  return adapter.connect({ mock: true, mockTarget });
}

describe('letratag harness adapter — diagnostics path (mock lt_200b)', () => {
  it('getStatus() on the mock returns the plain ready/errors status', async () => {
    const result = await connectMock('lt_200b');
    const printer = Object.values(result.printers)[0]!;
    const status = await printer.getStatus();

    // The LT-200B has no out-of-job telemetry — before any print the
    // status is a default idle: ready, no errors.
    expect(status.ready).toBe(true);
    expect(status.errors).toEqual([]);

    // No battery / cassette telemetry exists on this device.
    expect(status.battery).toBeUndefined();
    expect(status.details).toBeUndefined();
  });

  it('print() on the mock yields a post-print status snapshot', async () => {
    const result = await connectMock('lt_200b');
    const printer = Object.values(result.printers)[0]!;
    // The mock transport queues a 3-byte success reply after the
    // print payload's MAGIC trailer.
    await printer.print(
      { width: 12, height: 6, data: new Uint8Array(12 * 6 * 4).fill(255) },
      adapter.media[0],
    );
    const status = await printer.getStatus();
    expect(status.ready).toBe(true);
    expect(status.errors).toEqual([]);
  });

  it('buildReport folds the captured diagnostics into HardwareReport.diagnostics', async () => {
    const result = await connectMock('lt_200b');
    const role = Object.keys(result.printers)[0]!;
    const printer = result.printers[role]!;
    const engine = result.device.engines[0]!;

    // Simulate the shell flow: a pre/post-print status pair. letratag
    // captures no ESC V / ESC U — the session leaves `engineVersion` /
    // `skuInfo` unset.
    const prePrintStatus = await printer.getStatus();
    await printer.print(
      { width: 12, height: 6, data: new Uint8Array(12 * 6 * 4).fill(255) },
      adapter.media[0],
    );
    const postPrintStatus = await printer.getStatus();

    const session: LtSession = {
      engine,
      media: adapter.media[0]!,
      printed: true,
      rung: 'verified',
      notes: '',
      prePrintStatus,
      postPrintStatus,
    };

    const identity: IdentitySnapshot = {
      advertisedName: 'Letratag LT-200B',
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
    // rawBytes hex-encoded — survives JSON.stringify.
    expect(typeof d.prePrintStatus?.rawBytes).toBe('string');
    expect(d.postPrintStatus).toBeDefined();
    // The captured status is the plain ready/errors shape — no
    // battery / details on this device.
    expect(d.prePrintStatus?.ready).toBe(true);
    expect(d.postPrintStatus?.ready).toBe(true);
    // No ESC V / ESC U on letratag — these stay unset.
    expect(d.engineVersion).toBeUndefined();
    expect(d.skuInfo).toBeUndefined();

    // The whole report survives a JSON round-trip (no Uint8Array leaks).
    const round = JSON.parse(JSON.stringify(report)) as HardwareReport; // eslint-disable-line unicorn/prefer-structured-clone -- exercising the JSON.stringify path the report renderer uses
    expect(round.diagnostics?.prePrintStatus?.rawBytes).toBe(d.prePrintStatus?.rawBytes);
  });

  it('produces no diagnostics block when nothing was captured', async () => {
    const result = await connectMock('lt_200b');

    const session: LtSession = {
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
      identity: { advertisedName: 'Letratag LT-200B' },
      primarySession: session,
      allSessions: [session],
      multiEngine: false,
      mocked: true,
    });

    expect(report.diagnostics).toBeUndefined();
    expect(report.schemaVersion).toBe(1);
  });
});
