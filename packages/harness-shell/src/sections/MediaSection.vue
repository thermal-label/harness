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
import type { DetectionCapability } from '@thermal-label/harness-components/types';
import { useAdapter } from '../state/adapterContext';
import { useSession } from '../state/session';
import { engineNoun, statusToMediaPill } from '../state/statusPills';
import type { CustomMediaInput } from '../types';
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
 * The raw `detectedMedia` off the polled `PrinterStatus`, or `null`
 * when the driver reports nothing. Drivers that can't detect (LM,
 * LW 450) leave `detectedMedia` undefined.
 */
const rawDetectedMedia = computed<MediaDescriptor | null>(() => {
  return (session.activeStatus.value?.detectedMedia as MediaDescriptor | undefined) ?? null;
});

/**
 * SKU strings carried by the detected media. The LW 5xx NFC path reads
 * the loaded roll's vendor SKU off its tag and surfaces it in
 * `detectedMedia.name` (e.g. `"30252"`); a driver may also populate
 * `skus[]` directly. Both feed the catalogue SKU match below. Trimmed,
 * deduped, empty strings dropped.
 */
const detectedSkus = computed<readonly string[]>(() => {
  const d = rawDetectedMedia.value;
  if (!d) return [];
  const out = new Set<string>();
  const name = d.name.trim();
  if (name) out.add(name);
  for (const s of d.skus ?? []) {
    const trimmed = s.trim();
    if (trimmed) out.add(trimmed);
  }
  return [...out];
});

/**
 * Detected media resolved back to a *catalogue* entry — the canonical
 * object the picker pre-selects in `auto-locked` mode. `null` when
 * nothing is detected OR when the detected media maps to no catalogue
 * entry (an unknown roll / unlisted SKU).
 *
 * Two strategies, in order:
 *  1. `id` equality — a driver whose detection round-trips a catalogue
 *     `id` directly.
 *  2. SKU match — the LW 5xx NFC path can't round-trip an `id` (its
 *     detected `id` is a synthetic `sku-<n>` that equals no catalogue
 *     entry), but it does carry the vendor SKU. Match that SKU against
 *     each catalogue entry's `skus[]`; a hit means the roll is in the
 *     registry under a proper name, so auto-lock to that entry.
 *
 * No hit by either strategy keeps the existing fallback in place — the
 * picker drops to `detected-unrecognized` (geometry known, name not).
 */
const matchedMedia = computed<MediaDescriptor | null>(() => {
  const fromStatus = rawDetectedMedia.value;
  if (!fromStatus) return null;
  const list = compatibleMedia.value;

  const id = (fromStatus as { id?: unknown }).id;
  if (id !== undefined) {
    const byId = list.find(m => (m as { id?: unknown }).id === id);
    if (byId) return byId;
  }

  const skus = detectedSkus.value;
  if (skus.length > 0) {
    const bySku = list.find(m => m.skus?.some(s => skus.includes(s.trim())));
    if (bySku) return bySku;
  }

  return null;
});

/**
 * The detected media when it maps to NO catalogue entry — geometry
 * known, name unknown. Drives the `detected-unrecognized` panel.
 * `null` whenever the detection is absent or matched the catalogue.
 */
const rawDetected = computed<MediaDescriptor | null>(() => {
  if (!rawDetectedMedia.value) return null;
  return matchedMedia.value ? null : rawDetectedMedia.value;
});

/** The driver's optional custom-media builder, if it supplies one. */
const buildCustomMedia = computed<((input: CustomMediaInput) => MediaDescriptor) | null>(() => {
  return adapter.mediaPicker.customMedia?.build ?? null;
});

