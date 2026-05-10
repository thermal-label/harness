<script setup lang="ts">
/**
 * Connect & confirm section. Generic over the adapter's device type.
 *
 * Reads `adapter.connect`, `adapter.devices`, and `adapter.mockTargets`
 * (for the mock-mode banner). Emits `update:device` mutations into
 * the shared session store.
 *
 * Post-harness-v2: the adapter's `connect()` returns a `PrinterAdapter`
 * directly. The shell stores the per-engine map on `connection.printers` and the
 * status pill is derived from the polled `PrinterStatus`. Manual
 * VID/PID + "wrong guess?" overrides are gone — the driver's
 * registry resolves the picked device.
 */
import { computed, markRaw, nextTick, onUnmounted, ref } from 'vue';
import { transportInstructions } from '@thermal-label/harness-core/shared';
import StatusPill from '@thermal-label/harness-components/status-pill';
import { useAdapter } from '../state/adapterContext';
import { useSession } from '../state/session';
import { useMockMode } from '../composables/useMockMode';
import { startStatusPolling, type PollHandle } from '../state/createStatusPolling';
import { engineNoun, statusToPrinterPill } from '../state/statusPills';
import SectionCard from './SectionCard.vue';

const adapter = useAdapter();
const session = useSession();
const mockMode = useMockMode();

/**
 * One poll handle per engine role — every entry in
 * `connection.printers` gets its own loop, and each loop writes to
 * `session.printerStatus[role]` (its own slot, never the shared ref).
 *
 * Pre-refactor a single `pollHandle` was rebound on tab flip; that
 * meant only the active engine ever polled, and a single hung
 * `getStatus()` (Bug B in plans/16) silently blocked every subsequent
 * tick across both engines. The map subsumes that — engines poll
 * independently on their own 4 s schedule.
 */
const pollHandles = new Map<string, PollHandle>();

const sectionState = computed<'pending' | 'active' | 'done'>(() =>
  session.isConnected.value ? 'done' : 'active',
);

/**
 * Printer pill — derived from the polled `PrinterStatus`. Adapter no
 * longer customises rendering; the engine-noun (paper / tape) is
 * picked from `engine.protocol === 'd1-tape'` directly.
 */
const printerDot = computed<{ state: 'unknown' | 'good' | 'warn' | 'bad'; label: string } | null>(
  () => {
    if (!session.isConnected.value) return null;
    const noun = engineNoun(session.activeEngine.value);
    return statusToPrinterPill(session.activeStatus.value, noun);
  },
);

