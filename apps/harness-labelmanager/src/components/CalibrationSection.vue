<script setup lang="ts">
/**
 * Printable-area calibration section (plan 08 §7a).
 *
 * Sits between Tape and Print. Optional drawer; defaults closed.
 * When the operator opens it we fill the five inputs from
 * `getPrintableArea(engine)` / `getForcedTrailingFeedMm(engine)` —
 * for labelmanager these are populated (8 mm leading + 8 mm forced
 * trailing feed) per plan-08 phase 2. Edits flow into the diagnostic
 * encoder via `state/session.ts#calibration` (option (b): the
 * encoder synthesises an "effective engine" from these values) and
 * into the submitted report's `transports[].offsetCalibration`
 * field as evidence.
 *
 * Labelmanager-specific copy: leading + forced-trailing-feed are
 * load-bearing on this driver (the encoder pads white rows top +
 * bottom), unlike labelwriter where forced-trailing-feed is
 * informational. The cross-feed (left/right) values ride along on
 * the report but the encoder doesn't act on them today — the head
 * is centred on the cartridge by construction.
 */
import { computed, watch } from 'vue';
import { getPrintableArea, getForcedTrailingFeedMm } from '@thermal-label/contracts';
import { calibration, device, hasTape } from '../state/session';
import SectionCard from './SectionCard.vue';

const sectionState = computed<'pending' | 'active' | 'done'>(() => {
  if (!hasTape.value) return 'pending';
  return calibration.drawerOpen ? 'done' : 'active';
});

const engine = computed(() => device.value?.engines[0] ?? null);

// Resolve the engine defaults whenever device changes. The drawer
// reads these even when closed so the captioned "engine values"
// line stays accurate.
const engineDefaults = computed(() => {
  if (!engine.value) {
    return { leadingMm: 0, trailingMm: 0, leftMm: 0, rightMm: 0, forcedTrailingFeedMm: 0 };
  }
  const printableArea = getPrintableArea(engine.value);
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
</script>

<template>
  <SectionCard :step="4" title="Printable area (calibration — optional)" :state="sectionState">
    <p v-if="!hasTape" class="muted">Pick the tape width first.</p>

    <template v-else>
      <p>
        Labelmanager pads the leading + trailing edge of every print: the head sits roughly 8 mm
        past the cutter slot, so the chassis blanks the first 8 mm of tape and feeds another 8 mm
        out after printing so the operator can pull the printed strip clear of the cutter.
      </p>
      <p class="muted small">
        These values are populated for every labelmanager engine (8 mm / 8 mm). Adjust below if your
        chassis behaves differently — your values flow into the encoder so the next print recomputes
        the leading/trailing pad, and ride along on the report so the maintainer can fold confirmed
        measurements into the registry.
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
        </div>

        <p class="muted small">
          Leading / trailing are measured along the tape feed direction. Cross-feed (left / right)
          is informational on labelmanager — the head is centred on the cartridge — but rides on the
          report so the maintainer's triage runbook has the same shape across drivers. Forced
          trailing feed is the post-print tape advance the encoder appends so the printed strip
          clears the cutter.
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
