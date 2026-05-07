<script setup lang="ts">
/**
 * Section card — the fundamental layout unit of the single-page UX.
 *
 * Each section stacks vertically with a subtle border. Sections are
 * either `pending` (greyed; visible but disabled), `active` (current
 * focus, full colour) or `done` (completed; still visible and
 * editable). No "next/back" stepper; the operator scrolls.
 *
 * `Advanced` controls slot in via a `<details>` block at the bottom
 * of the card; collapsed by default.
 */
defineProps<{
  /** 1-based section number, rendered in the header pill. */
  step: number;
  /** Section title — short, friendly. */
  title: string;
  /** Visual + interaction state. */
  state: 'pending' | 'active' | 'done';
}>();
</script>

<template>
  <section class="card" :data-state="state">
    <header class="card-header">
      <span class="step" aria-hidden="true">{{ step }}</span>
      <h2 class="card-title">{{ title }}</h2>
      <span v-if="state === 'done'" class="badge done" aria-label="completed">done</span>
      <span v-else-if="state === 'pending'" class="badge pending" aria-label="not yet active"
        >waiting</span
      >
    </header>
    <div class="card-body">
      <slot />
    </div>
    <div v-if="$slots.advanced" class="card-advanced">
      <details>
        <summary>▸ Advanced</summary>
        <div class="advanced-body">
          <slot name="advanced" />
        </div>
      </details>
    </div>
  </section>
</template>

<style scoped>
.card {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin: var(--space-4) 0;
  padding: var(--space-5);
  box-shadow: var(--shadow-sm);
  transition:
    border-color 150ms,
    opacity 150ms;
}

.card[data-state='pending'] {
  opacity: 0.55;
}

.card[data-state='active'] {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-md);
}

.card-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.step {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-fg);
  font-size: 0.85rem;
  font-weight: 600;
}

.card[data-state='pending'] .step {
  background: var(--border-strong);
  color: var(--bg-elev);
}

.card-title {
  flex: 1;
}

.badge {
  font-size: 0.75rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-weight: 600;
}

.badge.done {
  background: var(--ok-bg);
  color: var(--ok);
}

.badge.pending {
  background: var(--bg);
  color: var(--fg-faint);
  border: 1px solid var(--border);
}

.card-body :deep(p) {
  margin-bottom: var(--space-3);
}

.card-advanced {
  margin-top: var(--space-4);
  border-top: 1px dashed var(--border);
  padding-top: var(--space-3);
  font-size: 0.92rem;
}

.card-advanced summary {
  cursor: pointer;
  color: var(--fg-muted);
  user-select: none;
}

.card-advanced summary:hover {
  color: var(--fg);
}

.advanced-body {
  margin-top: var(--space-3);
  padding-left: var(--space-2);
}
</style>
