<script setup lang="ts">
/**
 * Assessment section — three radios + an optional notes textarea.
 *
 * Captures the operator's direct verdict on what came out of the
 * printer. This is the rung that lands on `TransportReport.rung` in
 * the issue body. The notes textarea is optional — many reports will
 * leave it empty; that's fine.
 */
import { computed } from 'vue';
import { assessment, calibration, hasAssessment, hasPrinted } from '../state/session';
import SectionCard from './SectionCard.vue';

const sectionState = computed<'pending' | 'active' | 'done'>(() => {
  if (!hasPrinted.value) return 'pending';
  if (!hasAssessment.value) return 'active';
  return 'done';
});

const choices = [
  {
    value: 'verified',
    title: 'Looks right',
    blurb: 'Print is legible, density is even, no glaring artefacts.',
  },
  {
    value: 'partial',
    title: 'Works but with caveats',
    blurb:
      'Something the printer itself produces wrong — faint output, dropped rows, jammed cuts. ' +
      "An empty border at the top or bottom is NOT partial: that's the head's mechanical reach. " +
      'Use the calibration section above to dial in offsets, then re-print.',
  },
  {
    value: 'unsupported',
    title: 'Not usable',
    blurb:
      'Bytes went out, but the printer produced nothing the user could ship. Same caveat as ' +
      'partial — empty borders are calibration, not a defect.',
  },
] as const;

/**
 * Soft check (plan 08 §7a): the operator picked partial /
 * unsupported AND adjusted the calibration overrides this run. Show
 * an inline FYI prompting them to confirm the rung reflects an
 * actual defect, not a calibration mismatch. Easy to dismiss;
 * visible enough to catch the noisy case.
 */
const showCalibrationFyi = computed(
  () => calibration.edited && (assessment.rung === 'partial' || assessment.rung === 'unsupported'),
);
</script>

<template>
  <SectionCard :step="6" title="What does it look like?" :state="sectionState">
    <p v-if="!hasPrinted" class="muted">Print the diagnostic first, then come back here.</p>

    <template v-else>
      <p>Pick the option that best matches the print you're holding.</p>

      <p class="assist small">
        If the only thing wrong is empty space at the edges, your printer is fine — adjust the
        offsets in the calibration section above and print again before submitting.
      </p>

      <div class="radios">
        <label v-for="c in choices" :key="c.value" class="radio">
          <input v-model="assessment.rung" type="radio" :value="c.value" />
          <span class="radio-body">
            <strong>{{ c.title }}</strong>
            <span class="muted small">{{ c.blurb }}</span>
          </span>
        </label>
      </div>

      <p v-if="showCalibrationFyi" class="fyi small">
        FYI: you adjusted offset values in the calibration section — confirm the chosen rung
        reflects an actual printer defect (faint output, dropped rows, jammed cuts), not a
        calibration mismatch (empty borders or content shifted off an edge). Margin-only complaints
        belong on the calibration loop.
      </p>

      <label class="notes">
        Notes (optional)
        <textarea
          v-model="assessment.notes"
          rows="3"
          placeholder="e.g. left edge clipped by 2 dots; density uneven on the lower half; trailing marker landed 5 mm short"
        />
      </label>
    </template>
  </SectionCard>
</template>

<style scoped>
.radios {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.radio {
  display: flex;
  gap: var(--space-3);
  align-items: flex-start;
  cursor: pointer;
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition: border-color 100ms;
}

.radio:hover {
  border-color: var(--border-strong);
}

.radio input[type='radio']:checked ~ .radio-body strong {
  color: var(--accent);
}

.radio input[type='radio'] {
  margin-top: 0.25rem;
}

.radio-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.small {
  font-size: 0.88rem;
}

.notes {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-4);
  font-size: 0.9rem;
}

.notes textarea {
  font-family: inherit;
  resize: vertical;
  min-height: 4rem;
}

.assist {
  background: var(--bg-elevated, var(--bg));
  border-left: 3px solid var(--accent);
  padding: var(--space-2) var(--space-3);
  margin: var(--space-3) 0;
  color: var(--fg-muted, var(--muted));
}

.fyi {
  background: var(--warn-bg, var(--bg-elevated, var(--bg)));
  border-left: 3px solid var(--warn, var(--accent));
  color: var(--warn, var(--fg));
  padding: var(--space-2) var(--space-3);
  margin-top: var(--space-3);
}
</style>
