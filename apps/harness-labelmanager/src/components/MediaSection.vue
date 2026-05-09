<script setup lang="ts">
/**
 * D1 cartridge picker — replaces the four-button tape-width picker.
 *
 * Filters `MEDIA_LIST` to entries whose `targetModels` overlap with
 * the connected device's `engines[0].mediaCompatibility` so a 12mm-
 * tier chassis only shows 6/9/12 mm SKUs, a 19mm-tier shows
 * 6/9/12/19 mm, etc. Within the compatible set, entries are grouped
 * by `tapeWidthMm` so an operator with 12mm tape doesn't have to
 * scroll past 6 and 9mm options.
 *
 * Labelmanager has no NFC roll-tag detection (the chassis doesn't
 * read cartridge IDs in any documented protocol), so the pick is
 * always operator-driven. The picker carries `DEFAULT_MEDIA` (12mm
 * Black-on-White STANDARD) by default; section state oscillates
 * between `active` (operator hasn't touched it) and `done` (touched
 * or default kept), driven by a `touched` flag.
 *
 * The chosen media drives two encoder values: the head dot count
 * (via `tapeWidthMm`) and the `ESC C n` tape-type byte (via
 * `text` / `background` colours, resolved by `tapeTypeFor(media)`
 * inside `buildPrinterStream`).
 */
import { computed, ref } from 'vue';
import {
  MEDIA_LIST,
  type LabelManagerMedia,
  type TapeWidth,
} from '@thermal-label/labelmanager-core';
import { device, hasIdentity, media } from '../state/session';
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

interface WidthGroup {
  width: TapeWidth;
  headDots: number;
  entries: readonly LabelManagerMedia[];
}

const HEAD_DOTS_FOR_TAPE: Record<TapeWidth, number> = {
  6: 32,
  9: 48,
  12: 64,
  19: 64,
};

const widthGroups = computed<readonly WidthGroup[]>(() => {
  const byWidth = new Map<TapeWidth, LabelManagerMedia[]>();
  for (const m of compatibleMedia.value) {
    const list = byWidth.get(m.tapeWidthMm) ?? [];
    list.push(m);
    byWidth.set(m.tapeWidthMm, list);
  }
  const widths = Array.from(byWidth.keys()).sort((a, b) => a - b);
  return widths.map(width => ({
    width,
    headDots: HEAD_DOTS_FOR_TAPE[width],
    entries: byWidth.get(width) ?? [],
  }));
});

/**
 * Per-group expanded state. Default: collapse every group except the
 * one carrying the currently-selected media. On selection change the
 * matching group stays open so the operator can see what they picked.
 */
const expandedWidths = ref<Set<TapeWidth>>(new Set([media.value.tapeWidthMm]));

function toggleGroup(width: TapeWidth): void {
  const next = new Set(expandedWidths.value);
  if (next.has(width)) {
    next.delete(width);
  } else {
    next.add(width);
  }
  expandedWidths.value = next;
}

function pick(m: LabelManagerMedia): void {
  media.value = m;
  touched.value = true;
  // Keep the selected group open after picking.
  const next = new Set(expandedWidths.value);
  next.add(m.tapeWidthMm);
  expandedWidths.value = next;
}

const currentHeadDots = computed(() => HEAD_DOTS_FOR_TAPE[media.value.tapeWidthMm]);

/**
 * Best-effort CSS colour for a swatch. The d1-core media schema
 * names colours plainly (`black`, `white`, `clear`, `red`, …); most
 * survive `color: <name>` directly. `clear` and `silver` / `gold` /
 * fluorescent variants don't map cleanly — we surface them with a
 * neutral grey and let the textual `text on background` label do
 * the disambiguation.
 */
const NAMED_COLOUR_FALLBACK: Record<string, string> = {
  clear: '#e7e7e7',
  silver: '#c0c0c0',
  gold: '#d4af37',
  'fluorescent-green': '#39ff14',
  'fluorescent-red': '#ff355e',
};

function cssColour(name: string | undefined): string {
  if (!name) return 'transparent';
  if (NAMED_COLOUR_FALLBACK[name]) return NAMED_COLOUR_FALLBACK[name];
  return name;
}

function colourLabel(m: LabelManagerMedia): string {
  const fg = m.text ?? '?';
  const bg = m.background ?? '?';
  return `${fg} on ${bg}`;
}
</script>

<template>
  <SectionCard :step="3" title="Pick what's loaded" :state="sectionState">
    <p v-if="!hasIdentity" class="muted">
      Confirm the model first, then pick the loaded D1 cartridge.
    </p>

    <template v-else>
      <p>
        Pick what's loaded — drives the head dot count and the tape-type byte sent to the firmware.
        Labelmanager has no way to detect the cartridge automatically.
      </p>

      <div class="groups">
        <section v-for="g in widthGroups" :key="g.width" class="group">
          <button
            type="button"
            class="group-header"
            :aria-expanded="expandedWidths.has(g.width)"
            @click="toggleGroup(g.width)"
          >
            <span class="group-title">{{ g.width }} mm</span>
            <span class="group-hint"
              >{{ g.entries.length }} SKU{{ g.entries.length === 1 ? '' : 's' }} · head
              {{ g.headDots }} dots</span
            >
            <span class="group-caret">{{ expandedWidths.has(g.width) ? '−' : '+' }}</span>
          </button>

          <ul v-if="expandedWidths.has(g.width)" class="entries">
            <li v-for="m in g.entries" :key="String(m.id)">
              <button
                type="button"
                class="entry"
                :class="{ selected: media.id === m.id }"
                @click="pick(m)"
              >
                <span
                  class="swatch"
                  :title="colourLabel(m)"
                  :style="{
                    background: cssColour(m.background),
                    color: cssColour(m.text),
                    borderColor: cssColour(m.background) === 'transparent' ? '#888' : 'transparent',
                  }"
                  >Aa</span
                >
                <span class="entry-name">{{ m.name }}</span>
                <code class="entry-id">{{ m.id }}</code>
              </button>
            </li>
          </ul>
        </section>
      </div>

      <p class="muted small">
        Currently selected: <strong>{{ media.name }}</strong>
        <code class="inline-id">{{ media.id }}</code> — {{ colourLabel(media) }}, head emits
        <strong>{{ currentHeadDots }} dots</strong> across the tape.
      </p>
    </template>
  </SectionCard>
</template>

<style scoped>
.groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: var(--space-3) 0;
}

.group {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
}

.group-header {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  width: 100%;
  background: transparent;
  color: inherit;
  border: none;
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  text-align: left;
  font: inherit;
}

.group-header:hover {
  background: var(--bg-hover);
}

.group-title {
  font-weight: 600;
  font-size: 1rem;
}

.group-hint {
  flex: 1;
  font-size: 0.78rem;
  color: var(--fg-muted, var(--muted));
}

.group-caret {
  font-family: var(--font-mono);
  font-size: 1rem;
  width: 1em;
  text-align: center;
}

.entries {
  list-style: none;
  padding: 0 var(--space-2) var(--space-2);
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.entry {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition:
    border-color 100ms,
    background-color 100ms;
}

.entry:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}

.entry.selected {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-fg);
}

.swatch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  font-size: 0.7rem;
  font-weight: 700;
  flex: 0 0 auto;
}

.entry-name {
  flex: 1;
}

.entry-id {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  opacity: 0.75;
}

.entry.selected .entry-id {
  opacity: 0.9;
}

.inline-id {
  font-family: var(--font-mono);
  font-size: 0.78rem;
  margin-left: var(--space-1);
}

.small {
  font-size: 0.85rem;
}
</style>
