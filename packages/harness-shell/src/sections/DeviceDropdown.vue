<script setup lang="ts">
/**
 * Operator-confirmation dropdown — plan 11 §Connect-section UI.
 *
 * Shown when the driver-web factory throws
 * `DeviceIdentificationRequiredError` and hands back a list of
 * candidate `DeviceEntry`s pre-filtered by transport. The operator
 * picks one; the parent calls `err.continueWith(deviceKey)` with
 * the chosen key. The already-opened port/device is held in the
 * closure — no second picker open.
 *
 * Subtitle shows `transports[transport].namePrefix` when present
 * (per plan: helps the operator correlate the in-app option with
 * the OS-level name shown in the browser picker).
 */
import { computed, ref } from 'vue';
import type { BrowserTransport } from '../types';

interface DeviceCandidate {
  key: string;
  name: string;
  transports: {
    usb?: { vid: string; pid: string };
    'bluetooth-gatt'?: { namePrefix?: string; serviceUuid: string };
    'bluetooth-spp'?: { namePrefix?: string };
    serial?: { defaultBaud: number };
  };
}

const props = defineProps<{
  /** Candidate registry entries — comes straight from `err.candidates`. */
  candidates: readonly DeviceCandidate[];
  /** Transport the parent dispatched on — drives subtitle copy. */
  transport: BrowserTransport;
}>();

const emit = defineEmits<{
  (e: 'pick', deviceKey: string): void;
  (e: 'cancel'): void;
}>();

const selected = ref<string>(props.candidates[0]?.key ?? '');

function subtitleFor(c: DeviceCandidate): string | null {
  if (props.transport === 'bluetooth-gatt') {
    return c.transports['bluetooth-gatt']?.namePrefix ?? null;
  }
  if (props.transport === 'bluetooth-spp') {
    return c.transports['bluetooth-spp']?.namePrefix ?? null;
  }
  if (props.transport === 'usb') {
    const u = c.transports.usb;
    return u ? `vid ${u.vid} · pid ${u.pid}` : null;
  }
  if (props.transport === 'serial') {
    const s = c.transports.serial;
    return s ? `${String(s.defaultBaud)} baud` : null;
  }
  return null;
}

const items = computed(() =>
  props.candidates.map(c => ({
    key: c.key,
    name: c.name,
    subtitle: subtitleFor(c),
  })),
);

function confirm(): void {
  if (selected.value) emit('pick', selected.value);
}
</script>

<template>
  <div class="dropdown-card">
    <p class="lead">
      The connection succeeded but the harness couldn't tell which model
      you picked. Confirm so it can drive the right protocol.
    </p>
    <ul class="candidates">
      <li v-for="item in items" :key="item.key">
        <label>
          <input
            type="radio"
            name="device-pick"
            :value="item.key"
            v-model="selected"
          />
          <span class="name">{{ item.name }}</span>
          <span v-if="item.subtitle" class="subtitle"> {{ item.subtitle }}</span>
        </label>
      </li>
    </ul>
    <div class="actions">
      <button class="primary" :disabled="!selected" @click="confirm">
        Use this one
      </button>
      <button class="ghost" type="button" @click="emit('cancel')">
        Cancel
      </button>
    </div>
  </div>
</template>

<style scoped>
.dropdown-card {
  background: var(--bg-elevated, var(--bg));
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-4);
  margin-top: var(--space-3);
}

.lead {
  margin: 0 0 var(--space-3) 0;
  font-size: 0.95rem;
}

.candidates {
  list-style: none;
  padding: 0;
  margin: 0 0 var(--space-3) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.candidates label {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  cursor: pointer;
}

.name {
  font-weight: 600;
}

.subtitle {
  color: var(--fg-muted);
  font-family: var(--font-mono);
  font-size: 0.85rem;
}

.actions {
  display: flex;
  gap: var(--space-3);
}

.primary {
  background: var(--accent);
  color: var(--accent-fg);
  border: none;
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-4);
  font-weight: 600;
  font-size: 0.9rem;
}

.primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.ghost {
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  font-size: 0.9rem;
}
</style>
