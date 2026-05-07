/**
 * Minimal 1-bit PNG encoder for `LabelBitmap`. No deps beyond `node:zlib`
 * (deflate) — the on-wire format is small enough that a hand-rolled
 * encoder beats pulling in `pngjs` for what we need.
 *
 * Output: greyscale colour-type-0 PNG at bit depth 1. Set bits in the
 * source bitmap (= "printed dot") render as black; clear bits render
 * as white.
 *
 * `scale` upsamples each source dot to an N×N block in the PNG — handy
 * because a 64×228 dot raster is a thumbnail in most image viewers.
 * Default 4× gives a comfortable 256×912 PNG for the labelmanager
 * 12 mm diagnostic.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesPerRow, type LabelBitmap } from '@mbtech-nl/bitmap';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) {
    const tableEntry = CRC_TABLE[(c ^ byte) & 0xff] ?? 0;
    c = (tableEntry ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, payload: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, payload])), 0);
  return Buffer.concat([length, typeBuf, payload, crc]);
}

export function encodeBitmapAsPng(bitmap: LabelBitmap, scale = 4): Buffer {
  const { widthPx, heightPx, data } = bitmap;
  const bpr = bytesPerRow(widthPx);
  const outWidth = widthPx * scale;
  const outHeight = heightPx * scale;
  const outBpr = Math.ceil(outWidth / 8);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(outWidth, 0);
  ihdr.writeUInt32BE(outHeight, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Build raw scanlines: each row is `outBpr` packed bytes preceded by
  // a filter byte (0 = no filter). PNG greyscale-1 has 0 = black, 1 =
  // white, so we invert the source bitmap (set bit = printed = black).
  const scanlines = Buffer.alloc(outHeight * (1 + outBpr));
  const oneRow = Buffer.alloc(outBpr);
  for (let sy = 0; sy < heightPx; sy += 1) {
    oneRow.fill(0);
    for (let sx = 0; sx < widthPx; sx += 1) {
      const srcByte = data[sy * bpr + (sx >> 3)] ?? 0;
      const srcBit = (srcByte >> (7 - (sx & 7))) & 1;
      // PNG greyscale: 0 = black; we want set bits to be black, so
      // *clear* bits = set in the source means clear in the scaled
      // PNG byte (clear = 0 = black). Done by NOT setting, since the
      // row buffer is pre-cleared; but we still need to set bits for
      // unprinted source dots so they render as white (1).
      const pngBitsForThisDot = srcBit === 1 ? 0 : 1;
      if (pngBitsForThisDot === 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const ox = sx * scale + dx;
          const idx = ox >> 3;
          oneRow[idx] = (oneRow[idx] ?? 0) | (1 << (7 - (ox & 7)));
        }
      }
    }
    for (let dy = 0; dy < scale; dy += 1) {
      const base = (sy * scale + dy) * (1 + outBpr);
      scanlines[base] = 0;
      oneRow.copy(scanlines, base + 1);
    }
  }

  const idat = deflateSync(scanlines);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function writeBitmapPngToTmp(bitmap: LabelBitmap, prefix = 'verify-diag'): string {
  const png = encodeBitmapAsPng(bitmap);
  const path = join(tmpdir(), `${prefix}-${String(Date.now())}.png`);
  writeFileSync(path, png);
  return path;
}
