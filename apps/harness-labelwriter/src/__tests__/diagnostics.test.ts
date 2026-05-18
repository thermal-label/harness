/**
 * Diagnostics-path coverage for the LabelWriter harness adapter
 * (plan 13 Phase 1 step 6).
 *
 * Exercises the full `?mock=lw550` connect → eager `ESC U` / `ESC V`
 * capture → `getStatus()` decode → `buildReport` fold, against the
 * seeded mock transport (32-byte `ESC A`, 63-byte `ESC U`, 34-byte
 * `ESC V` replies). Confirms `HardwareReport.diagnostics` carries the
 * captured live device-state — the artifact that makes a failed LW 5xx
 * report debuggable.
 */
import { describe, expect, it } from 'vitest';
import type { PrintEngine, PrinterAdapter } from '@thermal-label/contracts';
import type { EngineSession } from '@thermal-label/harness-shell';
import {
  renderIssueBody,
  type EnvironmentSnapshot,
  type HardwareReport,
  type IdentitySnapshot,
} from '@thermal-label/harness-core/shared';
import type { LabelWriterAnyMedia } from '@thermal-label/labelwriter-core';
import { adapter } from '../adapter';

type LwSession = EngineSession<LabelWriterAnyMedia>;

/** Connect the adapter against a mock target and return its result. */
function connectMock(mockTarget: string): ReturnType<typeof adapter.connect> {
  return adapter.connect({ mock: true, mockTarget });
}

/** A per-engine LabelWriter-web printer carries its scoped `engine`. */
function engineOf(printer: PrinterAdapter): PrintEngine {
  return (printer as unknown as { engine: PrintEngine }).engine;
}

