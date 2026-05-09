<script setup lang="ts">
/**
 * Multi-engine tab strip.
 *
 * Renders one tab per engine declared on the connected device (LW
 * Twin: `left` / `right`; LW Duo: `label` / `tape`). Clicking a tab
 * flips `selectedRole`, which re-points the Media / Print /
 * Assessment sections at that engine's session slot. Selection is
 * non-destructive — the operator's media + print + assessment per
 * engine accumulate in `engineSessions`.
 *
 * Plan 09: tabs are visible ONLY on multi-engine devices. Single-
 * engine devices skip this component entirely so a 6-LW renders the
 * flat flow with no extra chrome.
 *
 * Tab badges:
 *   - `·` (empty) — operator hasn't picked media yet.
 *   - `…` (in-progress) — media picked, print sent, but no rung.
 *   - `✓` (done) — rung set; engine is fully reported.
 */
import { computed } from 'vue';
import { badgeFor, device, engineSessions, selectedRole } from '../state/session';

const tabs = computed(() => {
  if (!device.value) return [];
  return device.value.engines.map(engine => {
    const session = engineSessions[engine.role];
    return {
      role: engine.role,
      protocol: engine.protocol,
      badge: badgeFor(session),
    };
  });
});

function activate(role: string): void {
  selectedRole.value = role;
}

function badgeGlyph(badge: 'empty' | 'in-progress' | 'done'): string {
  switch (badge) {
    case 'done':
      return '✓';
    case 'in-progress':
      return '…';
    default:
      return '·';
  }
}
</script>

<template>
  <nav class="engine-tabs" aria-label="Engines">
    <button
      v-for="tab in tabs"
      :key="tab.role"
      type="button"
      :class="['tab', `badge-${tab.badge}`, { active: selectedRole === tab.role }]"
      :aria-current="selectedRole === tab.role ? 'page' : undefined"
      @click="activate(tab.role)"
    >
      <span class="badge" aria-hidden="true">{{ badgeGlyph(tab.badge) }}</span>
      <span class="role">{{ tab.role }}</span>
      <span class="protocol muted">{{ tab.protocol }}</span>
    </button>
  </nav>
</template>

<style scoped>
.engine-tabs {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
  margin: var(--space-4) 0 var(--space-3);
  border-bottom: 1px solid var(--border);
  padding-bottom: var(--space-2);
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  font-size: 0.92rem;
  cursor: pointer;
  transition: border-color 100ms;
}

.tab:hover {
  border-color: var(--border-strong);
}

.tab.active {
  border-color: var(--accent);
  background: var(--accent-bg, var(--bg));
  font-weight: 600;
}

.badge {
  font-family: var(--font-mono);
  font-size: 1rem;
  width: 1.25rem;
  text-align: center;
}

.badge-done .badge {
  color: var(--ok);
}

.badge-in-progress .badge {
  color: var(--warn);
}

.badge-empty .badge {
  color: var(--fg-faint);
}

.role {
  text-transform: capitalize;
}

.protocol {
  font-size: 0.78rem;
  font-family: var(--font-mono);
}
</style>
