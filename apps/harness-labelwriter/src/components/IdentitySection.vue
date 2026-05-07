<script setup lang="ts">
/**
 * Identity-confirm section.
 *
 * Shows the auto-detected model + raw status bytes (Advanced drawer).
 * The model is editable — the operator picks from `DEVICES` if the
 * auto-detect guess is off (Dymo PIDs sometimes overlap across
 * firmware revs).
 *
 * Done state: a model is confirmed. Active when connected but no
 * confirmation yet (auto-confirm fires immediately on connect; the
 * operator only needs to act if the guess is wrong).
 */
import { computed, ref, watch } from 'vue';
import { DEVICES } from '@thermal-label/labelwriter-core';
import { connection, device, isConnected } from '../state/session';
import SectionCard from './SectionCard.vue';

const sectionState = computed<'pending' | 'active' | 'done'>(() => {
  if (!isConnected.value) return 'pending';
  if (device.value === null) return 'active';
  return 'done';
});

// Auto-confirm: when we connect with a registry hit, mark this
// section as done by leaving `device.value` set. The override flow
// only triggers when the operator picks something else.
const overrideOpen = ref(false);
const overridePick = ref<string>('');

watch(device, d => {
  if (d) overridePick.value = d.key;
});

const known = computed(() => Object.values(DEVICES));

function applyOverride(): void {
  const next = known.value.find(d => d.key === overridePick.value);
  if (!next) return;
  device.value = next;
  overrideOpen.value = false;
}

const rawStatusBytes = computed(() => {
  const raw = connection.identity?.extra?.raw;
  if (Array.isArray(raw)) {
    return raw.map(b => (typeof b === 'number' ? b.toString(16).padStart(2, '0') : '??')).join(' ');
  }
  return '(no status response captured)';
});
</script>

<template>
  <SectionCard :step="2" title="Confirm what we see" :state="sectionState">
    <p v-if="!isConnected" class="muted">Once you connect, we'll show what we detected.</p>

    <template v-else>
      <p>
        Detected model: <strong>{{ device?.name ?? 'unknown' }}</strong>
        <span v-if="device" class="key">[{{ device.key }}]</span>
      </p>
      <p v-if="connection.identity?.vid !== undefined" class="muted small">
        vid = 0x{{ connection.identity.vid.toString(16).padStart(4, '0') }}, pid = 0x{{
          connection.identity.pid?.toString(16).padStart(4, '0')
        }}
      </p>
      <p v-if="connection.identity?.extra?.statusProbeError" class="warn small">
        Status probe didn't respond — that's fine for many models, but the connection might still
        hang on the first print. If it does, unplug + replug and try again.
      </p>

      <div v-if="!overrideOpen" class="actions">
        <button class="ghost" type="button" @click="overrideOpen = true">
          Wrong guess? Pick a different model
        </button>
      </div>

      <div v-else class="override-form">
        <label>
          Model
          <select v-model="overridePick">
            <option v-for="d in known" :key="d.key" :value="d.key">
              {{ d.name }} [{{ d.key }}]
            </option>
          </select>
        </label>
        <button class="primary" type="button" @click="applyOverride">Use this model</button>
        <button class="ghost" type="button" @click="overrideOpen = false">Cancel</button>
      </div>
    </template>

    <template v-if="isConnected" #advanced>
      <p class="muted small">Raw status response (first 32 bytes, hex):</p>
      <pre>{{ rawStatusBytes }}</pre>
      <p v-if="connection.identity?.extra?.detectedSku" class="small">
        SKU probe returned: <code>{{ connection.identity.extra.detectedSku }}</code>
      </p>
    </template>
  </SectionCard>
</template>

<style scoped>
.actions {
  margin-top: var(--space-3);
}

.override-form {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: flex-end;
  margin-top: var(--space-3);
}

.override-form label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: 0.85rem;
  flex: 1;
  min-width: 14rem;
}

.override-form select {
  font-family: inherit;
}

.key {
  color: var(--fg-faint);
  margin-left: var(--space-2);
  font-family: var(--font-mono);
  font-size: 0.85em;
}

.small {
  font-size: 0.85rem;
}

.warn {
  color: var(--warn);
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

.primary:hover {
  background: var(--accent-hover);
}

.ghost {
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  font-size: 0.9rem;
}

.ghost:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}

pre {
  font-size: 0.78rem;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
