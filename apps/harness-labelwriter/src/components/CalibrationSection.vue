<script setup lang="ts">
/**
 * Printable-area calibration section (plan 08 §7a).
 *
 * Sits between Media and Print. Optional drawer; defaults closed.
 * When the operator opens it we fill the five inputs from
 * `getPrintableArea(engine, media)` / `getForcedTrailingFeedMm(engine)`
 * (zero on every LW engine in phase 1). Edits flow into the diagnostic
 * encoder via `state/session.ts#calibration` and into the submitted
 * report's `transports[].offsetCalibration` field as evidence.
 *
 * UI copy emphasises this is calibrating the operator's specific
 * printer + roll combination, not a registry mutation. The
 * AssessmentSection cross-references this section's overrides when
 * the operator picks `partial` / `unsupported` while having edited
 * values — see plan 08 §7a "Don't conflate margin mismatch with a
 * printer defect".
 */
import { computed, watch } from 'vue';
import { getPrintableArea, getForcedTrailingFeedMm } from '@thermal-label/contracts';
import { calibration, device, hasMedia, media } from '../state/session';
import SectionCard from './SectionCard.vue';

const sectionState = computed<'pending' | 'active' | 'done'>(() => {
  if (!hasMedia.value) return 'pending';
  // The section is informational; "done" once the drawer has been
  // surfaced or the operator has moved past it (i.e. printed). Keep
  // it `active` while media is picked but the drawer hasn't been
  // touched, so it stays visually live.
  return calibration.drawerOpen ? 'done' : 'active';
});

const engine = computed(() => device.value?.engines[0] ?? null);

// Resolve the engine defaults whenever device or media changes. The
// drawer reads these even when closed so the captioned "engine
// values" line stays accurate.
const engineDefaults = computed(() => {
  if (!engine.value) {
    return { leadingMm: 0, trailingMm: 0, leftMm: 0, rightMm: 0, forcedTrailingFeedMm: 0 };
  }
  const printableArea = getPrintableArea(engine.value, media.value ?? undefined);
  const forcedTrailingFeedMm = getForcedTrailingFeedMm(engine.value);
  return {
    leadingMm: printableArea.leading,
    trailingMm: printableArea.trailing,
    leftMm: printableArea.left,
    rightMm: printableArea.right,
    forcedTrailingFeedMm,
  };
});

// Mirror the latest defaults onto the session state so the encoder
// + report can read them. We update default-tracking fields even
// when the drawer is closed; the override-effective fields only
// snap to defaults until the operator edits.
watch(
  engineDefaults,
  next => {
    calibration.defaults = { ...next };
    if (!calibration.edited) {
      calibration.leadingMm = next.leadingMm;
      calibration.trailingMm = next.trailingMm;
      calibration.leftMm = next.leftMm;
      calibration.rightMm = next.rightMm;
      calibration.forcedTrailingFeedMm = next.forcedTrailingFeedMm;
    }
  },
  { immediate: true, deep: true },
);

function onFieldEdited(): void {
  calibration.edited = true;
}

function resetToDefaults(): void {
  calibration.leadingMm = engineDefaults.value.leadingMm;
  calibration.trailingMm = engineDefaults.value.trailingMm;
  calibration.leftMm = engineDefaults.value.leftMm;
  calibration.rightMm = engineDefaults.value.rightMm;
  calibration.forcedTrailingFeedMm = engineDefaults.value.forcedTrailingFeedMm;
  calibration.edited = false;
}

function openDrawer(): void {
  calibration.drawerOpen = true;
}

const allDefaultsZero = computed(() => {
  const d = engineDefaults.value;
  return (
    d.leadingMm === 0 &&
    d.trailingMm === 0 &&
    d.leftMm === 0 &&
    d.rightMm === 0 &&
    d.forcedTrailingFeedMm === 0
  );
});
</script>

<template>
  <SectionCard :step="4" title="Printable area (calibration — optional)" :state="sectionState">
    <p v-if="!hasMedia" class="muted">Pick a label first.</p>

    <template v-else>
      <p>
        Printers can't print all the way to the edge of the label — a few millimetres at the top,
        bottom, and sides are unreachable by the head. If your first print has empty borders or
        content shifted off the bottom, this is where you dial it in.
      </p>
      <p class="muted small">
        Phase 1: every LabelWriter engine ships with zero values here, so the diagnostic prints
        exactly what you author. Adjust below to match your specific printer + roll, then re-print
        until the borders look right. Your values ride along on the report so the maintainer can
        fold confirmed measurements into the registry.
      </p>

      <button v-if="!calibration.drawerOpen" class="ghost" type="button" @click="openDrawer">
        Adjust printable area
      </button>

      <div v-else class="form">
        <div class="grid">
          <label>
            Leading edge (mm)
            <input
              v-model.number="calibration.leadingMm"
              type="number"
              min="0"
              step="0.1"
              @input="onFieldEdited"
            />
            <span class="default-hint">engine default: {{ engineDefaults.leadingMm }}</span>
          </label>
          <label>
            Trailing edge (mm)
            <input
              v-model.number="calibration.trailingMm"
              type="number"
              min="0"
              step="0.1"
              @input="onFieldEdited"
            />
            <span class="default-hint">engine default: {{ engineDefaults.trailingMm }}</span>
          </label>
          <label>
            Left edge (mm)
            <input
              v-model.number="calibration.leftMm"
              type="number"
              min="0"
              step="0.1"
              @input="onFieldEdited"
            />
            <span class="default-hint">engine default: {{ engineDefaults.leftMm }}</span>
          </label>
          <label>
            Right edge (mm)
            <input
              v-model.number="calibration.rightMm"
              type="number"
              min="0"
              step="0.1"
              @input="onFieldEdited"
            />
            <span class="default-hint">engine default: {{ engineDefaults.rightMm }}</span>
          </label>
          <label>
            Forced trailing feed (mm)
            <input
              v-model.number="calibration.forcedTrailingFeedMm"
              type="number"
              min="0"
              step="0.1"
              @input="onFieldEdited"
            />
            <span class="default-hint"
              >engine default: {{ engineDefaults.forcedTrailingFeedMm }}</span
            >
          </label>
        </div>

        <div class="actions">
          <button v-if="calibration.edited" class="ghost" type="button" @click="resetToDefaults">
            Reset to engine defaults
          </button>
          <span v-else-if="allDefaultsZero" class="muted small">
            Engine defaults are all zero (phase 1). Type non-zero values to see the dead-zone
            overlays in the print preview.
          </span>
        </div>

        <p class="muted small">
          Leading / trailing are measured in the feed direction; left / right are across the head.
          Forced trailing feed is post-print tape advance (not used on LabelWriter today — variable
          form-feed).
        </p>
      </div>
    </template>
  </SectionCard>
</template>

<style scoped>
.form {
  margin-top: var(--space-3);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr));
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.grid label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: 0.9rem;
}

.grid input {
  width: 100%;
  font-family: inherit;
  padding: 0.25rem 0.4rem;
}

.default-hint {
  font-size: 0.72rem;
  color: var(--muted);
}

.actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-2);
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

.small {
  font-size: 0.85rem;
}
</style>
