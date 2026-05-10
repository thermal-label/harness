<script setup lang="ts">
/**
 * Tiny traffic-light status pill — coloured dot + short label.
 *
 * Used in section card headers (`SectionCard`'s `header-aside` slot)
 * to surface live printer state next to the title:
 *  - section "Connect" gets a printer-ready pill
 *  - section "Pick what's loaded" gets a media-loaded pill
 *
 * State is a simple traffic-light enum:
 *  - `unknown` — grey (no read yet, or transport hiccup)
 *  - `good`    — green
 *  - `warn`    — amber (e.g. tape supply low, head warm but printable)
 *  - `bad`     — red (no media, paper jam, busy)
 *
 * Caller supplies the label text. The component is colour-only +
 * tooltip; no semantics live here.
 */
defineProps<{
  state: 'unknown' | 'good' | 'warn' | 'bad';
  label: string;
}>();
</script>

<template>
  <span class="status-pill" :class="`s-${state}`" :title="label">
    <span class="dot" />
    <span class="label">{{ label }}</span>
  </span>
</template>

<style scoped>
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg-muted, var(--muted));
  font-size: 0.78rem;
  font-weight: 500;
  white-space: nowrap;
}

.dot {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  background: currentColor;
  flex: 0 0 auto;
}

.s-good {
  color: var(--ok, #1d8a40);
  border-color: currentColor;
}
.s-warn {
  color: var(--warn, #b07700);
  border-color: currentColor;
}
.s-bad {
  color: var(--error, #b22020);
  border-color: currentColor;
}
.s-unknown {
  color: var(--fg-muted, #8a8a8a);
}

/* Pulse the dot in the unknown state so the pill reads as
   "pending / probing" rather than "no idea". */
.s-unknown .dot {
  animation: status-pill-pulse 1.4s ease-in-out infinite;
}

@keyframes status-pill-pulse {
  0%,
  100% {
    opacity: 0.4;
  }
  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .s-unknown .dot {
    animation: none;
  }
}
</style>
