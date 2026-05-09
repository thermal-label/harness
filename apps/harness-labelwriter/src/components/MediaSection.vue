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
import { computed, ref } from 'vue';
import {
  MEDIA,
  type LabelWriterAnyMedia,
  type LabelWriterMedia,
  type LabelWriterTapeMedia,
} from '@thermal-label/labelwriter-core';
import { activeSession, connection, device, hasIdentity, printerStatus } from '../state/session';
import MediaPicker from '@thermal-label/harness-components/media-picker';
import StatusPill from '@thermal-label/harness-components/status-pill';
import type { MediaGroupKey, MediaSwatch } from '@thermal-label/harness-components/types';
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

// ─── MediaPicker bindings ────────────────────────────────────────

/**
 * Per-engine default selection. Tape engines pre-select 12 mm
 * Black-on-White STANDARD (the most common D1 cassette); label
 * engines pre-select the standard address label, which exists in
 * almost every LW model's compatible set. If the default isn't in
 * the engine's compatible set, the picker falls back to the first
 * available entry (defensive logic in the shared component).
 */
const defaultMediaId = computed<string>(() =>
  isTapeEngine.value ? 'd1-standard-bw-12' : 'address-standard',
);

/**
 * Detected media — only populated on label engines that support NFC
 * SKU detection (LW 5xx). Resolves the operator's loaded SKU to a
 * media descriptor in the catalogue; the picker either pre-selects
 * it (`auto-suggest`) or locks to it (`auto-locked`). LW 5xx is
 * `auto-suggest` — operator can override the firmware's reading.
 */
const detected = computed<LabelWriterAnyMedia | null>(() => {
  if (isTapeEngine.value) return null;
  const sku = connection.identity?.extra?.detectedSku;
  if (typeof sku !== 'string') return null;
  return compatibleMedia.value.find(m => (m as LabelWriterMedia).skus?.includes(sku)) ?? null;
});

const detectionCapability = computed<'none' | 'auto-suggest' | 'auto-locked'>(() => {
  if (isTapeEngine.value) return 'none';
  // LW 5xx engines declare `capabilities.mediaDetection` — engine
  // can read the loaded SKU via NFC. Other label engines (3xx/4xx)
  // have no detection.
  const dev = device.value;
  if (!dev) return 'none';
  const detects = dev.engines.some(e => e.capabilities?.mediaDetection === true);
  return detects ? 'auto-suggest' : 'none';
});

/**
 * Group-by descriptor for both engines:
 *  - Tape engine: by tape width. Demote Rhino industrial cassettes
 *    (`material` starts with `rhino-`) to `priority: 'secondary'`,
 *    same convention as the labelmanager harness. LW's tape
 *    catalogue is currently STANDARD-only (no Rhino), but the
 *    discriminator is harmless extra and stays consistent.
 *  - Label engine: by category (address / shipping / multi-purpose
 *    are the common buckets — primary; barcode / file-folder /
 *    name-badge / price-tag / continuous demote to secondary so
 *    the picker doesn't sprawl on first paint).
 */
const PRIMARY_LABEL_CATEGORIES = new Set(['address', 'shipping', 'multi-purpose']);

function groupBy(m: LabelWriterAnyMedia): MediaGroupKey {
  if (isTapeMedia(m)) {
    const isRhino = typeof m.material === 'string' && m.material.startsWith('rhino-');
    if (isRhino) {
      return {
        key: `rhino-${String(m.tapeWidthMm)}mm`,
        label: `Rhino industrial — ${String(m.tapeWidthMm)} mm`,
        priority: 'secondary',
        sort: m.tapeWidthMm,
      };
    }
    return {
      key: `tape-${String(m.tapeWidthMm)}mm`,
      label: `${String(m.tapeWidthMm)} mm tape`,
      priority: 'primary',
      sort: m.tapeWidthMm,
    };
  }
  const cat = (m as LabelWriterMedia).category ?? 'other';
  const isPrimary = PRIMARY_LABEL_CATEGORIES.has(cat);
  return {
    key: `cat-${cat}`,
    label: cat
      .split('-')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' '),
    priority: isPrimary ? 'primary' : 'secondary',
  };
}

function swatch(m: LabelWriterAnyMedia): MediaSwatch | null {
  if (!isTapeMedia(m)) return null;
  const out: MediaSwatch = {};
  if (m.text !== undefined) out.fg = m.text;
  if (m.background !== undefined) out.bg = m.background;
  return out;
}

function describe(m: LabelWriterAnyMedia): string {
  return m.name;
}

function onUpdate(next: LabelWriterAnyMedia | null): void {
  const session = activeSession.value;
  if (!session) return;
  session.media = next;
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
</script>

<template>
  <SectionCard :step="2" :title="sectionTitle" :state="sectionState">
    <template v-if="hasIdentity" #header-aside>
      <StatusPill :state="mediaDot.state" :label="mediaDot.label" />
    </template>

    <p v-if="!hasIdentity" class="muted">Confirm the model first, then pick a label.</p>

    <template v-else-if="!activeSession">
      <p class="muted">Pick an engine tab first.</p>
    </template>

    <template v-else>
      <p v-if="transportWarning" class="warn">{{ transportWarning }}</p>

      <p v-if="!isTapeEngine" class="muted">
        Pick the loaded label — drives the bitmap dimensions sent to the printer.
      </p>
      <p v-else class="muted">
        Pick the D1 cassette currently loaded. Width is locked by the cassette; colour drives the
        wire palette byte (<code>ESC C</code>).
      </p>

      <MediaPicker
        :model-value="activeSession.media"
        :available="compatibleMedia"
        :default-media-id="defaultMediaId"
        :group-by="groupBy"
        :swatch="swatch"
        :describe="describe"
        :detection-capability="detectionCapability"
        :detected="detected"
        @update:model-value="onUpdate"
      />
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
