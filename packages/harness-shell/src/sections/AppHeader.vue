<script setup lang="ts">
/**
 * Page header — brand on the left, theme toggle on the right.
 *
 * `app-name` reads `adapter.driverDisplayName` so the same component
 * renders "LabelManager harness", "LabelWriter harness",
 * "Brother QL harness" — one place to change the format.
 */
import { useTheme } from '../composables/useTheme';
import { useAdapter } from '../state/adapterContext';

const adapter = useAdapter();
const { theme, toggleTheme } = useTheme();
</script>

<template>
  <header class="header">
    <div class="title">
      <span class="brand">thermal-label</span>
      <span class="sep">·</span>
      <span class="app-name">{{ adapter.driverDisplayName }} harness</span>
    </div>
    <button
      class="theme-toggle"
      type="button"
      :aria-label="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
      @click="toggleTheme"
    >
      <span v-if="theme === 'dark'" aria-hidden="true">☀</span>
      <span v-else aria-hidden="true">☾</span>
    </button>
  </header>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4) var(--space-5);
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}

.title {
  font-size: 0.95rem;
  letter-spacing: 0.01em;
}

.brand {
  font-weight: 600;
}

.sep {
  margin: 0 var(--space-2);
  color: var(--fg-faint);
}

.app-name {
  color: var(--fg-muted);
}

.theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--bg);
  color: var(--fg);
  font-size: 1.1rem;
  line-height: 1;
  transition:
    background-color 120ms,
    border-color 120ms;
}

.theme-toggle:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}
</style>
