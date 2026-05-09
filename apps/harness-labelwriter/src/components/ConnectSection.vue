<script setup lang="ts">
import { computed, ref } from 'vue';
import { transportInstructions } from '@thermal-label/harness-core/shared';
import {
  connection,
  device,
  isConnected,
  printerStatus,
  startStatusPolling,
  stopStatusPolling,
  syncEngineSessions,
} from '../state/session';
import { connectToLabelwriter } from '../transport/connect';
import type { PrinterStatus } from '@thermal-label/contracts';
import { DEVICES } from '@thermal-label/labelwriter-core';
import StatusPill from '@thermal-label/harness-components/status-pill';
import { IS_MOCK_MODE } from '../composables/useMockMode';
import { findDeviceByVidPid } from '../transport/webusb-filters';
import { MockTransport } from '../transport/mock';
import SectionCard from './SectionCard.vue';
import { watch } from 'vue';

// ─── Wrong-guess override (was IdentitySection — combined here) ──

const overrideOpen = ref(false);
const overridePick = ref<string>('');

watch(device, d => {
  if (d) overridePick.value = d.key;
});

const knownDevices = computed(() => Object.values(DEVICES));

function applyDeviceOverride(): void {
  const next = knownDevices.value.find(d => d.key === overridePick.value);
  if (!next) return;
  device.value = next;
  syncEngineSessions(next);
  overrideOpen.value = false;
}

const rawStatusBytes = computed(() => {
  const raw = connection.identity?.extra?.raw;
  if (Array.isArray(raw)) {
    return raw.map(b => (typeof b === 'number' ? b.toString(16).padStart(2, '0') : '??')).join(' ');
  }
  return '(no status response captured)';
});

const sectionState = computed<'pending' | 'active' | 'done'>(() =>
  isConnected.value ? 'done' : 'active',
);

/**
 * Printer-ready pill in the section header. After connect we poll
 * status every few seconds; the pill collapses the result into a
 * traffic-light. On LW, `ready` means paper loaded AND no error AND
 * not busy — so a green pill here is the operator's "you're good
 * to print" signal.
 */
type DotState = 'unknown' | 'good' | 'warn' | 'bad';
const printerDot = computed<{ state: DotState; label: string }>(() => {
  const s = printerStatus.value;
  if (!s) return { state: 'unknown', label: 'Printer: checking…' };
  if (!s.ready) {
    if (s.errors.some(e => e.code === 'no_media')) {
      return { state: 'bad', label: 'No paper loaded' };
    }
    if (s.errors.some(e => e.code === 'paper_jam')) {
      return { state: 'bad', label: 'Paper jam' };
    }
    return { state: 'bad', label: 'Printer not ready' };
  }
  return { state: 'good', label: 'Printer ready' };
});

const connecting = ref(false);

async function connect(): Promise<void> {
  connection.error = null;
  connecting.value = true;
  try {
    const result = await connectToLabelwriter();
    connection.transports = result.transports;
    connection.identity = result.identity;
    connection.mocked = result.mocked;
    device.value = result.device;
    syncEngineSessions(result.device);
    if (result.skuInfo) {
      // Stash for the media section to consume.
      connection.identity = {
        ...result.identity,
        extra: { ...result.identity.extra, detectedSku: result.skuInfo.sku },
      };
    }
    // Seed printerStatus from the initial probe + start the live
    // poll so the section-header pill stays alive for paper-jam /
    // out-of-paper transitions during a session.
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
    // Status poll runs against the first engine's transport — on
    // single-engine devices that's the only one; on Duo we poll the
    // label engine (lw-450 status request, on interface 0).
    const firstRole = result.device.engines[0]?.role;
    const firstTransport = firstRole ? result.transports[firstRole] : undefined;
    if (firstTransport) {
      startStatusPolling(firstTransport, result.device, initial);
    }
  } catch (err) {
    connection.error = err instanceof Error ? err.message : String(err);
  } finally {
    connecting.value = false;
  }
}

