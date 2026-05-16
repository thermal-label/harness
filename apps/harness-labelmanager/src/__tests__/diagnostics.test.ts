/**
 * Diagnostics-path coverage for the labelmanager harness adapter
 * (plan 13 Phase 2 step 9).
 *
 * Exercises the `?mock=lm_pnp` connect → `getStatus()` decode →
 * `buildReport` fold, against the seeded mock transport (single-byte
 * status reply). Confirms `HardwareReport.diagnostics` carries the
 * shell-captured live device-state.
 *
 * D1 tape status is presence-only (project_d1_presence_only_detection)
 * — no `ESC V` engine version, no `ESC U` SKU dump, no battery. The
 * diagnostics block therefore carries only `prePrintStatus` /
 * `postPrintStatus`, and the decoded status carries no `details[]` /
 * `battery` (graceful degradation — the shell renders no diagnostics
 * panel and no battery glyph for it).
 */
import { describe, expect, it } from 'vitest';
import type { EngineSession } from '@thermal-label/harness-shell';
import type { HardwareReport, IdentitySnapshot } from '@thermal-label/harness-core/shared';
import type { LabelManagerMedia } from '@thermal-label/labelmanager-core';
import { adapter } from '../adapter';

type LmSession = EngineSession<LabelManagerMedia>;

/** Connect the adapter against a mock target and return its result. */
function connectMock(mockTarget: string): ReturnType<typeof adapter.connect> {
  return adapter.connect({ mock: true, mockTarget });
}

describe('labelmanager harness adapter — diagnostics path (mock lm_pnp)', () => {
  it('getStatus() on the mock decodes a presence-only status (no details / battery)', async () => {
    const result = await connectMock('lm_pnp');
    const printer = Object.values(result.printers)[0]!;
    const status = await printer.getStatus();

    // D1 tape status is presence-only (project_d1_presence_only_detection)
    // — no decoded detail rows, no battery, regardless of the
    // ready/mediaLoaded bits. The shell degrades gracefully: no
    // diagnostics panel and no battery glyph render for it.
    expect(status.details ?? []).toHaveLength(0);
    expect(status.battery).toBeUndefined();
    expect(typeof status.ready).toBe('boolean');
    expect(typeof status.mediaLoaded).toBe('boolean');
  });

  it('buildReport folds the captured diagnostics into HardwareReport.diagnostics', async () => {
    const result = await connectMock('lm_pnp');
    const role = Object.keys(result.printers)[0]!;
    const printer = result.printers[role]!;
    const engine = result.device.engines[0]!;

    const prePrintStatus = await printer.getStatus();
    const postPrintStatus = await printer.getStatus();

    const session: LmSession = {
      engine,
      media: adapter.media[0]!,
      printed: true,
      rung: 'verified',
      notes: '',
      prePrintStatus,
      postPrintStatus,
    };

    const identity: IdentitySnapshot = {
      advertisedName: 'LabelManager PnP',
      vid: 0x0922,
      pid: 0x1002,
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
    // D1 has no ESC V / ESC U — these stay unset.
    expect(d.engineVersion).toBeUndefined();
    expect(d.skuInfo).toBeUndefined();

    // The whole report survives a JSON round-trip (no Uint8Array leaks).
    const round = JSON.parse(JSON.stringify(report)) as HardwareReport; // eslint-disable-line unicorn/prefer-structured-clone -- exercising the JSON.stringify path the report renderer uses
    expect(round.diagnostics?.prePrintStatus?.rawBytes).toBe(d.prePrintStatus?.rawBytes);
  });

  it('produces no diagnostics block when nothing was captured', async () => {
    const result = await connectMock('lm_pnp');

    const session: LmSession = {
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
      identity: { advertisedName: 'LabelManager PnP' },
      primarySession: session,
      allSessions: [session],
      multiEngine: false,
      mocked: true,
    });

    expect(report.diagnostics).toBeUndefined();
    expect(report.schemaVersion).toBe(1);
  });
});
