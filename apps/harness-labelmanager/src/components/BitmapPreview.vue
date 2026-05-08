<script setup lang="ts">
/**
 * Small "what's about to be printed" canvas. Renders a 1-bit
 * `LabelBitmap` at native resolution into a `<canvas>`; CSS scales
 * the displayed size. Click toggles between thumbnail and an
 * expanded view so the operator can compare bitmap → physical
 * output without leaving the section.
 *
 * Default thumbnail is ~80 px wide so it doesn't dominate the page;
 * expanded view caps at 320 px wide × 80 vh tall and keeps pixels
 * crisp via `image-rendering: pixelated`.
 *
 * **Dead-zone overlays (plan 08 §7).** When `printableArea` is
 * non-zero, four diagonal-stripe rectangles sit on top of the
 * bitmap covering the leading / trailing / left / right dead-zone
 * edges. The post-print trailing feed is intentionally not
 * visualised here — on labelmanager it advances the next strip's
 * leading whitespace (centring math), not the current strip, so
 * showing it inside this canvas would misrepresent what comes off
 * the cutter.
 *
 * Edge case: when no engine / media is resolved, `printableArea`
 * is `null` and no overlays render — same as today's behaviour.
 */
import { computed, onMounted, ref, watch } from 'vue';
import type { LabelBitmap } from '@mbtech-nl/bitmap';
import type { PrintableArea } from '@thermal-label/contracts';

const props = withDefaults(
  defineProps<{
    bitmap: LabelBitmap | null;
    printableArea?: PrintableArea | null;
    dpi?: number;
  }>(),
  { printableArea: null, dpi: 300 },
);

const canvasRef = ref<HTMLCanvasElement | null>(null);
const expanded = ref(false);

const dimensionsLabel = computed(() =>
  props.bitmap ? `${props.bitmap.widthPx}×${props.bitmap.heightPx} dots` : '',
);

function mmToDots(mm: number): number {
  return Math.round((mm * props.dpi) / 25.4);
}

const overlayDots = computed(() => {
  const area = props.printableArea;
  return {
    leading: area ? mmToDots(area.leading) : 0,
    trailing: area ? mmToDots(area.trailing) : 0,
    left: area ? mmToDots(area.left) : 0,
    right: area ? mmToDots(area.right) : 0,
  };
});

const hasOverlay = computed(() => {
  const o = overlayDots.value;
  return o.leading > 0 || o.trailing > 0 || o.left > 0 || o.right > 0;
});

const overlayCaption = computed(() => {
  if (!hasOverlay.value) return null;
  const area = props.printableArea;
  const parts: string[] = [];
  if (area && (area.leading > 0 || area.trailing > 0)) {
    parts.push(
      `top ${String(area.leading)}mm / bottom ${String(area.trailing)}mm unprintable (head reach)`,
    );
  }
  if (area && (area.left > 0 || area.right > 0)) {
    parts.push(`left ${String(area.left)}mm / right ${String(area.right)}mm unprintable`);
  }
  return parts.join('; ') + '.';
});

/**
 * Draw the 1-bit bitmap. Canvas matches the bitmap dimensions
 * exactly — the post-print trailing feed isn't visualised here
 * (it advances the next strip's leading whitespace, not this one's).
 */
