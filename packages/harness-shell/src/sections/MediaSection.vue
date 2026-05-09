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
 * The cassette/media-loaded pill in the header reads the same
 * `adapter.status.toPills` callback Connect uses, but pulls the
 * `media` slot rather than `printer`. Adapters surface the right
 * label per active engine (LW tape engine: "tape loaded"; LW label
 * engine: "paper loaded").
 *
 * Custom dimensions drawer surfaces only when the adapter's
 * `mediaPicker.customDimensions.supports(device, engine)` returns
 * true — LW label engines today; future drivers as needed.
 */
import { computed, ref } from 'vue';
import type { MediaDescriptor, PrintEngine } from '@thermal-label/contracts';
import MediaPicker from '@thermal-label/harness-components/media-picker';
import StatusPill from '@thermal-label/harness-components/status-pill';
import { useAdapter } from '../state/adapterContext';
import { useSession } from '../state/session';
import SectionCard from './SectionCard.vue';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = useAdapter<any, any, any>();
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

const detected = computed<MediaDescriptor | null>(() => {
  if (!adapter.mediaPicker.detected) return null;
  const dev = session.device.value;
  const engine = activeEngine.value;
  const identity = session.connection.identity;
  if (!dev || !engine || !identity) return null;
  return adapter.mediaPicker.detected(identity, compatibleMedia.value, engine);
});

const detectionCapability = computed(() => {
  const dev = session.device.value;
  const engine = activeEngine.value;
  if (!dev || !engine) return 'none';
  return adapter.mediaPicker.detectionCapability(dev, engine);
});

const defaultMediaId = computed<string | number>(() => {
  const dev = session.device.value;
  const engine = activeEngine.value;
  if (!dev || !engine) return '';
  return adapter.mediaPicker.defaultMediaId(dev, engine);
});

const sectionTitle = computed(() => {
  const engine = activeEngine.value;
  if (!engine || !adapter.mediaPicker.sectionTitle) return "Pick what's loaded";
  return adapter.mediaPicker.sectionTitle(engine);
});

const transportWarning = computed(() => {
  if (!adapter.mediaPicker.warning) return null;
  const dev = session.device.value;
  const engine = activeEngine.value;
  if (!dev || !engine) return null;
  return adapter.mediaPicker.warning(dev, engine);
});

const mediaDot = computed<{ state: 'unknown' | 'good' | 'warn' | 'bad'; label: string } | null>(
  () => {
    if (!adapter.status) return null;
    const engine = activeEngine.value;
    const ctx: { engine?: PrintEngine } = engine ? { engine } : {};
    const pills = adapter.status.toPills(session.printerStatus.value, ctx);
    return pills.media ?? null;
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

// Custom-dimensions drawer

const supportsCustom = computed(() => {
  if (!adapter.mediaPicker.customDimensions) return false;
  const dev = session.device.value;
  const engine = activeEngine.value;
  if (!dev || !engine) return false;
  return adapter.mediaPicker.customDimensions.supports(dev, engine);
});

const showCustom = ref(false);
const defaultWidth = computed(() => adapter.mediaPicker.customDimensions?.defaultWidthMm ?? 28);
const defaultLength = computed(() => adapter.mediaPicker.customDimensions?.defaultLengthMm ?? 89);
const customWidth = ref(String(defaultWidth.value));
const customLength = ref(String(defaultLength.value));

function applyCustom(): void {
  const slot = session.activeSession.value;
  const dev = session.device.value;
  const engine = activeEngine.value;
  if (!slot || !dev || !engine || !adapter.mediaPicker.customDimensions) return;
  const widthMm = Number(customWidth.value);
  const lengthMm = Number(customLength.value);
  if (!Number.isFinite(widthMm) || !Number.isFinite(lengthMm) || widthMm <= 0 || lengthMm <= 0) {
    return;
  }
  slot.media = adapter.mediaPicker.customDimensions.build({
    widthMm,
    lengthMm,
    device: dev,
    engine,
  });
  showCustom.value = false;
}
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
      <p v-if="transportWarning" class="warn">{{ transportWarning }}</p>

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
    </template>

    <template v-if="session.hasIdentity.value && supportsCustom" #advanced>
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
.warn {
  background: var(--warn-bg);
  color: var(--warn);
  border: 1px solid var(--warn);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  font-size: 0.92rem;
}

.small {
  font-size: 0.85rem;
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