const rawStatusBytes = computed(() => {
  const raw = session.activeStatus.value?.rawBytes;
  if (raw && raw.byteLength > 0) {
    return Array.from(raw)
      .slice(0, 32)
      .map(b => b.toString(16).padStart(2, '0'))
      .join(' ');
  }
  return '(no status response captured)';
});

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
    // `markRaw` each printer so Vue's deep `reactive()` on `connection`
    // doesn't try to recursively proxy the class instances. Their
    // internal Sets / Maps / pending I/O state aren't intended to be
    // tracked as reactive deps; Vue just treats them as opaque values.
    const rawPrinters: Record<string, (typeof result.printers)[string]> = {};
    for (const [role, printer] of Object.entries(result.printers)) {
      rawPrinters[role] = markRaw(printer);
    }
    session.connection.printers = rawPrinters;
    session.connection.mocked = result.mocked;
    session.device.value = result.device;
    session.syncEngineSessions(result.device);

    // Pick the primary printer for identity + first poll. Adapters
    // return a record keyed by engine role; we pull the entry matching
    // `selectedRole` (set by `syncEngineSessions` to the device's
    // first engine) or fall back to the first available adapter.
    const initialRole = session.selectedRole.value;
    const initialPrinter =
      (initialRole && result.printers[initialRole]) ||
      result.printers[Object.keys(result.printers)[0] ?? ''] ||
      null;

    // Identity snapshot for the report. The PrinterAdapter exposes
    // `device` (driver-core registry entry); we mirror its key/name
    // into `IdentitySnapshot` so the submit flow has something
    // structured to render.
    const dev = result.device as { key?: string; name?: string };
    session.connection.identity = {
      advertisedName: dev.name ?? '',
      ...(initialPrinter?.device?.transports?.usb
        ? {
            vid: parseInt(initialPrinter.device.transports.usb.vid, 16),
            pid: parseInt(initialPrinter.device.transports.usb.pid, 16),
          }
        : {}),
      ...(result.mocked ? { extra: { mocked: true } } : {}),
    };

    // Status polling — one loop per engine role. Each loop writes to
    // its own slot in `session.printerStatus`, so the Duo's tape and
    // label engines never clobber each other. Tab flips are pure
    // display routing through `session.activeStatus`; no poll teardown
    // or rebind happens on selection change.
    //
    // Deferred via `nextTick` so the first `getStatus()` (which writes
    // a 200-byte `buildInvalidate()` preamble + `ESC @` + status req
    // through `device.transferOut()`) doesn't run on the same
    // microtask checkpoint as Vue's render flush. Bench observation:
    // on a freshly-claimed Brother QL composite USB device, the first
    // post-claim `transferOut()` can stall the JS thread for ~1 s
    // (suspected OS-level wait for the device's bulk pipe to drain
    // after `claimInterface`). When that ran inside the connect()
    // continuation, the connected layout (`v-else` branch on
    // `!session.isConnected.value`) didn't paint until the stall
    // resolved — a 1 s blank gap after picker dismissal. nextTick
    // pushes the first USB I/O strictly after Vue's flush, so the
    // connected UI renders before any transferOut is initiated. The
    // same delay would affect labelmanager / labelwriter for the same
    // reason; this fix lives in the shared shell so every adapter
    // benefits.
    void nextTick(() => {
      for (const [role, printer] of Object.entries(result.printers)) {
        const handle = startStatusPolling({
          printer,
          sink: status => {
            // Reactive write — `printerStatus` is a `reactive({})`, so
            // assigning a new key triggers downstream computeds.
            session.printerStatus[role] = status;
          },
        });
        pollHandles.set(role, handle);
      }
    });
  } catch (err) {
    session.connection.error = err instanceof Error ? err.message : String(err);
  } finally {
    connecting.value = false;
  }
}

function stopAllPolls(): void {
  for (const handle of pollHandles.values()) {
    try {
      handle.stop();
    } catch {
      // Best-effort.
    }
  }
  pollHandles.clear();
}

async function disconnect(): Promise<void> {
  stopAllPolls();
  const printers = session.connection.printers;
  if (printers) {
    // Close every per-engine adapter. On composite USB devices (Duo)
    // multiple adapters share one underlying USBDevice; closing one
    // releases the device handle for all of them, so per-adapter
    // close failures after the first are expected — swallow them.
    for (const printer of Object.values(printers)) {
      try {
        await printer.close();
      } catch {
        // Best-effort cleanup; the next connect re-issues the picker.
      }
    }
  }
  session.connection.printers = null;
  session.connection.identity = null;
  for (const role of Object.keys(session.printerStatus)) {
    delete session.printerStatus[role];
  }
  session.device.value = null;
  session.syncEngineSessions(null);
  session.connection.error = null;
}

onUnmounted(() => {
  stopAllPolls();
});

const usbInstruction = transportInstructions.usb;

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

    <p v-if="session.connection.error" class="error">
      {{ session.connection.error }}
    </p>

    <template #advanced>
      <template v-if="session.isConnected.value">
        <p class="muted small">Raw status response (first bytes, hex):</p>
        <pre>{{ rawStatusBytes }}</pre>
      </template>
      <p v-else class="muted small">
        Connect first to see live status bytes here.
      </p>
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

.key {
  color: var(--fg-faint, var(--muted));
  margin-left: var(--space-2);
  font-family: var(--font-mono);
  font-size: 0.85em;
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
</style>
