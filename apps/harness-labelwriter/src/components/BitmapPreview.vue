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
 */
import { computed, onMounted, ref, watch } from 'vue';
import type { LabelBitmap } from '@mbtech-nl/bitmap';

const props = defineProps<{ bitmap: LabelBitmap | null }>();

const canvasRef = ref<HTMLCanvasElement | null>(null);
const expanded = ref(false);

const dimensionsLabel = computed(() =>
  props.bitmap ? `${props.bitmap.widthPx}×${props.bitmap.heightPx} dots` : '',
);

function draw(): void {
  const bitmap = props.bitmap;
  const canvas = canvasRef.value;
  if (!bitmap || !canvas) return;
  canvas.width = bitmap.widthPx;
  canvas.height = bitmap.heightPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
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
}

onMounted(draw);
watch(() => props.bitmap, draw);
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
}

.hint {
  opacity: 0.7;
}

.preview:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
