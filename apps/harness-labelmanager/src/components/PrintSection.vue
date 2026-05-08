<script setup lang="ts">
/**
 * Print-the-diagnostic section.
 *
 * Builds the bitmap via the shared encoder
 * (`@thermal-label/harness-core/labelmanager`), encodes to wire bytes,
 * pushes them out the active transport. Disabled until tape width is
 * confirmed. After a successful write, exposes the byte count and
 * "print again" affordance — operators sometimes want a second copy
 * before assessing.
 *
 * The Advanced drawer surfaces the wire-byte length + a few hex
 * preview lines for triage.
 */
import { computed, ref } from 'vue';
import { buildDiagnosticBitmap, encodeBitmap } from '@thermal-label/harness-core/labelmanager';
import { connection, device, hasTape, hasPrinted, submitState, tapeWidth } from '../state/session';
import { writeDiagnosticPrint } from '../transport/connect';
import { HARNESS_VERSION, DRIVER_VERSION } from '../version';
import BitmapPreview from './BitmapPreview.vue';
import SectionCard from './SectionCard.vue';

const sectionState = computed<'pending' | 'active' | 'done'>(() => {
  if (!hasTape.value) return 'pending';
  if (!hasPrinted.value) return 'active';
  return 'done';
});

const printing = ref(false);
const lastError = ref<string | null>(null);
const lastByteCount = ref(0);
const lastBytesPreview = ref<string>('');

const enginePrimary = computed(() => device.value?.engines[0] ?? null);

const previewDpi = computed(() => enginePrimary.value?.dpi ?? 180);

/**
 * Reactive diagnostic bitmap pair, recomputed whenever device or tape
 * width changes. Authored bitmap is shown as a small canvas thumbnail
 * with dead-zone overlays so the operator can compare what we
 * intended to send against what physically came out of the printer.
 * Encoder is a pure function of (device, tapeWidth, version strings)
 * — the preview matches the bytes sent on the next print exactly.
 */
const previewResult = computed(() => {
  if (!device.value) return null;
  try {
    return buildDiagnosticBitmap({
      device: device.value,
      tapeWidth: tapeWidth.value,
      harnessVersion: HARNESS_VERSION,
      driverVersion: DRIVER_VERSION,
    });
  } catch {
    return null;
  }
});

async function doPrint(): Promise<void> {
  if (!device.value || !connection.transport || !enginePrimary.value) return;
  lastError.value = null;
  printing.value = true;
  try {
    const result = buildDiagnosticBitmap({
      device: device.value,
      tapeWidth: tapeWidth.value,
      harnessVersion: HARNESS_VERSION,
      driverVersion: DRIVER_VERSION,
    });
    // Pass `result.wire` — for labelmanager `wire === authored`, the
    // driver-core encoder pads top/bottom itself based on the
    // engine's `printableArea` / `forcedTrailingFeedMm` registry
    // values.
    const bytes = encodeBitmap(result.wire, enginePrimary.value, tapeWidth.value);
    lastByteCount.value = bytes.byteLength;
    lastBytesPreview.value = formatHexPreview(bytes);
    await writeDiagnosticPrint(connection.transport, bytes);
    submitState.printed = true;
  } catch (err) {
    lastError.value = err instanceof Error ? err.message : String(err);
  } finally {
    printing.value = false;
  }
}

function formatHexPreview(bytes: Uint8Array): string {
  const lines: string[] = [];
  const lineLen = 16;
  const maxLines = 4;
  for (let i = 0; i < Math.min(bytes.byteLength, lineLen * maxLines); i += lineLen) {
    const slice = bytes.subarray(i, Math.min(bytes.byteLength, i + lineLen));
    const offset = i.toString(16).padStart(6, '0');
    const hex = Array.from(slice)
      .map(b => b.toString(16).padStart(2, '0'))
      .join(' ');
    lines.push(`${offset}  ${hex}`);
  }
  if (bytes.byteLength > lineLen * maxLines) {
    lines.push(`…  (${(bytes.byteLength - lineLen * maxLines).toString()} more bytes)`);
  }
  return lines.join('\n');
}
</script>

<template>
  <SectionCard :step="4" title="Print the diagnostic" :state="sectionState">
    <p v-if="!hasTape" class="muted">
      Pick the tape width first — the bitmap dimensions come from there.
    </p>

    <template v-else>
      <p>
        We send one comprehensive print: identifying header, asymmetric orientation markers, edge
        probes, sample text at two scales, and a fill region. One photo of the printed strip answers
        most of the diagnostic questions.
      </p>

      <div class="preview-row">
        <BitmapPreview
          :bitmap="previewResult?.authored ?? null"
          :printable-area="previewResult?.printableArea ?? null"
          :forced-trailing-feed-mm="previewResult?.forcedTrailingFeedMm ?? 0"
          :dpi="previewDpi"
        />
        <p class="muted small preview-hint">
          This is what we're about to send. Click to zoom. Striped bands show the dead-zone regions
          your printer can't reach (top, bottom) plus the forced trailing feed below the bitmap.
        </p>
      </div>

      <div class="actions">
        <button class="primary" :disabled="printing" type="button" @click="doPrint">
          {{ printing ? 'Sending…' : hasPrinted ? 'Print again' : 'Print diagnostic' }}
        </button>
        <span v-if="hasPrinted && !printing" class="ok-tag">
          Sent {{ lastByteCount.toLocaleString() }} bytes
        </span>
      </div>

      <p v-if="hasPrinted && !lastError" class="muted small">
        Take a quick look at what came out — you'll need it for the next section. Snap a photo if
        you want; you'll have a chance to drop it into the GitHub issue after submit.
      </p>

      <p v-if="lastError" class="error">
        {{ lastError }}
      </p>
    </template>

    <template v-if="hasTape" #advanced>
      <p class="muted small">
        Last encoded payload: <strong>{{ lastByteCount.toLocaleString() }}</strong> bytes.
      </p>
      <pre v-if="lastBytesPreview">{{ lastBytesPreview }}</pre>
      <p v-else class="muted small">(Print once to see the byte preview here.)</p>
    </template>
  </SectionCard>
</template>

<style scoped>
.preview-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  margin-top: var(--space-3);
  flex-wrap: wrap;
}

.preview-hint {
  flex: 1;
  min-width: 12rem;
  margin: 0;
}

.actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.primary {
  background: var(--accent);
  color: var(--accent-fg);
  border: none;
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-5);
  font-weight: 600;
  font-size: 0.95rem;
}

.primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.ok-tag {
  font-size: 0.85rem;
  color: var(--ok);
  background: var(--ok-bg);
  padding: 0.15rem 0.5rem;
  border-radius: var(--radius-sm);
}

.small {
  font-size: 0.85rem;
}

.error {
  background: var(--error-bg);
  color: var(--error);
  border: 1px solid var(--error);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  margin-top: var(--space-3);
  font-size: 0.92rem;
}

pre {
  font-size: 0.78rem;
  white-space: pre;
  overflow-x: auto;
}
</style>
