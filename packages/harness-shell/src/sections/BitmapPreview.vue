<script setup lang="ts">
/**
 * "What's about to be printed" canvas. Renders a `PreviewResult`
 * (`@thermal-label/contracts`) — one or more 1bpp planes with display
 * colours — into a `<canvas>`. The driver does the colour splitting
 * (`createPreview` runs the same code path `print()` uses
 * internally), so two-colour rolls (DK-22251 etc.) light up red where
 * red would print, single-colour stays black-on-white.
 *
 * CSS scales the displayed size; click toggles thumbnail vs expanded.
 * Default thumbnail is ~80 px wide so it doesn't dominate the page;
 * expanded view caps at 320 px wide × 80 vh tall and keeps pixels
 * crisp via `image-rendering: pixelated`.
 *
 * `assumed: true` from the driver (no detected media + no override)
 * surfaces an inline notice — operators should pick a media entry to
 * get a faithful preview.
 */
import { computed, onMounted, ref, watch } from 'vue';
import type { PreviewResult } from '@thermal-label/contracts';

const props = defineProps<{ preview: PreviewResult | null }>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const expanded = ref(false);

const dimensionsLabel = computed(() => {
  const first = props.preview?.planes[0];
  return first ? `${first.bitmap.widthPx}×${first.bitmap.heightPx} dots` : '';
});

const planesLabel = computed(() => {
  const planes = props.preview?.planes ?? [];
  if (planes.length <= 1) return null;
  return `${String(planes.length)} planes: ${planes.map(p => p.name).join(' + ')}`;
});

function parseColor(css: string): { r: number; g: number; b: number } {
  // Minimal #rrggbb / #rgb parser — drivers emit hex display colours.
  // Falls back to black on anything we don't recognise.
  if (css.startsWith('#')) {
    if (css.length === 7) {
      return {
        r: parseInt(css.slice(1, 3), 16),
        g: parseInt(css.slice(3, 5), 16),
        b: parseInt(css.slice(5, 7), 16),
      };
    }
    if (css.length === 4) {
      const c1 = css[1] ?? '0';
      const c2 = css[2] ?? '0';
      const c3 = css[3] ?? '0';
      const r = parseInt(c1 + c1, 16);
      const g = parseInt(c2 + c2, 16);
      const b = parseInt(c3 + c3, 16);
      return { r, g, b };
    }
  }
  return { r: 0, g: 0, b: 0 };
}

/**
 * Composite every plane onto the canvas. Black plane goes down first;
 * subsequent planes (red on two-color rolls) overlay using their
 * display colour.
 */
function draw(): void {
  const preview = props.preview;
  const canvas = canvasRef.value;
  if (!preview || !canvas || preview.planes.length === 0) {
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        canvas.width = 1;
        canvas.height = 1;
        ctx.clearRect(0, 0, 1, 1);
      }
    }
    return;
  }
  const widthPx = preview.planes[0]!.bitmap.widthPx;
  const heightPx = preview.planes[0]!.bitmap.heightPx;
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Start with white background.
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, widthPx, heightPx);

  const img = ctx.getImageData(0, 0, widthPx, heightPx);

  for (const plane of preview.planes) {
    const bitmap = plane.bitmap;
    const color = parseColor(plane.displayColor);
    const bpr = Math.ceil(bitmap.widthPx / 8);
    const w = Math.min(widthPx, bitmap.widthPx);
    const h = Math.min(heightPx, bitmap.heightPx);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const byte = bitmap.data[y * bpr + (x >> 3)] ?? 0;
        const bit = (byte >> (7 - (x & 7))) & 1;
        if (bit !== 1) continue;
        const idx = (y * widthPx + x) * 4;
        img.data[idx] = color.r;
        img.data[idx + 1] = color.g;
        img.data[idx + 2] = color.b;
        img.data[idx + 3] = 255;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

onMounted(draw);
// `flush: 'post'` so draw runs AFTER the DOM update — the canvas only
// mounts once `v-if="preview"` becomes truthy. Default 'pre' flushed
// the watcher before the canvas existed, leaving the figure blank.
watch(() => props.preview, draw, { deep: true, flush: 'post' });
</script>

<template>
  <figure
    v-if="preview && preview.planes.length > 0"
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
      <span v-if="planesLabel" class="planes-label">{{ planesLabel }}</span>
      <span v-if="preview.assumed" class="assumed">
        Preview is assumed media — connect a printer or pick a media entry for an accurate
        rendering.
      </span>
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

.planes-label,
.assumed {
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
