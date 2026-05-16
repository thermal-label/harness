import { describe, expect, it } from 'vitest';
import type { PrinterStatus } from '@thermal-label/contracts';
import {
  buildDiagnosticsSnapshot,
  renderDiagnosticsBlock,
  type BuildDiagnosticsSnapshotInput,
  type DiagnosticsSnapshot,
} from '../diagnostics-snapshot.js';

const status: PrinterStatus = {
  ready: true,
  mediaLoaded: true,
  detectedMedia: {
    id: 'd1-12-bw',
    name: 'D1 12mm black-on-white',
    widthMm: 12,
    type: 'tape',
    // Driver-specific superset field — must be dropped by the projection.
    cornerRadiusMm: 0,
  },
  errors: [],
  rawBytes: new Uint8Array([0x0f, 0xa0, 0x00, 0xff]),
};

const baseInput: BuildDiagnosticsSnapshotInput = {
  driverKey: 'letratag',
  harnessVersion: '0.1.0',
  driverVersion: '0.4.2',
  mocked: false,
  device: { advertisedName: 'LetraTag 200B', vid: 0x0922, pid: 0x1234 },
  engines: [{ role: 'tape', status }],
  capturedAt: new Date('2026-05-16T12:00:00.000Z'),
};

describe('buildDiagnosticsSnapshot', () => {
  it('produces the expected top-level shape from a fixture session', () => {
    const snap = buildDiagnosticsSnapshot(baseInput);
    expect(snap.capturedAt).toBe('2026-05-16T12:00:00.000Z');
    expect(snap.harness).toEqual({
      driverKey: 'letratag',
      harnessVersion: '0.1.0',
      driverVersion: '0.4.2',
    });
    expect(snap.mocked).toBe(false);
    expect(snap.device).toEqual({ advertisedName: 'LetraTag 200B', vid: 0x0922, pid: 0x1234 });
    expect(snap.engines).toHaveLength(1);
    expect(snap.engines[0]!.role).toBe('tape');
  });

  it('serialises rawBytes as a hex string, not a Uint8Array', () => {
    const snap = buildDiagnosticsSnapshot(baseInput);
    const engineStatus = snap.engines[0]!.status!;
    expect(engineStatus.rawBytes).toBe('0fa000ff');
    expect(typeof engineStatus.rawBytes).toBe('string');
    // The hex string must survive a JSON round-trip intact (a Uint8Array
    // stringifies to an unreadable keyed object).
    const round = JSON.parse(JSON.stringify(snap)) as DiagnosticsSnapshot; // eslint-disable-line unicorn/prefer-structured-clone -- exercising the JSON path the renderer uses
    expect(round.engines[0]!.status!.rawBytes).toBe('0fa000ff');
  });

  it('passes the rest of PrinterStatus through unchanged', () => {
    const snap = buildDiagnosticsSnapshot(baseInput);
    const engineStatus = snap.engines[0]!.status!;
    expect(engineStatus.ready).toBe(true);
    expect(engineStatus.mediaLoaded).toBe(true);
    expect(engineStatus.errors).toEqual([]);
  });

  it('projects detected media down to the narrow snapshot shape', () => {
    const snap = buildDiagnosticsSnapshot(baseInput);
    expect(snap.engines[0]!.detectedMedia).toEqual({
      id: 'd1-12-bw',
      name: 'D1 12mm black-on-white',
      widthMm: 12,
      type: 'tape',
    });
    // Driver-specific superset fields must not leak through.
    expect(snap.engines[0]!.detectedMedia).not.toHaveProperty('cornerRadiusMm');
  });

  it('keeps heightMm when the detected media is fixed-length', () => {
    const dieCut: PrinterStatus = {
      ...status,
      detectedMedia: { id: 5, name: '32x57', widthMm: 32, heightMm: 57, type: 'die-cut' },
    };
    const snap = buildDiagnosticsSnapshot({
      ...baseInput,
      engines: [{ role: 'label', status: dieCut }],
    });
    expect(snap.engines[0]!.detectedMedia).toEqual({
      id: 5,
      name: '32x57',
      widthMm: 32,
      heightMm: 57,
      type: 'die-cut',
    });
  });

  it('emits null status + media for an engine that has not been polled', () => {
    const snap = buildDiagnosticsSnapshot({
      ...baseInput,
      engines: [{ role: 'tape', status: null }],
    });
    expect(snap.engines[0]!.status).toBeNull();
    expect(snap.engines[0]!.detectedMedia).toBeNull();
  });

  it('emits null detectedMedia when the printer reports no media', () => {
    // LabelManager / LW-450 style printers have no media detection — the
    // `detectedMedia` field is simply absent on their status.
    const noMedia: PrinterStatus = {
      ready: true,
      mediaLoaded: false,
      errors: [],
      rawBytes: new Uint8Array([0x00]),
    };
    const snap = buildDiagnosticsSnapshot({
      ...baseInput,
      engines: [{ role: 'tape', status: noMedia }],
    });
    expect(snap.engines[0]!.status).not.toBeNull();
    expect(snap.engines[0]!.detectedMedia).toBeNull();
  });

  it('carries the mocked flag through', () => {
    const snap = buildDiagnosticsSnapshot({ ...baseInput, mocked: true });
    expect(snap.mocked).toBe(true);
  });

  it('handles a multi-engine device with one entry per role', () => {
    const snap = buildDiagnosticsSnapshot({
      ...baseInput,
      engines: [
        { role: 'label', status },
        { role: 'tape', status: null },
      ],
    });
    expect(snap.engines.map(e => e.role)).toEqual(['label', 'tape']);
    expect(snap.engines[0]!.status).not.toBeNull();
    expect(snap.engines[1]!.status).toBeNull();
  });

  it('defaults capturedAt to now when no timestamp is supplied', () => {
    const before = Date.now();
    const withoutTimestamp: BuildDiagnosticsSnapshotInput = {
      driverKey: baseInput.driverKey,
      harnessVersion: baseInput.harnessVersion,
      driverVersion: baseInput.driverVersion,
      mocked: baseInput.mocked,
      device: baseInput.device,
      engines: baseInput.engines,
    };
    const snap = buildDiagnosticsSnapshot(withoutTimestamp);
    const captured = new Date(snap.capturedAt).getTime();
    expect(captured).toBeGreaterThanOrEqual(before);
    expect(captured).toBeLessThanOrEqual(Date.now());
  });
});

describe('renderDiagnosticsBlock', () => {
  it('wraps the snapshot in a valid ```json fence', () => {
    const snap = buildDiagnosticsSnapshot(baseInput);
    const out = renderDiagnosticsBlock(snap);
    expect(out.startsWith('```json\n')).toBe(true);
    expect(out.endsWith('\n```')).toBe(true);
  });

  it('produces a fence whose body parses back to the snapshot', () => {
    const snap = buildDiagnosticsSnapshot(baseInput);
    const out = renderDiagnosticsBlock(snap);
    const match = /```json\n([\s\S]*?)\n```/.exec(out);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]!) as DiagnosticsSnapshot;
    expect(parsed).toEqual(snap);
  });

  it('pretty-prints with two-space indentation', () => {
    const snap = buildDiagnosticsSnapshot(baseInput);
    const out = renderDiagnosticsBlock(snap);
    expect(out).toContain('\n  "capturedAt"');
  });
});
