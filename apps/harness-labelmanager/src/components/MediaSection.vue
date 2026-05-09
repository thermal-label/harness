<script setup lang="ts">
/**
 * D1 cartridge picker — thin wrapper around the shared
 * `<MediaPicker>` from `@thermal-label/harness-components`.
 *
 * Filters `MEDIA_LIST` to entries whose `targetModels` overlap with
 * the connected device's `engines[0].mediaCompatibility`, then
 * supplies driver-specific bindings (group-by-tape-width with Rhino
 * cassettes demoted to `priority: 'secondary'`, swatch from
 * `media.text` / `media.background`).
 *
 * Labelmanager has no NFC roll-tag detection (the chassis doesn't
 * read cartridge IDs in any documented protocol), so the pick is
 * always operator-driven (`detectionCapability: 'none'`). The picker
 * pre-selects `DEFAULT_MEDIA` (12 mm Black-on-White STANDARD) on
 * mount and fires `update:modelValue` once; section state oscillates
 * between `active` (operator hasn't touched it) and `done` (touched
 * or default kept), driven by a `touched` flag.
 *
 * The chosen media drives two encoder values: the head dot count
 * (via `tapeWidthMm`) and the `ESC C n` tape-type byte (via
 * `text` / `background` colours, resolved by `tapeTypeFor(media)`
 * inside `buildPrinterStream`).
 *
 * Rhino industrial cassettes (`material` starts with `rhino-`) are
 * grouped as `priority: 'secondary'` and render under a
 * `Less common (N)` disclosure, collapsed by default. They're
 * mechanically D1-compatible but DYMO doesn't endorse the cross-use
 * and the stiffer substrates accelerate wear — visually demoting
 * them keeps the common-case picker uncluttered.
 */
import { computed, ref } from 'vue';
import {
  DEFAULT_MEDIA,
  MEDIA_LIST,
  type LabelManagerMedia,
  type TapeWidth,
} from '@thermal-label/labelmanager-core';
import MediaPicker from '@thermal-label/harness-components/media-picker';
import StatusPill from '@thermal-label/harness-components/status-pill';
import type { MediaGroupKey, MediaSwatch } from '@thermal-label/harness-components/types';
import { device, hasIdentity, media, printerStatus } from '../state/session';
import SectionCard from './SectionCard.vue';

const touched = ref(false);

const sectionState = computed<'pending' | 'active' | 'done'>(() => {
  if (!hasIdentity.value) return 'pending';
  return touched.value ? 'done' : 'active';
});

const compatibleMedia = computed<readonly LabelManagerMedia[]>(() => {
  if (!device.value) return [];
  const compat = device.value.engines[0]?.mediaCompatibility ?? [];
  return MEDIA_LIST.filter(m => {
    const targets = m.targetModels ?? [];
    return targets.some(t => compat.includes(t));
  });
});

const HEAD_DOTS_FOR_TAPE: Record<TapeWidth, number> = {
  6: 32,
  9: 48,
  12: 64,
  19: 64,
};

/**
 * Group key — by tape width for STANDARD/specialty entries; a single
 * `rhino` bucket per width for the industrial line, demoted to
 * `priority: 'secondary'` so they render under the disclosure. The
 * Rhino discriminator is `media.material` starting with `rhino-`
 * (matches d1-core's catalogue: `rhino-vinyl`, `rhino-heat-shrink`,
 * `rhino-permanent-polyester`, `rhino-flexible-nylon`,
 * `rhino-non-adhesive-tag`).
 */
function groupBy(m: LabelManagerMedia): MediaGroupKey {
  const isRhino = typeof m.material === 'string' && m.material.startsWith('rhino-');
  if (isRhino) {
    return {
      key: `rhino-${String(m.tapeWidthMm)}mm`,
      label: `Rhino industrial — ${String(m.tapeWidthMm)} mm`,
      priority: 'secondary',
      // Sort widths ascending within the secondary disclosure.
      sort: m.tapeWidthMm,
    };
  }
  return {
    key: `${String(m.tapeWidthMm)}mm`,
    label: `${String(m.tapeWidthMm)} mm  ·  head ${String(HEAD_DOTS_FOR_TAPE[m.tapeWidthMm])} dots`,
    priority: 'primary',
    sort: m.tapeWidthMm,
  };
}

function swatch(m: LabelManagerMedia): MediaSwatch | null {
  const out: MediaSwatch = {};
  if (m.text !== undefined) out.fg = m.text;
  if (m.background !== undefined) out.bg = m.background;
  return out;
}

function describe(m: LabelManagerMedia): string {
  return m.name;
}

function onUpdate(next: LabelManagerMedia | null): void {
  if (!next) return;
  // Treat the very first auto-default as "untouched"; only flip
  // `touched` once the operator deliberately changes the pick.
  if (next.id !== media.value.id) touched.value = true;
  media.value = next;
}

// ─── Live cassette-presence pill (shown in the section header) ──

/**
 * Cassette pill — D1 status gives us presence (firmware can't read
 * type). Three states: unknown grey before first poll lands; green
 * loaded; red missing. The "ready / busy / low-tape" reading is
 * surfaced in the Connect section's header, not here.
 */
type DotState = 'unknown' | 'good' | 'warn' | 'bad';

const cassetteDot = computed<{ state: DotState; label: string }>(() => {
  const s = printerStatus.value;
  if (!s) return { state: 'unknown', label: 'Cassette: checking…' };
  if (!s.mediaLoaded) return { state: 'bad', label: 'No cassette' };
  const low = s.errors.some(e => e.code === 'low_media');
  return low
    ? { state: 'warn', label: 'Cassette loaded — tape low' }
    : { state: 'good', label: 'Cassette loaded' };
});
</script>

<template>
  <SectionCard :step="3" title="Pick what's loaded" :state="sectionState">
    <template v-if="hasIdentity" #header-aside>
      <StatusPill :state="cassetteDot.state" :label="cassetteDot.label" />
    </template>

    <p v-if="!hasIdentity" class="muted">
      Confirm the model first, then pick the loaded D1 cartridge.
    </p>

    <template v-else>
      <p>
        Pick what's loaded — drives the head dot count and the tape-type byte sent to the firmware.
        Labelmanager has no way to detect the cartridge automatically.
      </p>

      <MediaPicker
        :model-value="media"
        :available="compatibleMedia"
        :default-media-id="DEFAULT_MEDIA.id"
        :group-by="groupBy"
        :swatch="swatch"
        :describe="describe"
        detection-capability="none"
        @update:model-value="onUpdate"
      />
    </template>
  </SectionCard>
</template>
