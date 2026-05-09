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
import { activeSession, device, engineSessions, selectedRole } from '../state/session';
import SectionCard from './SectionCard.vue';

const sectionState = computed<'pending' | 'active' | 'done'>(() => {
  const s = activeSession.value;
  if (!s || !s.printed) return 'pending';
  if (s.rung === null) return 'active';
  return 'done';
});

const hasPrinted = computed(() => Boolean(activeSession.value?.printed));

// ─── Multi-engine "now do the other one" CTA ──────────────────────

const isMultiEngine = computed(() => (device.value?.engines.length ?? 0) > 1);

/**
 * Next engine that hasn't been assessed yet, ranked after the
 * currently-active one. Returns `null` when there's no other engine
 * left to test (single-engine device, or every other engine already
 * has a rung). Drives the CTA at the bottom of this section.
 */
const nextUnassessedRole = computed<string | null>(() => {
  const dev = device.value;
  if (!dev) return null;
  const current = selectedRole.value;
  for (const eng of dev.engines) {
    if (eng.role === current) continue;
    const session = engineSessions[eng.role];
    if (session && session.rung !== null) continue;
    return eng.role;
  }
  return null;
});

function switchToNextEngine(): void {
  const next = nextUnassessedRole.value;
  if (!next) return;
  selectedRole.value = next;
  // Scroll back up to the engine tabs so the operator sees the
  // change of context — the page jumping into a new tab without
  // visual continuity is jarring.
  setTimeout(() => {
    document.getElementById('engine-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 50);
}

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

    <template v-else-if="activeSession">
      <p>Pick the option that best matches the print you're holding.</p>

      <div class="radios">
        <label v-for="c in choices" :key="c.value" class="radio">
          <input v-model="activeSession.rung" type="radio" :value="c.value" />
          <span class="radio-body">
            <strong>{{ c.title }}</strong>
            <span class="muted small">{{ c.blurb }}</span>
          </span>
        </label>
      </div>

      <label class="notes">
        Notes (optional)
        <textarea
          v-model="activeSession.notes"
          rows="3"
          placeholder="e.g. left edge clipped by 2 dots; density uneven on the lower half; trailing marker landed 5 mm short"
        />
      </label>

      <!-- Multi-engine "rails not walls" CTA: when this engine has a
           rung set and there's another engine left to test, offer
           the switch. Operator can ignore it and submit a partial
           report instead — the Submit card adapts copy + matrix
           cell goes amber. -->
      <div
        v-if="isMultiEngine && activeSession.rung !== null && nextUnassessedRole"
        class="next-engine-cta"
      >
        <p class="cta-blurb">
          You can also test the <strong>{{ nextUnassessedRole }}</strong> engine on this printer.
          Both engines on one report = one fully verified cell. Skip if you want — partial reports
          help too.
        </p>
        <button class="cta-button" type="button" @click="switchToNextEngine">
          Now test the {{ nextUnassessedRole }} engine →
        </button>
      </div>
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

.next-engine-cta {
  margin-top: var(--space-5);
  padding: var(--space-4);
  background: var(--bg-elev);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  align-items: flex-start;
}

.cta-blurb {
  margin: 0;
  font-size: 0.92rem;
  color: var(--fg-muted, var(--muted));
}

.cta-blurb strong {
  text-transform: capitalize;
  color: var(--fg);
}

.cta-button {
  background: var(--accent);
  color: var(--accent-fg);
  border: none;
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-4);
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  text-transform: capitalize;
}

.cta-button:hover {
  background: var(--accent-hover);
}
</style>
