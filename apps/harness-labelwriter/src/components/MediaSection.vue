<script setup lang="ts">
/**
 * Media-picker section.
 *
 * Reads + writes the currently-active engine's session slot
 * (`activeSession.media`). Filters `MEDIA` to entries whose
 * `targetModels` overlap with the active engine's `mediaCompatibility`
 * — labelwriter label media for label engines, D1 tape for the Duo's
 * tape engine.
 *
 * Multi-engine devices route into this same component per tab; the
 * EngineTabs shell flips `selectedRole`, the component re-resolves the
 * active engine + catalogue, and the operator picks media for that
 * engine. Single-engine devices use the same path with one engine.
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
import {
  MEDIA,
  type LabelWriterAnyMedia,
  type LabelWriterMedia,
  type LabelWriterTapeMedia,
} from '@thermal-label/labelwriter-core';
import { activeSession, connection, device, hasIdentity, printerStatus } from '../state/session';
import StatusPill from '@thermal-label/harness-components/status-pill';
import SectionCard from './SectionCard.vue';

const sectionState = computed<'pending' | 'active' | 'done'>(() => {
  if (!hasIdentity.value || !activeSession.value) return 'pending';
  if (activeSession.value.media === null) return 'active';
  return 'done';
});

const isTapeEngine = computed(() => activeSession.value?.engine.protocol === 'd1-tape');

/**
 * Loaded-media pill in the section header. LW status carries
 * `mediaLoaded` (the no_media bit). Three states: unknown grey
 * before first poll lands; green when present; red when not.
 * Paper-jam counts as "loaded but unhappy" → warn. The label
 * adapts to the active engine (tape vs paper).
 *
 * Note: status polling is global per-device today (Connect-section
 * picks the first engine's transport). On Duo that's the label
 * engine; the tape engine doesn't have its own poll yet, so the
 * tape tab's pill reflects the label engine's read. Acceptable
 * placeholder until per-engine polling lands.
 */
type DotState = 'unknown' | 'good' | 'warn' | 'bad';
const mediaNoun = computed(() => (isTapeEngine.value ? 'tape' : 'paper'));
const mediaDot = computed<{ state: DotState; label: string }>(() => {
  const s = printerStatus.value;
  if (!s) return { state: 'unknown', label: `${mediaNoun.value}: checking…` };
  if (!s.mediaLoaded) return { state: 'bad', label: `No ${mediaNoun.value} loaded` };
  const jam = s.errors.some(e => e.code === 'paper_jam');
  return jam
    ? { state: 'warn', label: `${mediaNoun.value} loaded — jam reported` }
    : {
        state: 'good',
        label: `${mediaNoun.value.charAt(0).toUpperCase()}${mediaNoun.value.slice(1)} loaded`,
      };
});

function isLabelMedia(m: unknown): m is LabelWriterMedia {
  if (typeof m !== 'object' || m === null) return false;
  const t = (m as { type?: string }).type;
  return t === 'die-cut' || t === 'continuous';
}

function isTapeMedia(m: unknown): m is LabelWriterTapeMedia {
  if (typeof m !== 'object' || m === null) return false;
  return (m as { type?: string }).type === 'tape';
}

const allMediaForActiveEngine = computed<readonly LabelWriterAnyMedia[]>(() => {
  const all = Object.values(MEDIA) as readonly unknown[];
  return isTapeEngine.value ? all.filter(isTapeMedia) : all.filter(isLabelMedia);
});

