<script setup lang="ts">
/**
 * Per-transport connect buttons — plan 11 §Connect-section UI.
 *
 * Renders one button per browser-reachable `TransportType` declared
 * by any device in the driver's registry. `tcp` is filtered out
 * (browsers can't open raw sockets). Labels match the plan's table:
 *
 *   usb              → "Connect via USB"
 *   serial           → "Connect via Serial"
 *   bluetooth-spp    → "Connect via Serial"   (Web Serial under the hood)
 *   bluetooth-gatt   → "Connect via Bluetooth"
 *
 * Operators don't need to distinguish "Serial" from
 * "Bluetooth-SPP-via-Serial" — Web Serial is the underlying tech
 * for both. Single-transport drivers stay single-button.
 *
 * The "Not sure how to connect?" link below the buttons points at
 * the docs-site help page; URL pattern is documented in the plan
 * (not all pages exist yet — link is rails-not-walls).
 */
import { computed } from 'vue';
import type { BrowserTransport } from '../types';

const props = defineProps<{
  /**
   * Browser-reachable transports the driver's registry declares.
   * Order is preserved — registry insertion order is the
   * recommended-first hint per the plan's "what order?" open
   * question.
   */
  transports: readonly BrowserTransport[];
  /** True while a connect call is in flight; disables every button. */
  busy: boolean;
  /**
   * Stable driver-key used to build the help-page URL on the docs
   * site (`https://thermal-label.github.io/help/connect/<key>/`).
   */
  driverKey: string;
}>();

const emit = defineEmits<{
  (e: 'connect', transport: BrowserTransport): void;
}>();

interface ButtonSpec {
  transport: BrowserTransport;
  label: string;
}

const BUTTON_LABELS: Readonly<Record<BrowserTransport, string>> = {
  usb: 'Connect via USB',
  serial: 'Connect via Serial',
  'bluetooth-spp': 'Connect via Serial',
  'bluetooth-gatt': 'Connect via Bluetooth',
};

const buttons = computed<readonly ButtonSpec[]>(() =>
  props.transports.map(t => ({ transport: t, label: BUTTON_LABELS[t] })),
);

const helpHref = computed(
  () => `https://thermal-label.github.io/help/connect/${props.driverKey}/`,
);
</script>

<template>
  <div class="transport-buttons">
    <div v-if="buttons.length === 0" class="muted small">
      No browser-reachable transports for this driver.
    </div>
    <button
      v-for="b in buttons"
      :key="b.transport"
      class="primary"
      :disabled="busy"
      :data-transport="b.transport"
      @click="emit('connect', b.transport)"
    >
      {{ busy ? 'Connecting…' : b.label }}
    </button>
    <a class="help-link" :href="helpHref" target="_blank" rel="noopener">
      Not sure how to connect? →
    </a>
  </div>
</template>

<style scoped>
.transport-buttons {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
}

.primary {
  background: var(--accent);
  color: var(--accent-fg);
  border: none;
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-5);
  font-weight: 600;
  font-size: 0.95rem;
}

.primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.help-link {
  font-size: 0.9rem;
  color: var(--fg-muted);
}

.muted {
  color: var(--fg-muted);
}

.small {
  font-size: 0.85rem;
}
</style>
