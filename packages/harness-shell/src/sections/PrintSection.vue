<script setup lang="ts">
/**
 * Print-the-diagnostic section. Generic over the adapter's
 * diagnostic-image builder.
 *
 * Post-harness-v2: builds an RGBA image via
 * `adapter.buildDiagnosticImage(...)`, hands it to
 * `printer.print(rgba, media)`. The driver's render pipeline
 * (threshold/dither, palette splitting, head-aligned framing)
 * runs end-to-end — that's the whole point: the harness is a
 * *driver fidelity test*, so it must go through the driver.
 *
 * The bitmap preview (the "what's about to be printed" canvas)
 * uses `printer.createPreview(rgba, { media })` so the operator
 * sees the same separated planes the driver would produce on
 * the wire.
 *
 * Reads + writes the active engine's session slot — single-engine
 * devices have one session; multi-engine devices route into this
 * same component per tab.
 */
import { computed, ref, watchEffect } from 'vue';
import type { PreviewResult, RawImageData } from '@thermal-label/contracts';
import { useAdapter } from '../state/adapterContext';
import { useSession } from '../state/session';
import BitmapPreview from './BitmapPreview.vue';
import SectionCard from './SectionCard.vue';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = useAdapter<any, any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const session = useSession<any, any>();

const sectionState = computed<'pending' | 'active' | 'done'>(() => {
  const s = session.activeSession.value;
  if (!s || s.media === null) return 'pending';
  if (!s.printed) return 'active';
  return 'done';
});

const printing = ref(false);
const lastError = ref<string | null>(null);

const diagnosticImage = computed<RawImageData | null>(() => {
  const slot = session.activeSession.value;
  const dev = session.device.value;
  if (!slot || !slot.media || !dev) return null;
  try {
    return adapter.buildDiagnosticImage({
      device: dev,
      engine: slot.engine,
      media: slot.media,
      harnessVersion: adapter.harnessVersion,
      driverVersion: adapter.driverVersion,
    });
  } catch (err) {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console -- dev-mode diagnostic
      console.warn('[harness] buildDiagnosticImage threw:', err);
    }
    return null;
  }
});

// Async preview via printer.createPreview() — driver's own colour
// splitting (single-plane / two-plane palette) drives the canvas.
const previewResult = ref<PreviewResult | null>(null);
const previewError = ref<string | null>(null);

watchEffect(async () => {
  const printer = session.activePrinter.value;
  const image = diagnosticImage.value;
  const slot = session.activeSession.value;
  if (!printer || !image || !slot?.media) {
    previewResult.value = null;
    return;
  }
  try {
    const result = await printer.createPreview(image, { media: slot.media });
    previewResult.value = result;
    previewError.value = null;
  } catch (err) {
    previewError.value = err instanceof Error ? err.message : String(err);
    previewResult.value = null;
  }
});

async function doPrint(): Promise<void> {
  const slot = session.activeSession.value;
  const dev = session.device.value;
  const printer = session.activePrinter.value;
  const image = diagnosticImage.value;
  if (!slot || !slot.media || !dev || !printer || !image) return;
  lastError.value = null;
  printing.value = true;

  // Pre-print status capture (plan 13 §E.2) — the load-bearing
  // "nothing happens" diagnostic. Best-effort: a status read that
  // throws must not block the print.
  try {
    slot.prePrintStatus = await printer.getStatus();
  } catch {
    slot.prePrintStatus = null;
  }

  try {
    // The active printer is per-engine; passing `engine: role` is
    // redundant for adapters that default to their own engine, but
    // harmless for adapters that share one transport across engines
    // (Twin Turbo: in-band ESC q routing on a single endpoint). Keep
    // it for clarity at the call site.
    await printer.print(image, slot.media, { engine: slot.engine.role });
    slot.printed = true;
  } catch (err) {
    lastError.value = err instanceof Error ? err.message : String(err);
  } finally {
    printing.value = false;
  }

  // Post-print status capture — runs whether the print resolved or
  // threw. Byte-0 sub-state + job-ID echo reveal whether the job was
  // accepted or silently dropped. A 550 may still report `printing`
  // here; that is itself diagnostic (the job WAS accepted).
  try {
    slot.postPrintStatus = await printer.getStatus();
  } catch {
    slot.postPrintStatus = null;
  }
}

const hasMedia = computed(() => Boolean(session.activeSession.value?.media));
const hasPrinted = computed(() => Boolean(session.activeSession.value?.printed));
</script>

<template>
  <SectionCard :step="3" title="Print the diagnostic" :state="sectionState">
    <p v-if="!hasMedia" class="muted">
      Pick what's loaded first — the bitmap dimensions come from there.
    </p>

    <template v-else>
      <p>
        We send one comprehensive print: identifying header, asymmetric orientation markers, edge
        probes, sample text at two scales, and a fill region. One photo of the printed strip answers
        most of the diagnostic questions.
      </p>

      <div class="preview-row">
        <BitmapPreview :preview="previewResult" />
        <p class="muted small preview-hint">
          This is what we're about to send. Click to zoom. The preview is generated by the driver
          itself — it shows exactly the pixels the head will fire.
        </p>
      </div>

      <p v-if="previewError" class="warn small">
        Preview unavailable: {{ previewError }}
      </p>

      <div class="actions">
        <button class="primary" :disabled="printing" type="button" @click="doPrint">
          {{ printing ? 'Sending…' : hasPrinted ? 'Print again' : 'Print diagnostic' }}
        </button>
      </div>

      <p v-if="hasPrinted && !lastError" class="muted small">
        Take a quick look — your verdict is the core of the report. Snap a photo if you can; you'll
        have a chance to attach it to the GitHub issue after submit.
      </p>

      <p v-if="lastError" class="error">
        {{ lastError }}
      </p>
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

.small {
  font-size: 0.85rem;
}

.warn {
  color: var(--warn);
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
</style>