async function disconnect(): Promise<void> {
  stopStatusPolling();
  // Close every per-engine transport. On Duo this releases both
  // interfaces; on single-engine devices both entries point at the
  // same Transport instance and the second close is a no-op.
  const closed = new Set<unknown>();
  for (const t of Object.values(connection.transports)) {
    if (closed.has(t)) continue;
    closed.add(t);
    await t.close();
  }
  connection.transports = {};
  connection.identity = null;
  device.value = null;
  syncEngineSessions(null);
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
    connection.error = 'Could not parse VID/PID — try `0x0922` / `0x0008` style values.';
    return;
  }
  const matched = findDeviceByVidPid(vid, pid);
  if (!matched) {
    connection.error =
      `No labelwriter device in the registry matches vid=0x${vid.toString(16)} pid=0x${pid.toString(16)}. ` +
      'Continuing anyway with the device label, but encoder behaviour is undefined.';
  }
  device.value = matched ?? null;
  syncEngineSessions(matched ?? null);
}
</script>

<template>
  <SectionCard :step="1" title="Connect & confirm" :state="sectionState">
    <template v-if="isConnected" #header-aside>
      <StatusPill :state="printerDot.state" :label="printerDot.label" />
    </template>

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
        Detected: <strong>{{ device?.name ?? 'unknown device' }}</strong>
        <span v-if="device" class="key">[{{ device.key }}]</span>
        <span v-if="connection.mocked" class="muted small"> · mock</span>
      </p>
      <button class="ghost" type="button" @click="disconnect">Disconnect</button>
    </div>

    <p v-if="isConnected && connection.identity?.vid !== undefined" class="muted small">
      vid = 0x{{ connection.identity.vid.toString(16).padStart(4, '0') }}, pid = 0x{{
        connection.identity.pid?.toString(16).padStart(4, '0')
      }}
    </p>
    <p v-if="connection.identity?.extra?.statusProbeError" class="warn small">
      Status probe didn't respond — that's fine for many models, but the connection might still hang
      on the first print. If it does, unplug + replug and try again.
    </p>

    <div v-if="isConnected && !overrideOpen" class="actions">
      <button class="ghost" type="button" @click="overrideOpen = true">
        Wrong guess? Pick a different model
      </button>
    </div>

    <div v-else-if="isConnected" class="override-form">
      <label>
        Model
        <select v-model="overridePick">
          <option v-for="d in knownDevices" :key="d.key" :value="d.key">
            {{ d.name }} [{{ d.key }}]
          </option>
        </select>
      </label>
      <button class="primary" type="button" @click="applyDeviceOverride">Use this model</button>
      <button class="ghost" type="button" @click="overrideOpen = false">Cancel</button>
    </div>

    <p v-if="connection.error" class="error">
      {{ connection.error }}
    </p>

    <template #advanced>
      <p class="muted">
        Manual VID/PID — bypasses the registry match. Use only if the picker selected the right
        device but the registry didn't recognise it.
      </p>
      <div class="manual-form">
        <label>
          VID
          <input v-model="manualVid" placeholder="0x0922" />
        </label>
        <label>
          PID
          <input v-model="manualPid" placeholder="0x0008" />
        </label>
        <button type="button" class="ghost" @click="applyManualVidPid">Apply manual VID/PID</button>
      </div>

      <template v-if="isConnected">
        <p class="muted small">Raw status response (first 32 bytes, hex):</p>
        <pre>{{ rawStatusBytes }}</pre>
        <p v-if="connection.identity?.extra?.detectedSku" class="small">
          SKU probe returned: <code>{{ connection.identity.extra.detectedSku }}</code>
        </p>
      </template>
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
  color: var(--fg-faint, var(--muted));
  margin-left: var(--space-2);
  font-family: var(--font-mono);
  font-size: 0.85em;
}

.warn {
  color: var(--warn);
}

.small {
  font-size: 0.85rem;
}

pre {
  font-size: 0.78rem;
  white-space: pre-wrap;
  word-break: break-all;
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
