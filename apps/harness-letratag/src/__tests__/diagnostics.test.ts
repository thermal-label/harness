/**
 * Diagnostics-path coverage for the letratag harness adapter
 * (plan 13 Phase 2 step 8c).
 *
 * Exercises the `?mock=lt_200b` connect → `getStatus()` decode →
 * `buildReport` fold, against the seeded mock advertising status
 * (12 mm cassette, mid-charge charging battery). Confirms
 * `HardwareReport.diagnostics` carries the shell-captured live
 * device-state, and that the decoded status carries the Phase-2
 * `battery` + `details[]` rewritten in letratag-core.
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
  it('getStatus() on the mock decodes battery + details from advertising data', async () => {
    const result = await connectMock('lt_200b');
    const printer = Object.values(result.printers)[0]!;
    const status = await printer.getStatus();

    // Battery glyph path — the seeded advertising status is level 2
    // (≈67%), charging.
    expect(status.battery).toBeDefined();
    expect(status.battery?.fraction).toBeCloseTo(2 / 3);
    expect(status.battery?.charging).toBe(true);

    // The contracts-standard detail rows the diagnostics panel renders.
    expect(status.details).toBeDefined();
    const labels = (status.details ?? []).map(d => d.label);
    expect(labels).toContain('Cassette width');
    expect(labels).toContain('Protocol revision');
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
    // The captured status carries the LetraTag battery + details.
    expect(d.prePrintStatus?.battery?.charging).toBe(true);
    expect(d.prePrintStatus?.details?.length).toBeGreaterThan(0);
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
