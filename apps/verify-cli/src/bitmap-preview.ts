/**
 * Render a `LabelBitmap` as a terminal-friendly preview using Unicode
 * half-block characters: each output character represents one bitmap
 * column × two bitmap rows.
 *
 *   `█` — both halves filled
 *   `▀` — top filled
 *   `▄` — bottom filled
 *   ` ` — both empty
 *
 * The preview shows the bitmap exactly as it lays out on the bitmap
 * canvas; printer-side mirroring or tape orientation is the encoder's
 * concern and not reflected here.
 */
import { bytesPerRow, type LabelBitmap } from '@mbtech-nl/bitmap';

export function renderBitmapPreview(bitmap: LabelBitmap): string {
  const { widthPx, heightPx, data } = bitmap;
  const bpr = bytesPerRow(widthPx);
  const lines: string[] = [];
  lines.push(`Bitmap preview: ${String(widthPx)} × ${String(heightPx)} dots`);
  lines.push('');
  for (let y = 0; y < heightPx; y += 2) {
    let line = '';
    for (let x = 0; x < widthPx; x += 1) {
      const top = bitAt(data, bpr, x, y);
      const bot = y + 1 < heightPx ? bitAt(data, bpr, x, y + 1) : 0;
      if (top && bot) line += '█';
      else if (top) line += '▀';
      else if (bot) line += '▄';
      else line += ' ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function bitAt(data: Uint8Array, bpr: number, x: number, y: number): number {
  const byteIdx = y * bpr + (x >> 3);
  return ((data[byteIdx] ?? 0) >> (7 - (x & 7))) & 1;
}