const compatibleMedia = computed<readonly LabelWriterAnyMedia[]>(() => {
  const session = activeSession.value;
  if (!session) return [];
  const compat = session.engine.mediaCompatibility;
  if (compat === undefined) return allMediaForActiveEngine.value;
  return allMediaForActiveEngine.value.filter(m => {
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

// Prefill from the SKU probe when present — only on label engines;
// tape engines have no NFC SKU equivalent.
function prefillFromSku(): void {
  if (isTapeEngine.value) return;
  const session = activeSession.value;
  if (!session) return;
  const sku = connection.identity?.extra?.detectedSku;
  if (typeof sku !== 'string') return;
  for (const m of compatibleMedia.value) {
    const labelM = m as LabelWriterMedia;
    if (labelM.skus?.includes(sku)) {
      session.media = m;
      return;
    }
  }
}

watch(
  () => [activeSession.value, connection.identity?.extra?.detectedSku] as const,
  () => {
    if (activeSession.value && activeSession.value.media === null) prefillFromSku();
  },
  { immediate: true },
);

const pickKey = ref<string>('');
watch(
  () => activeSession.value?.media,
  m => {
    pickKey.value = m ? String(m.id) : '';
  },
  { immediate: true },
);

function applyPick(): void {
  const session = activeSession.value;
  if (!session) return;
  const found = compatibleMedia.value.find(m => String(m.id) === pickKey.value);
  if (found) session.media = found;
}

const showCustom = ref(false);
const customWidth = ref('28');
const customLength = ref('89');

function applyCustom(): void {
  const session = activeSession.value;
  if (!session) return;
  if (isTapeEngine.value) {
    // Tape engines don't take custom dimensions — width is locked to
    // the cassette and the encoder rejects unknown widths. Hide the
    // affordance there. (Belt-and-braces guard: should be unreachable
    // because the drawer is gated by the same flag.)
    return;
  }
  const width = Number(customWidth.value);
  const length = Number(customLength.value);
  if (!Number.isFinite(width) || !Number.isFinite(length) || width <= 0 || length <= 0) {
    return;
  }
  // Synthetic media descriptor — the encoder reads `widthMm` and
  // `lengthDots` (or `heightMm`); we set both. `id` is `custom-` so
  // the issue body indicates the operator overrode the catalog.
  session.media = {
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

const sectionTitle = computed(() =>
  isTapeEngine.value ? 'Pick the loaded D1 tape' : 'Pick the loaded label',
);
const pickLabel = computed(() => (isTapeEngine.value ? 'Loaded tape' : 'Loaded label'));
</script>

<template>
  <SectionCard :step="3" :title="sectionTitle" :state="sectionState">
    <template v-if="hasIdentity" #header-aside>
      <StatusPill :state="mediaDot.state" :label="mediaDot.label" />
    </template>

    <p v-if="!hasIdentity" class="muted">Confirm the model first, then pick a label.</p>

    <template v-else-if="!activeSession">
      <p class="muted">Pick an engine tab first.</p>
    </template>

    <template v-else>
      <p v-if="transportWarning" class="warn">{{ transportWarning }}</p>

      <p
        v-if="!isTapeEngine && connection.identity?.extra?.detectedSku"
        :key="String(connection.identity.extra.detectedSku)"
      >
        Detected SKU <code>{{ connection.identity.extra.detectedSku }}</code> from the printer's NFC
        roll-tag. Pre-selected below if we recognised it; pick a different entry if the prefill is
        wrong.
      </p>
      <p v-else-if="!isTapeEngine" class="muted">
        This model doesn't auto-detect its roll, so pick the loaded label manually.
      </p>
      <p v-else class="muted">
        Pick the D1 cassette currently loaded in the tape slot. Width is locked by the cassette;
        colour drives the wire palette byte (<code>ESC C</code>).
      </p>

      <div class="picker">
        <label>
          {{ pickLabel }}
          <select v-model="pickKey" @change="applyPick">
            <option value="" disabled>— choose —</option>
            <option v-for="m in compatibleMedia" :key="String(m.id)" :value="String(m.id)">
              {{ m.name }}
              <template
                v-if="(m as LabelWriterMedia).skus && (m as LabelWriterMedia).skus!.length > 0"
              >
                [SKUs: {{ (m as LabelWriterMedia).skus!.join(', ') }}]</template
              >
            </option>
          </select>
        </label>
        <p v-if="activeSession.media" class="muted small">
          {{ (activeSession.media as LabelWriterMedia).widthMm }} ×
          {{ (activeSession.media as LabelWriterMedia).heightMm ?? 'continuous' }} mm
          <template v-if="(activeSession.media as LabelWriterMedia).heightMm">
            · {{ (activeSession.media as LabelWriterMedia).lengthDots ?? '?' }} dots
            length</template
          >
        </p>
      </div>
    </template>

    <template v-if="hasIdentity && activeSession && !isTapeEngine" #advanced>
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
