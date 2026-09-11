/**
 * The shim stands in for `node:zlib` in the browser bundle, so every
 * option `marklife-core` passes has to survive the substitution.
 *
 * `windowBits` is the one that bites: `yxqZlibCompress` asks for a
 * 1 KiB window because that is all the S2's inflate holds, and a shim
 * that drops it produces a 32 KiB-window stream the printer accepts,
 * feeds and never prints. It went unnoticed while the harness only
 * targeted `marklife-l11` chassis, whose encoder sends the raster
 * uncompressed and never reaches this code.
 *
 * `vitest.config.ts` declares no `node:zlib` alias, so the real
 * builtin is available here and the shim can be held to it exactly.
 */
import { deflateSync as nodeDeflate } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { deflateSync, inflateSync } from '../shims/node-zlib';

/** A raster that compresses — uniform rows back-reference heavily. */
function ditherRaster(bytesPerRow = 48, rows = 240): Uint8Array {
  const raw = new Uint8Array(bytesPerRow * rows);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = Math.floor(i / bytesPerRow) % 2 ? 0xaa : 0x55;
  }
  return raw;
}

/** Window size the zlib header advertises, in bits. */
const declaredWindowBits = (out: Uint8Array): number => ((out[0] ?? 0) >> 4 & 0x0f) + 8;

describe('node:zlib browser shim', () => {
  const vendorOptions = { level: 6, chunkSize: 16384, windowBits: 10 };

  it('forwards windowBits, keeping the YXQ stream inside a 1 KiB window', () => {
    const out = deflateSync(ditherRaster(), vendorOptions);
    expect(declaredWindowBits(out)).toBe(10);
    expect(out[0]).toBe(0x28);
  });

  it('matches node:zlib byte for byte on the options marklife-core passes', () => {
    const raster = ditherRaster();
    expect(deflateSync(raster, vendorOptions)).toEqual(
      new Uint8Array(nodeDeflate(raster, vendorOptions)),
    );
  });

  it('round-trips a compressed raster', () => {
    const raster = ditherRaster();
    expect(inflateSync(deflateSync(raster, vendorOptions))).toEqual(raster);
  });
});
