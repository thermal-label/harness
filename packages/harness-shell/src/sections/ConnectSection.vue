<script setup lang="ts">
/**
 * Connect & confirm section. Generic over the adapter's device type.
 *
 * Reads `adapter.connect`, `adapter.devices`, `adapter.findDeviceByVidPid`,
 * `adapter.status` (for the printer-ready pill), `adapter.mockTargets`
 * (for the mock-mode banner). Emits `update:device` mutations into
 * the shared session store.
 *
 * Inline identity-confirm UI: the "Wrong guess? Pick a different
 * model" affordance lives here (per the recent merge that combined §1
 * Connect + §2 Confirm into one card). Manual VID/PID + raw status
 * bytes live in the Advanced drawer.
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import type { PrintEngine } from '@thermal-label/contracts';
import { transportInstructions } from '@thermal-label/harness-core/shared';
import StatusPill from '@thermal-label/harness-components/status-pill';
import { useAdapter } from '../state/adapterContext';
import { useSession } from '../state/session';
import { useMockMode } from '../composables/useMockMode';
import { startStatusPolling, type PollHandle } from '../state/createStatusPolling';
import SectionCard from './SectionCard.vue';

const adapter = useAdapter();
const session = useSession();
const mockMode = useMockMode();

// One poll handle per engine role — multi-engine devices (Duo) get
// concurrent pollers, one per USB interface. Twin-style chassis
// share a transport across roles; the shell still spawns one poller
// per role, which means twin issues two ESC A queries on the same
// transport per cycle. Acceptable bandwidth waste for now; could
// dedupe by transport identity if it becomes a problem.
const pollHandles: Record<string, PollHandle> = {};

const sectionState = computed<'pending' | 'active' | 'done'>(() =>
  session.isConnected.value ? 'done' : 'active',
);

/**
 * Printer pill — driver-supplied via `adapter.status.toPills`. The
 * shell calls toPills with the latest status snapshot and the active
 * engine (if any), and reads the `printer` slot. When no `status`
 * config is supplied, the pill is suppressed.
 */
const printerDot = computed<{ state: 'unknown' | 'good' | 'warn' | 'bad'; label: string } | null>(
  () => {
    if (!adapter.status) return null;
    const engine = session.activeEngine.value;
    const ctx: { engine?: PrintEngine } = engine ? { engine } : {};
    const pills = adapter.status.toPills(session.printerStatus.value as never, ctx);
    return pills.printer ?? null;
  },
);

const rawStatusBytes = computed(() => {
  const raw = session.connection.identity?.extra?.raw;
  if (Array.isArray(raw)) {
    return raw.map(b => (typeof b === 'number' ? b.toString(16).padStart(2, '0') : '??')).join(' ');
  }
  return '(no status response captured)';
});

// ─── Wrong-guess override (was IdentitySection — combined here) ──

const overrideOpen = ref(false);
const overridePick = ref<string>('');

watch(
  () => session.device.value,
  d => {
    if (d) overridePick.value = adapter.deviceKey(d);
  },
);

const knownDevices = computed(() => adapter.devices);

function applyDeviceOverride(): void {
  const next = knownDevices.value.find(d => adapter.deviceKey(d) === overridePick.value);
  if (!next) return;
  session.device.value = next;
  session.syncEngineSessions(next);
  overrideOpen.value = false;
}

// ─── Connect / disconnect ────────────────────────────────────────

const connecting = ref(false);

async function connect(): Promise<void> {
  session.connection.error = null;
  connecting.value = true;
  try {
    const result = await adapter.connect({
      mock: mockMode.isMock,
      ...(mockMode.target ? { mockTarget: mockMode.target } : {}),
    });
    session.connection.transports = result.transports;
    session.connection.identity = result.identity;
    session.connection.mocked = result.mocked;
    session.device.value = result.device;
    session.syncEngineSessions(result.device);

    // Status polling — driver-supplied. Spawn one poller per
    // engine on multi-engine devices (Duo): each engine polls its
    // own transport and writes its slot in `engineStatuses`. The
    // active-tab pill picks up the right engine via the session
    // store's `printerStatus` computed. Single-engine devices and
    // Twin (one transport, two engine roles) get one poller per
    // declared role — same shape, fewer concurrent reads.
    if (adapter.status) {
      const dev = result.device as { engines?: readonly PrintEngine[] };
      const engineList: readonly PrintEngine[] = Array.isArray(dev.engines) ? dev.engines : [];
      for (const engine of engineList) {
        const transport = result.transports[engine.role];
        if (!transport) continue;
        const role = engine.role;
        pollHandles[role] = startStatusPolling({
          config: adapter.status,
          transport,
          device: result.device,
          engine,
          sink: status => {
            session.engineStatuses[role] = status;
          },
        });
      }
    }
  } catch (err) {
    session.connection.error = err instanceof Error ? err.message : String(err);
  } finally {
    connecting.value = false;
  }
}

