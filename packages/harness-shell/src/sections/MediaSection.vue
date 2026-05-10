<script setup lang="ts">
/**
 * Media-picker section. Generic over the adapter's media type via
 * `adapter.mediaPicker`.
 *
 * Reads + writes the currently-active engine's session slot
 * (`activeSession.media`). Multi-engine devices route into this same
 * component per tab; the EngineTabs shell flips `selectedRole`, the
 * component re-resolves the active engine + catalogue + detected
 * media, and the operator picks for that engine.
 *
 * Detection comes straight from `printer.getStatus().detectedMedia`
 * (standardised across all drivers via `PrinterAdapter`). When the
 * driver reports detected media, the picker pre-selects it and locks
 * the catalogue (`auto-locked` mode); otherwise the operator picks
 * manually.
 *
 * "Don't see your label?" now points at the driver repo's issue
 * tracker — operator-facing custom-dimension functionality lives on
 * the burnmark.io app, not in the harness.
 */
import { computed } from 'vue';
import type { MediaDescriptor, PrintEngine } from '@thermal-label/contracts';
import MediaPicker from '@thermal-label/harness-components/media-picker';
import StatusPill from '@thermal-label/harness-components/status-pill';
import { useAdapter } from '../state/adapterContext';
import { useSession } from '../state/session';
import { engineNoun, statusToMediaPill } from '../state/statusPills';
import SectionCard from './SectionCard.vue';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = useAdapter<any, any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const session = useSession<any, any>();

const sectionState = computed<'pending' | 'active' | 'done'>(() => {
  if (!session.hasIdentity.value || !session.activeSession.value) return 'pending';
  if (session.activeSession.value.media === null) return 'active';
  return 'done';
});

const activeEngine = computed<PrintEngine | null>(() => session.activeEngine.value);

/**
 * Filter the adapter's media catalogue down to entries compatible
 * with the active device + engine. Adapter supplies the filter so
 * driver-specific shape (`mediaCompatibility`, `targetModels`,
 * `type` discriminators) stays out of the shell.
 */
const compatibleMedia = computed<readonly MediaDescriptor[]>(() => {
  const dev = session.device.value;
  const engine = activeEngine.value;
  if (!dev || !engine) return [];
  return adapter.mediaPicker.filterByDeviceEngine(adapter.media, dev, engine);
});

/**
 * Detected media — pulled directly from the polled `PrinterStatus`.
 * The driver tags `detectedMedia` per the standard `PrinterStatus`
 * shape; we resolve it back to a catalogue entry by id so the picker
 * pre-selects the canonical object (not a detached one). Drivers
 * that can't detect (LM, LW 450) leave `detectedMedia` undefined and
 * the picker stays in manual mode.
 */
const detected = computed<MediaDescriptor | null>(() => {
  const fromStatus = session.activeStatus.value?.detectedMedia;
  if (!fromStatus) return null;
  // Try by id first (numeric or string), else fall back to identity equality.
  const id = (fromStatus as { id?: unknown }).id;
  if (id !== undefined) {
    const match = compatibleMedia.value.find(
      m => (m as { id?: unknown }).id === id,
    );
    if (match) return match;
  }
  return fromStatus;
});

const detectionCapability = computed<'none' | 'auto-suggest' | 'auto-locked'>(() => {
  // Drivers expose detection capability per engine via
  // `engine.capabilities.mediaDetection`. When true AND the status
  // payload carries detectedMedia, we lock (brother-ql; LW 5xx).
  // When true but no detected media is reported yet, we suggest the
  // detected slot will fill in. Otherwise no detection.
  const engine = activeEngine.value as { capabilities?: { mediaDetection?: boolean } } | null;
  if (!engine?.capabilities?.mediaDetection) return 'none';
  return detected.value ? 'auto-locked' : 'auto-suggest';
});

const defaultMediaId = computed<string | number>(() => {
  // For D1 tape engines (standalone LM + LW Duo tape side) prefer the
  // 12 mm Black on White cassette — the most common stock and the
  // "boring baseline" maintainers want operators to test against
  // unless they specifically pick something else.
  const list = compatibleMedia.value;
  if (activeEngine.value?.protocol === 'd1-tape') {
    const bw12 = list.find(m => (m as { id?: string }).id === 'd1-standard-bw-12');
    if (bw12) return (bw12 as { id: string }).id;
  }
  // Fallback: first compatible entry. Operators almost always change it.
  const first = list[0] as { id?: string | number } | undefined;
  return first?.id ?? '';
});

const sectionTitle = computed(() => {
  const noun = engineNoun(activeEngine.value);
  if (noun === 'media') return "Pick what's loaded";
  return `Pick the loaded ${noun}`;
});

const mediaDot = computed<{ state: 'unknown' | 'good' | 'warn' | 'bad'; label: string } | null>(
  () => {
    if (!session.isConnected.value) return null;
    const noun = engineNoun(activeEngine.value);
    return statusToMediaPill(session.activeStatus.value, noun);
  },
);

function onUpdate(next: MediaDescriptor | null): void {
  const slot = session.activeSession.value;
  if (!slot) return;
  slot.media = next;
}

// MediaPicker's `swatch` / `describe` props are optional. Under
// exactOptionalPropertyTypes, passing `undefined` (the unwrapped
// adapter callbacks when omitted) trips a strictness error. Wrap with
// safe fallbacks so the prop binding stays type-clean.
const swatchFn = adapter.mediaPicker.swatch ?? (() => null);
const describeFn = adapter.mediaPicker.describe ?? ((m: MediaDescriptor) => m.name);

// "Don't see your label?" CTA — opens a prefilled issue against the
// driver's repo. Replaces the in-app custom-dimensions drawer per
// the user's harness-v2 split.
const issueUrl = computed(() => {
  const title = encodeURIComponent(`[harness] Add support for label type X`);
  const body = encodeURIComponent(
    `Reporting a label type not yet in the thermal-label catalogue.\n\n` +
      `Driver: ${adapter.driverKey}\n` +
      `Device: ${session.device.value ? adapter.deviceName(session.device.value) : '(unknown)'}\n\n` +
      `Label details (please fill in):\n` +
      `- Manufacturer SKU / part number:\n` +
      `- Width × length (mm):\n` +
      `- Where I bought it:\n`,
  );
  return `https://github.com/${adapter.targetRepo}/issues/new?title=${title}&body=${body}`;
});
</script>

<template>
  <SectionCard :step="2" :title="sectionTitle" :state="sectionState">
    <template v-if="session.hasIdentity.value && mediaDot" #header-aside>
      <StatusPill :state="mediaDot.state" :label="mediaDot.label" />
    </template>

    <p v-if="!session.hasIdentity.value" class="muted">
      Confirm the model first, then pick what's loaded.
    </p>

    <template v-else-if="!session.activeSession.value">
      <p class="muted">Pick an engine tab first.</p>
    </template>

    <template v-else>
      <MediaPicker
        :model-value="session.activeSession.value.media"
        :available="compatibleMedia"
        :default-media-id="defaultMediaId"
        :group-by="adapter.mediaPicker.groupBy"
        :swatch="swatchFn"
        :describe="describeFn"
        :detection-capability="detectionCapability"
        :detected="detected"
        @update:model-value="onUpdate"
      />

      <p class="muted small dont-see">
        Don't see your label?
        <a :href="issueUrl" target="_blank" rel="noopener">Add support for label type X →</a>
      </p>
    </template>
  </SectionCard>
</template>

<style scoped>
.small {
  font-size: 0.85rem;
}

.dont-see {
  margin-top: var(--space-3);
}

.dont-see a {
  color: var(--accent);
}
</style>
