/**
 * Diagnostics-path coverage for the brother-ql harness adapter
 * (plan 13 Phase 2 step 7).
 *
 * Exercises the `?mock=ql_820nwbc` connect → `getStatus()` decode →
 * `buildReport` fold, against the seeded mock transport (32-byte
 * status frame). Confirms `HardwareReport.diagnostics` carries the
 * shell-captured live device-state.
 *
 * brother-ql has no `ESC V` engine version and no `ESC U` SKU dump,
 * so `engineVersion` / `skuInfo` are never populated — the diagnostics
 * block carries only `prePrintStatus` / `postPrintStatus`.
 */
import { describe, expect, it } from 'vitest';
import type { EngineSession } from '@thermal-label/harness-shell';
import type { HardwareReport, IdentitySnapshot } from '@thermal-label/harness-core/shared';
import type { BrotherQLMedia } from '@thermal-label/brother-ql-core';
import { adapter } from '../adapter';

type BqlSession = EngineSession<BrotherQLMedia>;

/** Connect the adapter against a mock target and return its result. */
function connectMock(mockTarget: string): ReturnType<typeof adapter.connect> {
  return adapter.connect({ mock: true, mockTarget });
}

describe('brother-ql harness adapter — diagnostics path (mock ql_820nwbc)', () => {
  it('getStatus() on the mock decodes a 32-byte status frame with details[]', async () => {
    const result = await connectMock('ql_820nwbc');
    const printer = Object.values(result.printers)[0]!;
    const status = await printer.getStatus();

    expect(status.rawBytes.length).toBe(32);
    expect(status.ready).toBe(true);
    expect(status.mediaLoaded).toBe(true);

    // The contracts-standard detail rows the diagnostics panel renders.
    expect(status.details).toBeDefined();
    const labels = (status.details ?? []).map(d => d.label);
    expect(labels).toContain('Print phase');
  });

  it('buildReport folds the captured diagnostics into HardwareReport.diagnostics', async () => {
    const result = await connectMock('ql_820nwbc');
    const role = Object.keys(result.printers)[0]!;
    const printer = result.printers[role]!;
    const engine = result.device.engines[0]!;

    // Simulate the shell flow: a pre/post-print status pair. brother-ql
    // captures no ESC V / ESC U — the session leaves `engineVersion` /
    // `skuInfo` unset.
    const prePrintStatus = await printer.getStatus();
    const postPrintStatus = await printer.getStatus();

    const session: BqlSession = {
      engine,
      media: adapter.media[0]!,
      printed: true,
      rung: 'verified',
      notes: '',
      prePrintStatus,
      postPrintStatus,
    };

    const identity: IdentitySnapshot = {
      advertisedName: 'QL-820NWBc',
      vid: 0x04f9,
      pid: 0x209d,
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
    expect(d.prePrintStatus?.rawBytes.length).toBe(64); // 32 bytes → 64 hex chars
    // Pre/post are the same mock status frame (byte-identical) — the
    // builder drops the duplicate post to keep the report URL-sized.
    expect(d.postPrintStatus).toBeUndefined();
    // No ESC V / ESC U on brother-ql — these stay unset.
    expect(d.engineVersion).toBeUndefined();
    expect(d.skuInfo).toBeUndefined();

    // The whole report survives a JSON round-trip (no Uint8Array leaks).
    const round = JSON.parse(JSON.stringify(report)) as HardwareReport; // eslint-disable-line unicorn/prefer-structured-clone -- exercising the JSON.stringify path the report renderer uses
    expect(round.diagnostics?.prePrintStatus?.rawBytes).toBe(d.prePrintStatus?.rawBytes);
  });

  it('produces no diagnostics block when nothing was captured', async () => {
    const result = await connectMock('ql_820nwbc');

    const session: BqlSession = {
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
      identity: { advertisedName: 'QL-820NWBc' },
      primarySession: session,
      allSessions: [session],
      multiEngine: false,
      mocked: true,
    });

    expect(report.diagnostics).toBeUndefined();
    expect(report.schemaVersion).toBe(1);
  });
});
