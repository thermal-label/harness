<script setup lang="ts">
/**
 * Print-the-diagnostic section. Generic over the adapter's
 * encoder + multi-engine dispatch.
 *
 * Builds the bitmap via `adapter.encoder.buildBitmap` (or the
 * per-engine encoder when `adapter.multiEngine.engineEncoder` is
 * supplied), encodes via `encodeBytes`, pushes via the active
 * engine's transport with the adapter's chunked-write parameters.
 *
 * Reads + writes the active engine's session slot — single-engine
 * devices have one session; multi-engine devices route into this
 * same component per tab.
 */
import { computed, ref } from 'vue';
import type { PrintEngine, Transport } from '@thermal-label/contracts';
import { useAdapter } from '../state/adapterContext';
import { useSession } from '../state/session';
import BitmapPreview from './BitmapPreview.vue';
import SectionCard from './SectionCard.vue';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = useAdapter<any, any, any>();
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
const lastByteCount = ref(0);
const lastBytesPreview = ref<string>('');

/**
 * Resolve which encoder to use for the active engine. Adapters with
 * `multiEngine.engineEncoder` swap encoders per engine (LW Duo's
 * lw-450 vs d1-tape); single-encoder adapters fall back to the
 * top-level `encoder`.
 */
function resolveEncoder(engine: PrintEngine | null) {
  if (engine && adapter.multiEngine?.engineEncoder) {
    return adapter.multiEngine.engineEncoder(engine);
  }
  return adapter.encoder;
}

const previewResult = computed(() => {
  const slot = session.activeSession.value;
  const dev = session.device.value;
  if (!slot || !slot.media || !dev) return null;
  const engine = slot.engine;
  try {
    const enc = resolveEncoder(engine);
    return enc.buildBitmap({
      device: dev,
      engine,
      media: slot.media,
      harnessVersion: adapter.harnessVersion,
      driverVersion: adapter.driverVersion,
    });
  } catch {
    return null;
  }
});

async function writeChunked(
  transport: Transport,
  bytes: Uint8Array,
  chunkSize: number,
  delayMs: number,
): Promise<void> {
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, bytes.length);
    await transport.write(bytes.subarray(offset, end));
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

async function doPrint(): Promise<void> {
  const slot = session.activeSession.value;
  const dev = session.device.value;
  if (!slot || !slot.media || !dev) return;
  const transport = session.connection.transports[slot.engine.role];
  if (!transport) {
    lastError.value =
      `No transport open for engine "${slot.engine.role}" — the browser refused to claim ` +
      `its USB interface at connect time. Disconnect and reconnect to retry.`;
    return;
  }
  lastError.value = null;
  printing.value = true;
  try {
    const enc = resolveEncoder(slot.engine);
    const result = enc.buildBitmap({
      device: dev,
      engine: slot.engine,
      media: slot.media,
      harnessVersion: adapter.harnessVersion,
      driverVersion: adapter.driverVersion,
    });
    // Send the WIRE bitmap — that's the head-sized composition the
    // printer expects. The authored bitmap is for the preview canvas
    // only.
    const bytes = enc.encodeBytes(
      result.wire,
      dev,
      slot.media,
      slot.engine,
      result.authored.heightPx,
    );
    lastByteCount.value = bytes.byteLength;
    lastBytesPreview.value = formatHexPreview(bytes);
    await writeChunked(transport, bytes, enc.chunkSize ?? 64, enc.chunkDelayMs ?? 5);
    slot.printed = true;
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

const hasMedia = computed(() => Boolean(session.activeSession.value?.media));
const hasPrinted = computed(() => Boolean(session.activeSession.value?.printed));

/**
 * Preview DPI — pulled from the active engine's registry entry so the
 * dead-zone overlay scales correctly. Driver-core engine shapes
 * declare `dpi`; we read it as `engine.dpi ?? 300` for safety.
 */
const previewDpi = computed(() => {
  const eng = session.activeEngine.value as { dpi?: number } | null;
  return eng?.dpi ?? 300;
});
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
        <BitmapPreview
          :bitmap="previewResult?.authored ?? null"
          :printable-area="previewResult?.printableArea ?? null"
          :forced-trailing-feed-mm="previewResult?.forcedTrailingFeedMm ?? 0"
          :dpi="previewDpi"
        />
        <p class="muted small preview-hint">
          This is what we're about to send. Click to zoom. Striped bands, when shown, mark the
          dead-zone regions the head can't reach (top, bottom, sides) plus any forced trailing feed
          below the bitmap.
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