async function disconnect(): Promise<void> {
  for (const role of Object.keys(pollHandles)) {
    try {
      await pollHandles[role]?.stop();
    } catch {
      // Best-effort.
    }
    delete pollHandles[role];
  }
  // De-dupe transports — Twin shares one transport across engines, so
  // closing each role-keyed entry would call close() twice on the same
  // transport instance.
  const closed = new Set<unknown>();
  for (const t of Object.values(session.connection.transports)) {
    if (closed.has(t)) continue;
    closed.add(t);
    try {
      await t.close();
    } catch {
      // Best-effort cleanup; the next connect re-issues the picker
      // and the page is otherwise reactive to the empty-transports
      // map.
    }
  }
  if (adapter.disconnectExtras) {
    await adapter.disconnectExtras(session.connection.transports);
  }
  session.connection.transports = {};
  session.connection.identity = null;
  session.device.value = null;
  session.syncEngineSessions(null);
  session.connection.error = null;
}

onUnmounted(() => {
  for (const role of Object.keys(pollHandles)) {
    void pollHandles[role]?.stop();
    delete pollHandles[role];
  }
});

const usbInstruction = transportInstructions.usb;

// ─── Manual VID/PID override (Advanced) ──────────────────────────

const manualVid = ref('0x0922');
const manualPid = ref('');

function applyManualVidPid(): void {
  const vid = parseInt(manualVid.value, manualVid.value.startsWith('0x') ? 16 : 10);
  const pid = parseInt(manualPid.value, manualPid.value.startsWith('0x') ? 16 : 10);
  if (Number.isNaN(vid) || Number.isNaN(pid)) {
    session.connection.error = 'Could not parse VID/PID — try `0x0922` / `0x0008` style values.';
    return;
  }
  const matched = adapter.findDeviceByVidPid?.(vid, pid);
  if (!matched) {
    session.connection.error =
      `No ${adapter.driverKey} device in the registry matches vid=0x${vid.toString(16)} pid=0x${pid.toString(16)}. ` +
      'Continuing anyway with the device label, but encoder behaviour is undefined.';
  }
  session.device.value = matched ?? null;
  session.syncEngineSessions(matched ?? null);
}

const mockTargetLabel = computed(() => {
  if (!mockMode.spec) return mockMode.target ?? 'mock';
  return mockMode.spec.displayName;
});
</script>

<template>
  <SectionCard :step="1" title="Connect & confirm" :state="sectionState">
    <template v-if="session.isConnected.value && printerDot" #header-aside>
      <StatusPill :state="printerDot.state" :label="printerDot.label" />
    </template>

    <p>{{ usbInstruction.inline }}</p>

    <p v-if="mockMode.isMock" class="mock-banner">
      Running in <strong>mock mode</strong> — the connect button pretends to be a
      <code>{{ mockTargetLabel }}</code> printer. Drop the <code>?mock=…</code> query to talk to
      real hardware.
    </p>

    <div v-if="!session.isConnected.value" class="connect-actions">
      <button class="primary" :disabled="connecting" @click="connect">
        {{ connecting ? 'Connecting…' : 'Connect' }}
      </button>
      <a class="more-help" :href="usbInstruction.docsLink" target="_blank" rel="noopener">
        More help →
      </a>
    </div>

    <div v-else class="connected-summary">
      <p>
        Detected:
        <strong>{{
          session.device.value ? adapter.deviceName(session.device.value) : 'unknown device'
        }}</strong>
        <span v-if="session.device.value" class="key"
          >[{{ adapter.deviceKey(session.device.value) }}]</span
        >
        <span v-if="session.connection.mocked" class="muted small"> · mock</span>
      </p>
      <button class="ghost" type="button" @click="disconnect">Disconnect</button>
    </div>

    <p
      v-if="session.isConnected.value && session.connection.identity?.vid !== undefined"
      class="muted small"
    >
      vid = 0x{{ session.connection.identity.vid.toString(16).padStart(4, '0') }}, pid = 0x{{
        session.connection.identity.pid?.toString(16).padStart(4, '0')
      }}
    </p>
    <p v-if="session.connection.identity?.extra?.statusProbeError" class="warn small">
      Status probe didn't respond — that's fine for many models, but the connection might still hang
      on the first print. If it does, unplug + replug and try again.
    </p>

    <div v-if="session.isConnected.value && !overrideOpen" class="actions">
      <button class="ghost" type="button" @click="overrideOpen = true">
        Wrong guess? Pick a different model
      </button>
    </div>

    <div v-else-if="session.isConnected.value" class="override-form">
      <label>
        Model
        <select v-model="overridePick">
          <option
            v-for="d in knownDevices"
            :key="adapter.deviceKey(d)"
            :value="adapter.deviceKey(d)"
          >
            {{ adapter.deviceName(d) }} [{{ adapter.deviceKey(d) }}]
          </option>
        </select>
      </label>
      <button class="primary" type="button" @click="applyDeviceOverride">Use this model</button>
      <button class="ghost" type="button" @click="overrideOpen = false">Cancel</button>
    </div>

    <p v-if="session.connection.error" class="error">
      {{ session.connection.error }}
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

      <template v-if="session.isConnected.value">
        <p class="muted small">Raw status response (first bytes, hex):</p>
        <pre>{{ rawStatusBytes }}</pre>
        <p v-if="session.connection.identity?.extra?.detectedSku" class="small">
          SKU probe returned: <code>{{ session.connection.identity.extra.detectedSku }}</code>
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
