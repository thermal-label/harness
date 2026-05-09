<script setup lang="ts">
/**
 * Assessment section — three radios + an optional notes textarea.
 *
 * Captures the operator's direct verdict on what came out of the
 * printer. This is the rung that lands on `TransportReport.rung` in
 * the issue body. The notes textarea is optional — many reports will
 * leave it empty; that's fine.
 *
 * Reads the active engine session — single-engine devices have one
 * session; multi-engine devices route into this same component per
 * tab. The active session's `rung` and `notes` are the v-model
 * targets.
 */
import { computed } from 'vue';
import { useSession } from '../state/session';
import SectionCard from './SectionCard.vue';

const session = useSession();

const sectionState = computed<'pending' | 'active' | 'done'>(() => {
  const s = session.activeSession.value;
  if (!s || !s.printed) return 'pending';
  if (s.rung === null) return 'active';
  return 'done';
});

const hasPrinted = computed(() => Boolean(session.activeSession.value?.printed));

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
      "An empty border at the top or bottom is NOT partial: that's the head's mechanical reach " +
      "(the preview shows where it lands). Authoring around it is the user's job, not the driver's.",
  },
  {
    value: 'unsupported',
    title: 'Not usable',
    blurb:
      'Bytes went out, but the printer produced nothing the user could ship. Empty borders are ' +
      'expected chassis geometry — not a defect.',
  },
] as const;
</script>

<template>
  <SectionCard :step="4" title="What does it look like?" :state="sectionState">
    <p v-if="!hasPrinted" class="muted">Print the diagnostic first, then come back here.</p>

    <template v-else-if="session.activeSession.value">
      <p>Pick the option that best matches the print you're holding.</p>

      <div class="radios">
        <label v-for="c in choices" :key="c.value" class="radio">
          <input v-model="session.activeSession.value.rung" type="radio" :value="c.value" />
          <span class="radio-body">
            <strong>{{ c.title }}</strong>
            <span class="muted small">{{ c.blurb }}</span>
          </span>
        </label>
      </div>

      <label class="notes">
        Notes (optional)
        <textarea
          v-model="session.activeSession.value.notes"
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
</style>
