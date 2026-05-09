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
import type { PrintEngine } from '@thermal-label/contracts';
import { badgeFor, useSession } from '../state/session';

const session = useSession();

const tabs = computed(() => {
  const dev = session.device.value as { engines?: readonly PrintEngine[] } | null;
  if (!dev || !Array.isArray(dev.engines)) return [];
  return dev.engines.map(engine => {
    const slot = session.engineSessions[engine.role];
    return {
      role: engine.role,
      protocol: engine.protocol,
      badge: badgeFor(slot),
    };
  });
});

function activate(role: string): void {
  session.selectedRole.value = role;
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
  <nav id="engine-tabs" class="engine-tabs" aria-label="Engines">
    <p class="tabs-hint">
      This printer has <strong>{{ tabs.length }} engines</strong> — pick what to test below. You can
      come back to the other one later; partial reports help too.
    </p>
    <div class="tab-strip" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.role"
        type="button"
        role="tab"
        :class="['tab', `badge-${tab.badge}`, { active: session.selectedRole.value === tab.role }]"
        :aria-current="session.selectedRole.value === tab.role ? 'page' : undefined"
        :aria-selected="session.selectedRole.value === tab.role"
        @click="activate(tab.role)"
      >
        <span class="badge" aria-hidden="true">{{ badgeGlyph(tab.badge) }}</span>
        <span class="tab-body">
          <span class="role">{{ tab.role }}</span>
          <span class="protocol">{{ tab.protocol }}</span>
        </span>
      </button>
    </div>
  </nav>
</template>

<style scoped>
.engine-tabs {
  margin: var(--space-5) 0 var(--space-4);
  padding: var(--space-4);
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.tabs-hint {
  margin: 0 0 var(--space-3);
  font-size: 0.92rem;
  color: var(--fg-muted, var(--muted));
}

.tab-strip {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-3);
  background: var(--bg);
  color: var(--fg);
  border: 2px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-3) var(--space-4);
  font-size: 1rem;
  cursor: pointer;
  transition:
    border-color 120ms,
    transform 120ms,
    box-shadow 120ms;
  flex: 1 1 12rem;
  min-width: 12rem;
  text-align: left;
}

.tab:hover {
  border-color: var(--border-strong);
}

.tab.active {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-fg);
  box-shadow: var(--shadow-sm);
}

.tab.active .protocol {
  color: var(--accent-fg);
  opacity: 0.85;
}

.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.8rem;
  height: 1.8rem;
  border-radius: 50%;
  background: var(--bg-elev);
  font-family: var(--font-mono);
  font-size: 1.05rem;
  font-weight: 700;
  flex: 0 0 auto;
}

.tab.active .badge {
  background: var(--accent-fg);
  color: var(--accent);
}

.badge-done .badge {
  color: var(--ok);
}

.badge-in-progress .badge {
  color: var(--warn);
}

.badge-empty .badge {
  color: var(--fg-faint, var(--muted));
}

.tab.active.badge-done .badge {
  color: var(--ok);
}

.tab-body {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.role {
  text-transform: capitalize;
  font-weight: 600;
  font-size: 1.05rem;
}

.protocol {
  font-size: 0.75rem;
  font-family: var(--font-mono);
  color: var(--fg-muted, var(--muted));
  letter-spacing: 0.02em;
}
</style>
