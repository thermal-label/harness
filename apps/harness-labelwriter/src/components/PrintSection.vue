<script setup lang="ts">
/**
 * Print-the-diagnostic section.
 *
 * Builds the bitmap via the harness multi-engine dispatch
 * (`@thermal-label/harness-core/labelwriter`), encodes to wire bytes,
 * pushes them out the active engine's transport. Disabled until media
 * is confirmed for the active engine.
 *
 * Multi-engine devices route into the same component per tab; the
 * active engine's transport (`connection.transports[role]`) and media
 * (`activeSession.media`) feed the dispatch helper, which picks
 * lw-450/550 or d1-tape encoder pairs and prepends the Twin
 * roll-select prefix when applicable.
 */
import { computed, ref } from 'vue';
import { dispatchEncoder } from '@thermal-label/harness-core/labelwriter';
import { activeSession, connection, device } from '../state/session';
import { writeDiagnosticPrint } from '../transport/connect';
import { HARNESS_VERSION, DRIVER_VERSION } from '../version';
import BitmapPreview from './BitmapPreview.vue';
import SectionCard from './SectionCard.vue';

const sectionState = computed<'pending' | 'active' | 'done'>(() => {
  const s = activeSession.value;
  if (!s || s.media === null) return 'pending';
  if (!s.printed) return 'active';
  return 'done';
});

const printing = ref(false);
const lastError = ref<string | null>(null);
const lastByteCount = ref(0);
const lastBytesPreview = ref<string>('');

/**
 * Reactive diagnostic bitmap pair, recomputed whenever device or
 * media changes. Authored bitmap is shown as a small canvas thumbnail
 * with dead-zone overlays so the operator can compare what we
 * intended to send against what physically came out of the printer.
 */
const previewResult = computed(() => {
  const session = activeSession.value;
  const dev = device.value;
  if (!session || !session.media || !dev) return null;
  try {
    const dispatched = dispatchEncoder({
      device: dev,
      engine: session.engine,
      media: session.media,
      harnessVersion: HARNESS_VERSION,
      driverVersion: DRIVER_VERSION,
    });
    return dispatched.buildBitmap();
  } catch {
    return null;
  }
});

async function doPrint(): Promise<void> {
  const session = activeSession.value;
  const dev = device.value;
  if (!session || !session.media || !dev) return;
  const transport = connection.transports[session.engine.role];
  if (!transport) {
    lastError.value =
      `No transport open for engine "${session.engine.role}" — the browser refused to claim ` +
      `its USB interface at connect time. Disconnect and reconnect to retry.`;
    return;
  }
  lastError.value = null;
  printing.value = true;
  try {
    // The dispatch helper picks the right encoder pair per
    // `engine.protocol` and prepends Twin's `ESC q <addr>` prefix
    // when applicable.
    const dispatched = dispatchEncoder({
      device: dev,
      engine: session.engine,
      media: session.media,
      harnessVersion: HARNESS_VERSION,
      driverVersion: DRIVER_VERSION,
    });
    const result = dispatched.buildBitmap();
    // Send the WIRE bitmap — that's the head-sized composition that
    // the printer expects. The authored bitmap is for the preview
    // canvas only.
    const bytes = dispatched.encodeBitmap(result.wire, result.authored.heightPx);
    lastByteCount.value = bytes.byteLength;
    lastBytesPreview.value = formatHexPreview(bytes);
    await writeDiagnosticPrint(transport, bytes);
    session.printed = true;
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

const hasMedia = computed(() => Boolean(activeSession.value?.media));
const hasPrinted = computed(() => Boolean(activeSession.value?.printed));
</script>

<template>
  <SectionCard :step="3" title="Print the diagnostic" :state="sectionState">
    <p v-if="!hasMedia" class="muted">
      Pick a label first — the bitmap dimensions come from there.
    </p>

    <template v-else>
      <p>
        We send one comprehensive print: identifying header, asymmetric orientation markers, edge
        probes, sample text at two scales, a fill region, and a trailing-edge probe. One photo of
        the printed label answers most of the diagnostic questions.
      </p>

      <div class="preview-row">
        <BitmapPreview
          :bitmap="previewResult?.authored ?? null"
          :printable-area="previewResult?.printableArea ?? null"
          :forced-trailing-feed-mm="previewResult?.forcedTrailingFeedMm ?? 0"
          :dpi="300"
        />
        <p class="muted small preview-hint">
          This is what we're about to send. Click to zoom. Striped bands show the dead-zone regions
          your printer can't reach (top, bottom, sides) plus any forced trailing feed below the
          bitmap.
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

    <template v-if="hasMedia" #advanced>
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