describe('LabelWriter harness adapter — diagnostics path (mock lw550)', () => {
  it('captures ESC V engine version + ESC U SKU info on connect', async () => {
    const result = await connectMock('lw550');
    expect(result.mocked).toBe(true);
    expect(result.engineDiagnostics).toBeDefined();

    const roles = Object.keys(result.engineDiagnostics ?? {});
    expect(roles.length).toBeGreaterThan(0);
    const diag = result.engineDiagnostics![roles[0]!]!;

    // ESC V → 34-byte version block.
    expect(diag.engineVersion).toBeDefined();
    expect(diag.engineVersion?.hwVersion).toBe('1.0');
    expect(diag.engineVersion?.fwKind).toBe('application');
    expect(diag.engineVersion?.fwVersion).toBe('0102.0003');
    expect(diag.engineVersion?.pid).toBe(0x0028);
    // Raw ESC V frame — hex-encoded, 34 bytes → 68 hex chars.
    expect(diag.engineVersion?.rawBytes).toMatch(/^[0-9a-f]{68}$/);

    // ESC U → 63-byte catalogued SKU dump.
    expect(diag.skuInfo).toBeDefined();
    expect(diag.skuInfo?.sku).toBe('30252');
    expect(diag.skuInfo?.material).toBe('paper');
    expect(diag.skuInfo?.labelColor).toBe('white');
    expect(diag.skuInfo?.totalLabelCount).toBe(260);
    // Raw ESC U frame — hex-encoded, 63 bytes → 126 hex chars.
    expect(diag.skuInfo?.rawBytes).toMatch(/^[0-9a-f]{126}$/);
  });

  it('getStatus() on the mock 550 decodes a 32-byte ESC A with details[]', async () => {
    const result = await connectMock('lw550');
    const printer = Object.values(result.printers)[0]!;
    const status = await printer.getStatus();

    expect(status.rawBytes.length).toBe(32);
    expect(status.ready).toBe(true);
    expect(status.mediaLoaded).toBe(true);
    expect(status.errors).toEqual([]);

    // The decoded detail rows the diagnostics panel renders.
    expect(status.details).toBeDefined();
    const labels = (status.details ?? []).map(d => d.label);
    expect(labels).toContain('Print status');
    expect(labels).toContain('Bay status');
    expect(labels).toContain('Labels remaining');
    const labelsRemaining = status.details?.find(d => d.label === 'Labels remaining');
    expect(labelsRemaining?.value).toBe('220');
  });

  it('non-550 target answers ESC A with the 1-byte lw-450 form, no details', async () => {
    const result = await connectMock('lw330turbo');
    const printer = Object.values(result.printers)[0]!;
    const status = await printer.getStatus();
    expect(status.rawBytes.length).toBe(1);
    expect(status.ready).toBe(true);
    expect(status.details).toBeUndefined();
    // No ESC V / ESC U capture on a 3xx target.
    expect(result.engineDiagnostics).toEqual({});
  });

  it('lw5xl mock answers ESC V with the 5XL USB PID (0x002a)', async () => {
    const result = await connectMock('lw5xl');
    const roles = Object.keys(result.engineDiagnostics ?? {});
    expect(roles.length).toBeGreaterThan(0);
    const diag = result.engineDiagnostics![roles[0]!]!;
    expect(diag.engineVersion?.pid).toBe(0x002a);
    expect(diag.engineVersion?.rawBytes).toMatch(/^[0-9a-f]{68}$/);
  });

  it('buildReport folds the captured diagnostics into HardwareReport.diagnostics', async () => {
    const result = await connectMock('lw550');
    const role = Object.keys(result.printers)[0]!;
    const printer = result.printers[role]!;
    const engine = engineOf(printer);

    // Simulate the shell flow: a pre/post-print status pair, plus the
    // adapter-captured ESC V / ESC U.
    const prePrintStatus = await printer.getStatus();
    const postPrintStatus = await printer.getStatus();
    const diag = result.engineDiagnostics![role]!;

    const session: LwSession = {
      engine,
      media: { id: 'sku-30252', name: '30252', widthMm: 28, heightMm: 89, type: 'die-cut' },
      printed: true,
      rung: 'verified',
      notes: '',
      prePrintStatus,
      postPrintStatus,
      ...(diag.engineVersion ? { engineVersion: diag.engineVersion } : {}),
      ...(diag.skuInfo ? { skuInfo: diag.skuInfo } : {}),
    };

    const identity: IdentitySnapshot = {
      advertisedName: 'LabelWriter 550',
      vid: 0x0922,
      pid: 0x0028,
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
    // Pre/post are the same mock `ESC A` reply (byte-identical) — the
    // builder drops the duplicate post to keep the report URL-sized.
    expect(d.postPrintStatus).toBeUndefined();
    expect(d.engineVersion?.fwVersion).toBe('0102.0003');
    expect(d.engineVersion?.rawBytes).toMatch(/^[0-9a-f]{68}$/);
    expect(d.skuInfo?.sku).toBe('30252');
    expect(d.skuInfo?.rawBytes).toMatch(/^[0-9a-f]{126}$/);

    // The whole report survives a JSON round-trip (no Uint8Array leaks).
    const round = JSON.parse(JSON.stringify(report)) as HardwareReport; // eslint-disable-line unicorn/prefer-structured-clone -- exercising the JSON.stringify path the report renderer uses
    expect(round.diagnostics?.prePrintStatus?.rawBytes).toBe(d.prePrintStatus?.rawBytes);
  });

  it('produces no diagnostics block when nothing was captured', async () => {
    const result = await connectMock('lw330turbo');
    const role = Object.keys(result.printers)[0]!;
    const printer = result.printers[role]!;
    const engine = engineOf(printer);

    const session: LwSession = {
      engine,
      media: {
        id: 'ADDRESS_STANDARD',
        name: 'Address',
        widthMm: 28,
        heightMm: 89,
        type: 'die-cut',
      },
      printed: true,
      rung: 'verified',
      notes: '',
      prePrintStatus: null,
      postPrintStatus: null,
    };

    const report = adapter.buildReport({
      device: result.device,
      identity: { advertisedName: 'LabelWriter 330 Turbo' },
      primarySession: session,
      allSessions: [session],
      multiEngine: false,
      mocked: true,
    });

    expect(report.diagnostics).toBeUndefined();
    expect(report.schemaVersion).toBe(1);
  });

  it('a standard single-engine 550 report fits GitHub’s prefill-URL limit', async () => {
    // Regression guard for REPORT_BLOAT_HANDOFF.md: a full SerializedStatus
    // pre/post pair in `diagnostics` (decoded `details[]` + `detectedMedia`,
    // ×2) pushed the common 550 report over GitHub's ~7.5 KB prefill cap,
    // forcing the title-only paste-recovery path. The lean status
    // projection + post-dedup must keep the common case a one-click submit.
    // Reverting either change re-bloats this real `?mock=lw550` report and
    // trips the assertion.
    const URL_LENGTH_LIMIT = 7_500; // mirrors harness-shell/src/submit/submit.ts
    const result = await connectMock('lw550');
    const role = Object.keys(result.printers)[0]!;
    const printer = result.printers[role]!;
    const engine = engineOf(printer);

    // A clean run — pre/post are the same `ESC A` reply, so the builder
    // drops the duplicate post (the realistic standard-550 shape).
    const prePrintStatus = await printer.getStatus();
    const postPrintStatus = await printer.getStatus();
    const diag = result.engineDiagnostics![role]!;

    const session: LwSession = {
      engine,
      media: { id: 'sku-30252', name: '30252', widthMm: 28, heightMm: 89, type: 'die-cut' },
      printed: true,
      rung: 'verified',
      notes: '',
      prePrintStatus,
      postPrintStatus,
      ...(diag.engineVersion ? { engineVersion: diag.engineVersion } : {}),
      ...(diag.skuInfo ? { skuInfo: diag.skuInfo } : {}),
    };

    // The shell stamps `environment` onto the report at submit time;
    // include a representative browser block so the budget check matches
    // a real one-click submit rather than an under-count.
    const environment: EnvironmentSnapshot = {
      runtime: 'browser',
      browser: 'Chrome',
      browserVersion: '124.0.6367.119',
      os: 'Windows',
      osVersion: '10.0.0',
      mobile: false,
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    };

    const report: HardwareReport = {
      ...adapter.buildReport({
        device: result.device,
        identity: { advertisedName: 'LabelWriter 550', vid: 0x0922, pid: 0x0028 },
        primarySession: session,
        allSessions: [session],
        multiEngine: false,
        mocked: true,
      }),
      environment,
    };

    // The post was deduped — a standard clean 550 report carries one
    // lean status, not a duplicated pair.
    expect(report.diagnostics?.prePrintStatus).toBeDefined();
    expect(report.diagnostics?.postPrintStatus).toBeUndefined();

    const body = renderIssueBody(report);
    const title = '[harness] LabelWriter 550 — usb=verified';
    const url = `https://github.com/thermal-label/labelwriter/issues/new?${new URLSearchParams(
      { title, body },
    ).toString()}`;

    expect(url.length).toBeLessThan(URL_LENGTH_LIMIT);
  });
});
