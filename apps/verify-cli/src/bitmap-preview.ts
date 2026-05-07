/**
 * Render a `LabelBitmap` as a terminal-friendly preview using Unicode
 * Braille patterns (`U+2800` … `U+28FF`). Each output character covers
 * a 2-column × 4-row tile of bitmap dots — full 8-dot precision per
 * char with no resolution loss.
 *
 * Why Braille and not half-blocks: half-blocks pack 1×2 dots/char, so
 * a 64×228 diagnostic bitmap renders as 64×114 characters — a column
 * that scrolls forever. Braille packs 2×4 dots/char, halving both
 * axes (32×57). Tradeoff: Braille glyphs look like braille rather
 * than a faithful raster, but they're crisp enough at typical
 * terminal sizes for sanity-checking layout.
 *
 * Braille bit layout (per Unicode standard) — bit indices map to
 * 2×4 grid positions:
 *
 *   col=0 col=1
 *   ┌────┬────┐
 *   │ 0  │ 3  │  row 0
 *   │ 1  │ 4  │  row 1
 *   │ 2  │ 5  │  row 2
 *   │ 6  │ 7  │  row 3
 *   └────┴────┘
 *
 * Codepoint = `U+2800 + bitmask`.
 */
import { bytesPerRow, type LabelBitmap } from '@mbtech-nl/bitmap';

const BRAILLE_BASE = 0x2800;

// Bitmask offsets for the 8 Braille dots at positions (dx, dy) inside
// a 2-col × 4-row tile.
const DOT_BITS: readonly { dx: 0 | 1; dy: 0 | 1 | 2 | 3; bit: number }[] = [
  { dx: 0, dy: 0, bit: 1 << 0 },
  { dx: 0, dy: 1, bit: 1 << 1 },
  { dx: 0, dy: 2, bit: 1 << 2 },
  { dx: 1, dy: 0, bit: 1 << 3 },
  { dx: 1, dy: 1, bit: 1 << 4 },
  { dx: 1, dy: 2, bit: 1 << 5 },
  { dx: 0, dy: 3, bit: 1 << 6 },
  { dx: 1, dy: 3, bit: 1 << 7 },
];

export function renderBitmapPreview(bitmap: LabelBitmap): string {
  const { widthPx, heightPx, data } = bitmap;
  const bpr = bytesPerRow(widthPx);
  const lines: string[] = [];
  lines.push(`Bitmap preview: ${String(widthPx)} × ${String(heightPx)} dots`);
  lines.push('');
  for (let cy = 0; cy < heightPx; cy += 4) {
    let line = '';
    for (let cx = 0; cx < widthPx; cx += 2) {
      let mask = 0;
      for (const { dx, dy, bit } of DOT_BITS) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < widthPx && y < heightPx && bitAt(data, bpr, x, y)) {
          mask |= bit;
        }
      }
      line += String.fromCharCode(BRAILLE_BASE + mask);
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function bitAt(data: Uint8Array, bpr: number, x: number, y: number): number {
  const byteIdx = y * bpr + (x >> 3);
  return ((data[byteIdx] ?? 0) >> (7 - (x & 7))) & 1;
}
