<script setup lang="ts">
/**
 * Tape-width picker.
 *
 * D1 cartridges come in 6 / 9 / 12 / 19 mm. Default 12 mm — the
 * maintainer's bench tape and the most common width. Each choice
 * surfaces the head dot count for triage context (the diagnostic
 * encoder maps tape → head dot count: 32/48/64/64).
 *
 * Labelmanager has no NFC roll-tag detection (the chassis doesn't
 * read cartridge IDs in any documented protocol), so this is always
 * a manual pick. Selecting nothing is impossible — the picker
 * always carries a default — so the section state oscillates
 * between `active` (operator hasn't touched it) and `done` (touched
 * or default kept), driven by a touched flag.
 */
import { computed, ref } from 'vue';
import type { TapeWidth } from '@thermal-label/labelmanager-core';
import { hasIdentity, tapeWidth } from '../state/session';
import SectionCard from './SectionCard.vue';

const touched = ref(false);

const sectionState = computed<'pending' | 'active' | 'done'>(() => {
  if (!hasIdentity.value) return 'pending';
  return touched.value ? 'done' : 'active';
});

interface TapeOption {
  width: TapeWidth;
  label: string;
  headDots: number;
}

const TAPE_OPTIONS: readonly TapeOption[] = [
  { width: 6, label: '6 mm', headDots: 32 },
  { width: 9, label: '9 mm', headDots: 48 },
  { width: 12, label: '12 mm', headDots: 64 },
  { width: 19, label: '19 mm', headDots: 64 },
];

function pick(width: TapeWidth): void {
  tapeWidth.value = width;
  touched.value = true;
}

const currentHeadDots = computed(
  () => TAPE_OPTIONS.find(o => o.width === tapeWidth.value)?.headDots ?? 64,
);
</script>

<template>
  <SectionCard :step="3" title="Pick the tape width" :state="sectionState">
    <p v-if="!hasIdentity" class="muted">Confirm the model first, then pick the loaded tape.</p>

    <template v-else>
      <p>
        D1 cartridges come in four widths. Pick the one currently loaded — labelmanager has no way
        to detect the cartridge automatically.
      </p>

      <div class="options">
        <button
          v-for="o in TAPE_OPTIONS"
          :key="o.width"
          type="button"
          class="option"
          :class="{ selected: tapeWidth === o.width }"
          @click="pick(o.width)"
        >
          <span class="option-label">{{ o.label }}</span>
          <span class="option-hint">head: {{ o.headDots }} dots</span>
        </button>
      </div>

      <p class="muted small">
        Currently selected: <strong>{{ tapeWidth }} mm</strong>, head emits
        <strong>{{ currentHeadDots }} dots</strong> across the tape. The diagnostic encoder sizes
        the bitmap to that.
      </p>
    </template>
  </SectionCard>
</template>

<style scoped>
.options {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin: var(--space-3) 0;
}

.option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-3) var(--space-4);
  min-width: 5rem;
  cursor: pointer;
  transition:
    border-color 100ms,
    background-color 100ms;
}

.option:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}

.option.selected {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-fg);
}

.option-label {
  font-size: 1rem;
  font-weight: 600;
}

.option-hint {
  font-size: 0.72rem;
  opacity: 0.85;
}

.small {
  font-size: 0.85rem;
}
</style>
