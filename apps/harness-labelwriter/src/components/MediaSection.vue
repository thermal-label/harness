<script setup lang="ts">
/**
 * Media-picker section.
 *
 * Filters `MEDIA` to entries whose `targetModels` overlap with the
 * connected device's `engines[0].mediaCompatibility` — labelwriter
 * label media for label engines, D1 tape for the Duo's tape engine.
 *
 * LW 5xx: prefills from the SKU probe (`detectedSku` stash on
 * `connection.identity.extra`). LW 3xx/4xx: mandatory manual pick.
 *
 * Wi-Fi-only / TCP-only edge case: the browser cannot reach
 * TCP-9100. Callers should never reach this section for a TCP-only
 * model — the connect step would fail first — but the device
 * registry might list a model with TCP only. We surface a warning if
 * the chosen device declares no USB transport.
 */
import { computed, ref, watch } from 'vue';
import { MEDIA, type LabelWriterMedia } from '@thermal-label/labelwriter-core';
import { connection, device, hasIdentity, media, printerStatus } from '../state/session';
import StatusPill from '@thermal-label/harness-components/status-pill';
import SectionCard from './SectionCard.vue';

const sectionState = computed<'pending' | 'active' | 'done'>(() => {
  if (!hasIdentity.value) return 'pending';
  if (media.value === null) return 'active';
  return 'done';
});

/**
 * Paper-loaded pill in the section header. LW status carries
 * `mediaLoaded` (the no_media bit). Three states: unknown grey
 * before first poll lands; green when paper present; red when not.
 * Paper-jam counts as "loaded but unhappy" → warn.
 */
type DotState = 'unknown' | 'good' | 'warn' | 'bad';
const paperDot = computed<{ state: DotState; label: string }>(() => {
  const s = printerStatus.value;
  if (!s) return { state: 'unknown', label: 'Paper: checking…' };
  if (!s.mediaLoaded) return { state: 'bad', label: 'No paper loaded' };
  const jam = s.errors.some(e => e.code === 'paper_jam');
  return jam
    ? { state: 'warn', label: 'Paper loaded — jam reported' }
    : { state: 'good', label: 'Paper loaded' };
});

function isLabelMedia(m: unknown): m is LabelWriterMedia {
  if (typeof m !== 'object' || m === null) return false;
  const t = (m as { type?: string }).type;
  return t === 'die-cut' || t === 'continuous';
}

const allLabelMedia = computed(() => {
  return (Object.values(MEDIA) as readonly unknown[]).filter(isLabelMedia);
});

const compatibleMedia = computed(() => {
  if (!device.value) return [];
  const compat = device.value.engines[0]?.mediaCompatibility ?? [];
  return allLabelMedia.value.filter(m => {
    const targets = m.targetModels ?? [];
    return targets.some(t => compat.includes(t));
  });
});

const transportWarning = computed(() => {
  if (!device.value) return null;
  const usb = device.value.transports.usb;
  if (usb) return null;
  return (
    `${device.value.name} declares no USB transport — only TCP-9100 / Wi-Fi. ` +
    `Browsers cannot open raw TCP sockets, so this transport is CLI-only ` +
    `(install verify-cli) or use a USB-capable model.`
  );
});

// Prefill from the SKU probe when present.
function prefillFromSku(): void {
  const sku = connection.identity?.extra?.detectedSku;
  if (typeof sku !== 'string') return;
  for (const m of compatibleMedia.value) {
    if (m.skus?.includes(sku)) {
      media.value = m;
      return;
    }
  }
}

watch(
  () => [device.value, connection.identity?.extra?.detectedSku] as const,
  () => {
    if (media.value === null) prefillFromSku();
  },
  { immediate: true },
);

const pickKey = ref<string>('');
watch(media, m => {
  pickKey.value = m ? String(m.id) : '';
});

function applyPick(): void {
  const found = compatibleMedia.value.find(m => String(m.id) === pickKey.value);
  if (found) media.value = found;
}

const showCustom = ref(false);
const customWidth = ref('28');
const customLength = ref('89');