function draw(): void {
  const bitmap = props.bitmap;
  const canvas = canvasRef.value;
  if (!bitmap || !canvas) return;
  canvas.width = bitmap.widthPx;
  canvas.height = bitmap.heightPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Bitmap → 1-bit white/black.
  const img = ctx.createImageData(bitmap.widthPx, bitmap.heightPx);
  const bpr = Math.ceil(bitmap.widthPx / 8);
  for (let y = 0; y < bitmap.heightPx; y += 1) {
    for (let x = 0; x < bitmap.widthPx; x += 1) {
      const byte = bitmap.data[y * bpr + (x >> 3)] ?? 0;
      const bit = (byte >> (7 - (x & 7))) & 1;
      const idx = (y * bitmap.widthPx + x) * 4;
      const v = bit === 1 ? 0 : 255;
      img.data[idx] = v;
      img.data[idx + 1] = v;
      img.data[idx + 2] = v;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Diagonal-stripe overlays for the four dead-zone edges. Drawn
  // semi-transparently so the user can still see what they authored
  // in the dead zone.
  if (hasOverlay.value) {
    drawStripedOverlays(ctx, bitmap.widthPx, bitmap.heightPx);
  }
}

function drawStripedOverlays(
  ctx: CanvasRenderingContext2D,
  widthPx: number,
  bitmapHeight: number,
): void {
  const o = overlayDots.value;

  // Build the diagonal stripe pattern once and reuse for every rect.
  const patternCanvas = document.createElement('canvas');
  patternCanvas.width = 8;
  patternCanvas.height = 8;
  const pctx = patternCanvas.getContext('2d');
  if (!pctx) return;
  pctx.fillStyle = 'rgba(0, 0, 0, 0)';
  pctx.fillRect(0, 0, 8, 8);
  pctx.strokeStyle = 'rgba(110, 110, 110, 0.55)';
  pctx.lineWidth = 1.5;
  pctx.beginPath();
  pctx.moveTo(0, 8);
  pctx.lineTo(8, 0);
  pctx.moveTo(-2, 2);
  pctx.lineTo(2, -2);
  pctx.moveTo(6, 10);
  pctx.lineTo(10, 6);
  pctx.stroke();
  const pattern = ctx.createPattern(patternCanvas, 'repeat');
  if (!pattern) return;

  ctx.save();
  ctx.fillStyle = pattern;

  // Leading band.
  if (o.leading > 0) {
    ctx.fillRect(0, 0, widthPx, Math.min(o.leading, bitmapHeight));
  }
  // Trailing band.
  if (o.trailing > 0) {
    const top = Math.max(0, bitmapHeight - o.trailing);
    ctx.fillRect(0, top, widthPx, bitmapHeight - top);
  }
  // Left band.
  if (o.left > 0) {
    ctx.fillRect(0, 0, Math.min(o.left, widthPx), bitmapHeight);
  }
  // Right band.
  if (o.right > 0) {
    const left = Math.max(0, widthPx - o.right);
    ctx.fillRect(left, 0, widthPx - left, bitmapHeight);
  }
  ctx.restore();
}

onMounted(draw);
watch(() => [props.bitmap, props.printableArea] as const, draw, { deep: true });
</script>

<template>
  <figure
    v-if="bitmap"
    class="preview"
    :class="{ expanded }"
    role="button"
    tabindex="0"
    :title="expanded ? 'Click to shrink' : 'Click to zoom'"
    @click="expanded = !expanded"
    @keydown.enter.prevent="expanded = !expanded"
    @keydown.space.prevent="expanded = !expanded"
  >
    <canvas ref="canvasRef" class="canvas" />
    <figcaption class="caption">
      {{ dimensionsLabel }}<span class="hint"> · click to {{ expanded ? 'shrink' : 'zoom' }}</span>
      <span v-if="overlayCaption" class="overlay-caption">{{ overlayCaption }}</span>
    </figcaption>
  </figure>
</template>

<style scoped>
.preview {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2);
  background: var(--bg-elevated, var(--bg));
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: zoom-in;
  user-select: none;
  transition: max-width 0.15s ease;
}

.preview.expanded {
  cursor: zoom-out;
}

.canvas {
  display: block;
  max-width: 80px;
  max-height: 240px;
  width: auto;
  height: auto;
  background: white;
  border: 1px solid var(--border);
  /* Keep 1-bit pixels crisp instead of bilinear-blurring them. */
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}

.preview.expanded .canvas {
  max-width: min(320px, 80vw);
  max-height: 80vh;
}

.caption {
  font-size: 0.75rem;
  color: var(--muted);
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.hint {
  opacity: 0.7;
}

.overlay-caption {
  font-size: 0.7rem;
  color: var(--muted);
  max-width: 28ch;
  line-height: 1.3;
}

.preview:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
