<script setup lang="ts">
import { computed, ref } from 'vue';
import { transportInstructions } from '@thermal-label/harness-core/shared';
import {
  connection,
  device,
  isConnected,
  startStatusPolling,
  stopStatusPolling,
} from '../state/session';
import { connectToLabelmanager } from '../transport/connect';
import type { PrinterStatus } from '@thermal-label/contracts';
import { IS_MOCK_MODE } from '../composables/useMockMode';
import { findDeviceByVidPid } from '../transport/webusb-filters';
import { MockTransport } from '../transport/mock';
import SectionCard from './SectionCard.vue';

const sectionState = computed<'pending' | 'active' | 'done'>(() =>
  isConnected.value ? 'done' : 'active',
);

const connecting = ref(false);

async function connect(): Promise<void> {
  connection.error = null;
  connecting.value = true;
  try {
    const result = await connectToLabelmanager();
    connection.transport = result.transport;
    connection.identity = result.identity;
    connection.mocked = result.mocked;
    device.value = result.device;
    // Seed printerStatus from the initial probe (stashed on
    // identity.extra by runStatusProbe), then poll every few seconds
    // so cassette swaps + paper-jam clears surface live in the UI.
    const extra = (result.identity.extra ?? {}) as { ready?: boolean; mediaLoaded?: boolean };
    const initial: PrinterStatus | null =
      typeof extra.ready === 'boolean' && typeof extra.mediaLoaded === 'boolean'
        ? {
            ready: extra.ready,
            mediaLoaded: extra.mediaLoaded,
            errors: [],
            rawBytes: new Uint8Array(),
          }
        : null;
    startStatusPolling(result.transport, initial);
  } catch (err) {
    connection.error = err instanceof Error ? err.message : String(err);
  } finally {
    connecting.value = false;
  }
}

async function disconnect(): Promise<void> {
  stopStatusPolling();
  if (connection.transport) {
    await connection.transport.close();
  }
  connection.transport = null;
  connection.identity = null;
  device.value = null;
  connection.error = null;
}

const usbInstruction = transportInstructions.usb;

// Manual VID/PID override — Advanced drawer.
const manualVid = ref('0x0922');
const manualPid = ref('');

function applyManualVidPid(): void {
  const vid = parseInt(manualVid.value, manualVid.value.startsWith('0x') ? 16 : 10);
  const pid = parseInt(manualPid.value, manualPid.value.startsWith('0x') ? 16 : 10);
  if (Number.isNaN(vid) || Number.isNaN(pid)) {
    connection.error = 'Could not parse VID/PID — try `0x0922` / `0x1001` style values.';
    return;
  }
  const matched = findDeviceByVidPid(vid, pid);
  if (!matched) {
    connection.error =
      `No labelmanager device in the registry matches vid=0x${vid.toString(16)} pid=0x${pid.toString(16)}. ` +
      'Continuing anyway with the device label, but encoder behaviour is undefined.';
  }
  device.value = matched ?? null;
}
</script>

<template>
  <SectionCard :step="1" title="Connect to your printer" :state="sectionState">
    <p>{{ usbInstruction.inline }}</p>

    <p v-if="IS_MOCK_MODE" class="mock-banner">
      Running in <strong>mock mode</strong> — the connect button pretends to be a
      <code>{{ MockTransport.currentTarget }}</code> printer. Drop the <code>?mock=…</code> query to
      talk to real hardware.
    </p>

    <div v-if="!isConnected" class="connect-actions">
      <button class="primary" :disabled="connecting" @click="connect">
        {{ connecting ? 'Connecting…' : 'Connect' }}
      </button>
      <a class="more-help" :href="usbInstruction.docsLink" target="_blank" rel="noopener">
        More help →
      </a>
    </div>

    <div v-else class="connected-summary">
      <p>
        Connected to <strong>{{ device?.name ?? 'unknown device' }}</strong
        ><span v-if="connection.mocked"> (mock)</span>.
      </p>
      <button class="ghost" type="button" @click="disconnect">Disconnect</button>
    </div>

    <p v-if="connection.error" class="error">
      {{ connection.error }}
    </p>

    <template #advanced>
      <p class="muted">
        Manual VID/PID — bypasses the registry match. Use only if the picker selected the right
        device but the registry didn't recognise it (Dymo's labelmanager firmware revisions can ship
        with PIDs that don't match the labelle constants we seeded the registry from).
      </p>
      <div class="manual-form">
        <label>
          VID
          <input v-model="manualVid" placeholder="0x0922" />
        </label>
        <label>
          PID
          <input v-model="manualPid" placeholder="0x1001" />
        </label>
        <button type="button" class="ghost" @click="applyManualVidPid">Apply manual VID/PID</button>
      </div>
    </template>
  </SectionCard>
</template>

<style scoped>
.connect-actions {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  margin-top: var(--space-3);
}

.connected-summary {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.connected-summary p {
  margin: 0;
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

.more-help {
  font-size: 0.9rem;
  color: var(--fg-muted);
}

.error {
  background: var(--error-bg);
  color: var(--error);
  border: 1px solid var(--error);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  margin-top: var(--space-3);
  font-size: 0.92rem;
}

.mock-banner {
  background: var(--warn-bg);
  color: var(--warn);
  border: 1px solid var(--warn);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  font-size: 0.92rem;
  margin: var(--space-3) 0;
}

.manual-form {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: flex-end;
  margin-top: var(--space-3);
}

.manual-form label {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: 0.85rem;
}

.manual-form input {
  width: 9rem;
  font-family: var(--font-mono);
  font-size: 0.9rem;
}
</style>