function applyCustom(): void {
  const width = Number(customWidth.value);
  const length = Number(customLength.value);
  if (!Number.isFinite(width) || !Number.isFinite(length) || width <= 0 || length <= 0) {
    return;
  }
  // Synthetic media descriptor — the encoder reads `widthMm` and
  // `lengthDots` (or `heightMm`); we set both. `id` is `custom-` so
  // the issue body indicates the operator overrode the catalog. We
  // coerce through `unknown` because `category` is a closed literal
  // union in `MediaDescriptor`; `'die-cut'` is the closest fit for a
  // synthetic operator override and matches the encoder's branching.
  media.value = {
    id: `custom-${String(width)}x${String(length)}`,
    name: `Custom ${String(width)}×${String(length)} mm`,
    category: 'die-cut',
    widthMm: width,
    heightMm: length,
    type: 'die-cut',
    targetModels: ['lw'],
  } as unknown as LabelWriterMedia;
  showCustom.value = false;
}
</script>

<template>
  <SectionCard :step="3" title="Pick the loaded label" :state="sectionState">
    <template v-if="hasIdentity" #header-aside>
      <StatusPill :state="paperDot.state" :label="paperDot.label" />
    </template>

    <p v-if="!hasIdentity" class="muted">Confirm the model first, then pick a label.</p>

    <template v-else>
      <p v-if="transportWarning" class="warn">{{ transportWarning }}</p>

      <p v-if="connection.identity?.extra?.detectedSku">
        Detected SKU <code>{{ connection.identity.extra.detectedSku }}</code> from the printer's NFC
        roll-tag. Pre-selected below if we recognised it; pick a different entry if the prefill is
        wrong.
      </p>
      <p v-else class="muted">
        This model doesn't auto-detect its roll, so pick the loaded label manually.
      </p>

      <div class="picker">
        <label>
          Loaded label
          <select v-model="pickKey" @change="applyPick">
            <option value="" disabled>— choose —</option>
            <option v-for="m in compatibleMedia" :key="String(m.id)" :value="String(m.id)">
              {{ m.name }}
              <template v-if="m.skus && m.skus.length > 0">
                [SKUs: {{ m.skus.join(', ') }}]</template
              >
            </option>
          </select>
        </label>
        <p v-if="media" class="muted small">
          {{ media.widthMm }} × {{ media.heightMm ?? 'continuous' }} mm
          <template v-if="media.heightMm"> · {{ media.lengthDots ?? '?' }} dots length</template>
        </p>
      </div>
    </template>

    <template v-if="hasIdentity" #advanced>
      <p class="muted small">
        Custom dimensions — bypasses the catalogue. The diagnostic encoder will use these directly;
        the issue body marks the report as a custom-dimension run.
      </p>
      <button v-if="!showCustom" class="ghost" type="button" @click="showCustom = true">
        Set custom dimensions
      </button>
      <div v-else class="custom-form">
        <label>
          Width (mm)
          <input v-model="customWidth" inputmode="numeric" />
        </label>
        <label>
          Length (mm)
          <input v-model="customLength" inputmode="numeric" />
        </label>
        <button class="primary" type="button" @click="applyCustom">Apply custom</button>
        <button class="ghost" type="button" @click="showCustom = false">Cancel</button>
      </div>
    </template>
  </SectionCard>
</template>

<style scoped>
.picker {
  margin-top: var(--space-3);
}

.picker label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: 0.9rem;
}

.picker select {
  font-family: inherit;
  width: 100%;
  max-width: 28rem;
}

.small {
  font-size: 0.85rem;
}

.warn {
  background: var(--warn-bg);
  color: var(--warn);
  border: 1px solid var(--warn);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  font-size: 0.92rem;
}

.custom-form {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: flex-end;
  margin-top: var(--space-3);
}

.custom-form label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: 0.85rem;
}

.custom-form input {
  width: 6rem;
}

.primary {
  background: var(--accent);
  color: var(--accent-fg);
  border: none;
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-4);
  font-weight: 600;
  font-size: 0.9rem;
}

.primary:hover {
  background: var(--accent-hover);
}

.ghost {
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  font-size: 0.9rem;
}

.ghost:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}
</style>
