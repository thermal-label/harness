import { describe, expect, it } from 'vitest';
import type { PrinterStatus } from '@thermal-label/contracts';
import { serializeStatus, toHex, type SerializedStatus } from '../serialize-status.js';

const status: PrinterStatus = {
  ready: true,
  mediaLoaded: true,
  detectedMedia: { id: 'sku-30252', name: '30252', widthMm: 28, heightMm: 89, type: 'die-cut' },
  errors: [],
  rawBytes: new Uint8Array([0x0f, 0xa0, 0x00, 0xff]),
  details: [
    { label: 'Print status', value: 'idle (0)', severity: 'info' },
    { label: 'Head voltage', value: 'low (2)', severity: 'warn' },
  ],
};

describe('toHex', () => {
  it('produces lowercase unspaced hex with zero-padding', () => {
    expect(toHex(new Uint8Array([0x0f, 0xa0, 0x00, 0xff]))).toBe('0fa000ff');
  });

  it('returns an empty string for an empty buffer', () => {
    expect(toHex(new Uint8Array(0))).toBe('');
  });
});

describe('serializeStatus', () => {
  it('converts rawBytes to an unspaced hex string', () => {
    const out = serializeStatus(status);
    expect(out.rawBytes).toBe('0fa000ff');
    expect(typeof out.rawBytes).toBe('string');
  });

  it('passes every other PrinterStatus field through unchanged', () => {
    const out = serializeStatus(status);
    expect(out.ready).toBe(true);
    expect(out.mediaLoaded).toBe(true);
    expect(out.errors).toEqual([]);
    expect(out.detectedMedia).toEqual(status.detectedMedia);
    expect(out.details).toEqual(status.details);
  });

  it('survives a JSON round-trip intact (a Uint8Array would not)', () => {
    const out = serializeStatus(status);
    const round = JSON.parse(JSON.stringify(out)) as SerializedStatus; // eslint-disable-line unicorn/prefer-structured-clone -- exercising the JSON path
    expect(round.rawBytes).toBe('0fa000ff');
    expect(round.details).toEqual(status.details);
  });

  it('handles a status with no detectedMedia and no details', () => {
    const bare: PrinterStatus = {
      ready: false,
      mediaLoaded: false,
      errors: [{ code: 'no_media', message: 'No media' }],
      rawBytes: new Uint8Array([0x00]),
    };
    const out = serializeStatus(bare);
    expect(out.rawBytes).toBe('00');
    expect(out.detectedMedia).toBeUndefined();
    expect(out.details).toBeUndefined();
    expect(out.errors).toEqual([{ code: 'no_media', message: 'No media' }]);
  });
});