const detectionCapability = computed<DetectionCapability>(() => {
  // Drivers expose detection capability per engine via
  // `engine.capabilities.mediaDetection`.
  //   - no capability                       → 'none'
  //   - capability, no detectedMedia        → 'auto-suggest'
  //   - capability, detected matches catalogue → 'auto-locked'
  //   - capability, detected present, no match,
  //     adapter supplies customMedia.build  → 'detected-unrecognized'
  //   - capability, no match, no customMedia hook → 'auto-suggest'
  //     (graceful degrade — never hard-lock to a non-catalogue object)
  const engine = activeEngine.value as { capabilities?: { mediaDetection?: boolean } } | null;
  if (!engine?.capabilities?.mediaDetection) return 'none';
  if (matchedMedia.value) return 'auto-locked';
  if (rawDetected.value) {
    return buildCustomMedia.value ? 'detected-unrecognized' : 'auto-suggest';
  }
  return 'auto-suggest';
});

/**
 * The `detected` prop handed to `<MediaPicker>`. For `auto-locked`
 * it is the resolved catalogue entry; for `detected-unrecognized` it
 * is the raw geometry-bearing object the panel prefills from.
 */
const detectedForPicker = computed<MediaDescriptor | null>(() => {
  return detectionCapability.value === 'detected-unrecognized'
    ? rawDetected.value
    : matchedMedia.value;
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

// Verbatim on-wire bytes behind the detected SKU (the LW 5xx `ESC U`
// dump), hex-encoded — captured into the active engine session by
// ConnectSection from the adapter's connect diagnostics. Rides into
// the SKU-submission issue so a maintainer can reconstruct the media
// entry from the raw frame, not just the decoded geometry. `null`
// when the driver captured no SKU bytes.
const detectedSkuRawBytes = computed<string | null>(() => {
  const raw = session.activeSession.value?.skuInfo?.rawBytes;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
});

// Prefilled issue URL for an uncatalogued *detected* roll — the
// printer read a real SKU + geometry (LW 5xx NFC tag) that the
// thermal-label catalogue doesn't list yet. Distinct from the generic
// "Don't see your label?" link below: this one comes pre-populated
// from the detection, so contributing the missing SKU is one click.
// `null` whenever detection matched the catalogue or produced nothing.
const detectedIssueUrl = computed<string | null>(() => {
  const d = rawDetected.value;
  if (!d) return null;
  const dims =
    typeof d.heightMm === 'number' && d.heightMm > 0
      ? `${String(d.widthMm)} × ${String(d.heightMm)} mm`
      : `${String(d.widthMm)} mm continuous`;
  // The raw SKU dump is the load-bearing artifact — geometry decoded
  // wrong (the deci-mm bug) is recoverable from these bytes. Fenced so
  // it round-trips clean through copy-paste into a registry entry.
  const rawBytes = detectedSkuRawBytes.value;
  const rawBytesBlock = rawBytes ? `\nRaw SKU dump (hex):\n\`\`\`\n${rawBytes}\n\`\`\`\n` : '';
  const title = encodeURIComponent(`[media] Add ${d.name} to the ${adapter.driverKey} catalogue`);
  const body = encodeURIComponent(
    `The harness detected a roll that isn't in the thermal-label media catalogue yet.\n\n` +
      `Driver: ${adapter.driverKey}\n` +
      `Device: ${session.device.value ? adapter.deviceName(session.device.value) : '(unknown)'}\n\n` +
      `Detected media — read from the printer:\n` +
      `- SKU / identifier: ${d.name}\n` +
      `- Dimensions: ${dims}\n` +
      `- Type: ${d.type}\n` +
      rawBytesBlock +
      `\nPlease add this SKU to the driver's media registry.\n`,
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
        :detected="detectedForPicker"
        :build-custom-media="buildCustomMedia"
        @update:model-value="onUpdate"
      />

      <p
        v-if="detectedIssueUrl"
        class="muted small dont-see detected-unknown"
      >
        Detected <code>{{ rawDetected?.name }}</code> — not in the thermal-label catalogue yet.
        <a :href="detectedIssueUrl" target="_blank" rel="noopener">Submit it for the library →</a>
      </p>
      <p v-else class="muted small dont-see">
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

.detected-unknown code {
  font-family: var(--font-mono);
  font-size: 0.92em;
}
</style>
