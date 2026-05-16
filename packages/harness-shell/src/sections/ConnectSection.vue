<script setup lang="ts">
/**
 * Connect & confirm section. Generic over the adapter's device type.
 *
 * Plan 11 reshape:
 *  - One button per browser-reachable transport the driver's
 *    registry declares (filter `tcp`). Operators pick the transport
 *    explicitly; the adapter's `connect()` receives
 *    `opts.transport` and dispatches.
 *  - `DeviceIdentificationRequiredError` from the driver-web factory
 *    is caught generically — the shell shows `<DeviceDropdown>`
 *    populated from `err.candidates`, then resumes via
 *    `err.continueWith(deviceKey)`. No second picker open.
 *  - Identity panel branches on `connection.transport`: USB shows
 *    vid/pid, Serial/SPP shows port/baud, GATT shows service UUID +
 *    advertised name.
 */
import { computed, markRaw, nextTick, onUnmounted, ref } from 'vue';
import { DeviceIdentificationRequiredError } from '@thermal-label/contracts';
import StatusPill from '@thermal-label/harness-components/status-pill';
import { useAdapter } from '../state/adapterContext';
import { useSession } from '../state/session';
import { useMockMode } from '../composables/useMockMode';
import { startStatusPolling, type PollHandle } from '../state/createStatusPolling';
import { engineNoun, statusToPrinterPill } from '../state/statusPills';
import SectionCard from './SectionCard.vue';
import TransportButtons from './TransportButtons.vue';
import DeviceDropdown from './DeviceDropdown.vue';
import type { BrowserTransport } from '../types';

const adapter = useAdapter();
const session = useSession();
const mockMode = useMockMode();

const pollHandles = new Map<string, PollHandle>();

const sectionState = computed<'pending' | 'active' | 'done'>(() =>
  session.isConnected.value ? 'done' : 'active',
);

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

/**
 * Driver-decoded `details[]` rows for the active engine's status —
 * the diagnostics panel (plan 13 §E.5). The driver owns every label /
 * value / severity; the shell renders the list blindly, so a new
 * device model needs zero shell change. Empty for drivers that decode
 * no details (the panel hides).
 */
const statusDetails = computed(() => session.activeStatus.value?.details ?? []);

// ─── Available transports (union across the registry) ────────────

/**
 * Browser-reachable transports declared by ANY device in the
 * driver's registry. Plan 11 §Connect-section UI: iterate
 * `Object.keys(device.transports)`, filter `tcp`. Pre-connect there
 * is no single device, so the shell takes the union across the
 * adapter's whole registry. Single-transport drivers (LM, LW) end
 * up with one button; multi-transport drivers (brother-ql USB+SPP)
 * get one button per transport.
 */
const availableTransports = computed<readonly BrowserTransport[]>(() => {
  const seen = new Set<BrowserTransport>();
  for (const device of adapter.devices) {
    const transports = (device as { transports?: Record<string, unknown> }).transports;
    if (!transports) continue;
    for (const key of Object.keys(transports)) {
      if (key === 'tcp') continue;
      // Narrow against the BrowserTransport union; ignore any unexpected key.
      if (
        key === 'usb' ||
        key === 'serial' ||
        key === 'bluetooth-spp' ||
        key === 'bluetooth-gatt'
      ) {
        seen.add(key);
      }
    }
  }
  return Array.from(seen);
});

// ─── Connect / disconnect ────────────────────────────────────────

const connecting = ref(false);

interface PendingDeviceChoice {
  err: DeviceIdentificationRequiredError;
  transport: BrowserTransport;
}
const pendingChoice = ref<PendingDeviceChoice | null>(null);

async function connect(transport: BrowserTransport): Promise<void> {
  session.connection.error = null;
  pendingChoice.value = null;
  connecting.value = true;
  try {
    const result = await adapter.connect({
      mock: mockMode.isMock,
      transport,
      ...(mockMode.target ? { mockTarget: mockMode.target } : {}),
    });
    await bindResult(result, transport);
  } catch (err) {
    if (err instanceof DeviceIdentificationRequiredError) {
      // Driver-web couldn't auto-identify; hand the candidate list
      // to the operator. The already-opened port/device is held
      // inside `err.continueWith`'s closure — no second picker open.
      pendingChoice.value = { err, transport };
    } else {
      session.connection.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    connecting.value = false;
  }
}

async function pickFromDropdown(deviceKey: string): Promise<void> {
  const pending = pendingChoice.value;
  if (!pending) return;
  session.connection.error = null;
  connecting.value = true;
  try {
    const printerMap = await pending.err.continueWith(deviceKey);
    // continueWith returns just the PrinterAdapterMap; the
    // harness ConnectResult shape also wants `device` + `mocked`.
    // The first printer's `.device` is the registry entry.
    const first = Object.values(printerMap)[0];
    if (!first || !first.device) {
      throw new Error('continueWith returned no engines.');
    }
    await bindResult(
      {
        printers: printerMap as Record<string, NonNullable<typeof first>>,
        device: first.device as Parameters<typeof bindResult>[0]['device'],
        mocked: false,
      },
      pending.transport,
    );
    pendingChoice.value = null;
  } catch (err) {
    session.connection.error = err instanceof Error ? err.message : String(err);
  } finally {
    connecting.value = false;
  }
}

function cancelDropdown(): void {
  pendingChoice.value = null;
}

/**
 * Wire a successful connect-result into the session state — same
 * code path for the initial connect and for the `continueWith`
 * resume after a dropdown pick.
 */
async function bindResult(
  result: Awaited<ReturnType<typeof adapter.connect>>,
  transport: BrowserTransport,
): Promise<void> {
  const rawPrinters: Record<string, (typeof result.printers)[string]> = {};
  for (const [role, printer] of Object.entries(result.printers)) {
    rawPrinters[role] = markRaw(printer);
  }
  session.connection.printers = rawPrinters;
  session.connection.mocked = result.mocked;
  session.connection.transport = transport;
  session.device.value = result.device;
  session.syncEngineSessions(result.device);

  const initialRole = session.selectedRole.value;
  const initialPrinter =
    (initialRole && result.printers[initialRole]) ||
    result.printers[Object.keys(result.printers)[0] ?? ''] ||
    null;

  // Identity snapshot — branches on transport per plan 11.
  const dev = result.device as {
    key?: string;
    name?: string;
    transports?: Record<string, unknown>;
  };
  const transports = dev.transports ?? {};
  const identity: Record<string, unknown> = {
    advertisedName: dev.name ?? '',
  };
  if (transport === 'usb') {
    const usb = (transports.usb as { vid?: string; pid?: string } | undefined) ?? undefined;
    const printerUsb =
      (initialPrinter?.device?.transports?.usb as
        | { vid?: string; pid?: string }
        | undefined) ?? undefined;
    const source = printerUsb ?? usb;
    if (source?.vid !== undefined && source.pid !== undefined) {
      identity.vid = parseInt(source.vid, 16);
      identity.pid = parseInt(source.pid, 16);
    }
  } else if (transport === 'bluetooth-gatt') {
    const gatt = transports['bluetooth-gatt'] as
      | { serviceUuid?: string }
      | undefined;
    if (gatt?.serviceUuid) identity.serviceUuid = gatt.serviceUuid;
  } else if (transport === 'serial' || transport === 'bluetooth-spp') {
    const serial = transports.serial as { defaultBaud?: number } | undefined;
    if (serial?.defaultBaud !== undefined) identity.serialBaud = serial.defaultBaud;
  }
  if (result.mocked) identity.extra = { mocked: true };

  // Fold any adapter-captured connect diagnostics (ESC V / ESC U for
  // LW 5xx — plan 13 §E.1) into the per-engine sessions and the
  // identity snapshot. Firmware is connect-time identity, not live
  // status, so the engine version's fw/pid/hw ride on `identity`.
  const engineDiagnostics = result.engineDiagnostics ?? {};
  for (const [role, diag] of Object.entries(engineDiagnostics)) {
    const slot = session.engineSessions[role];
    if (!slot) continue;
    if (diag.engineVersion) slot.engineVersion = diag.engineVersion;
    if (diag.skuInfo) slot.skuInfo = diag.skuInfo;
  }
  // Surface the first engine's firmware on the identity panel.
  const firstVersion = Object.values(engineDiagnostics).find(d => d.engineVersion)?.engineVersion;
  if (firstVersion) {
    if (firstVersion.fwVersion !== undefined) identity.fwVersion = firstVersion.fwVersion;
    if (firstVersion.pid !== undefined && identity.pid === undefined) {
      identity.pid = firstVersion.pid;
    }
    const extraBits: Record<string, unknown> = {
      ...((identity.extra as Record<string, unknown> | undefined) ?? {}),
    };
    if (firstVersion.hwVersion !== undefined) extraBits.hwVersion = firstVersion.hwVersion;
    if (firstVersion.fwKind !== undefined) extraBits.fwKind = firstVersion.fwKind;
    if (Object.keys(extraBits).length > 0) identity.extra = extraBits;
  }
  session.connection.identity = identity as typeof session.connection.identity;

  void nextTick(() => {
    for (const [role, printer] of Object.entries(result.printers)) {
      const handle = startStatusPolling({
        printer,
        sink: status => {
          session.printerStatus[role] = status;
          // Capture the first polled status as the connect-time
          // baseline (plan 13 §C `connectStatus`). Later polls keep
          // `printerStatus[role]` fresh — that feeds `finalStatus` at
          // report time — but `connectStatus` is pinned to the first.
          const slot = session.engineSessions[role];
          if (slot && (slot.connectStatus === null || slot.connectStatus === undefined)) {
            slot.connectStatus = status;
          }
        },
      });
      pollHandles.set(role, handle);
    }
  });
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
    for (const printer of Object.values(printers)) {
      try {
        await printer.close();
      } catch {
        // Best-effort cleanup.
      }
    }
  }
  session.connection.printers = null;
  session.connection.identity = null;
  session.connection.transport = null;
  for (const role of Object.keys(session.printerStatus)) {
    delete session.printerStatus[role];
  }
  session.device.value = null;
  session.syncEngineSessions(null);
  session.connection.error = null;
  pendingChoice.value = null;
}

onUnmounted(() => {
  stopAllPolls();
});

const mockTargetLabel = computed(() => {
  if (!mockMode.spec) return mockMode.target ?? 'mock';
  return mockMode.spec.displayName;
});

// Identity panel — drives the muted line below the connect summary.
const identityLine = computed<string | null>(() => {
  const identity = session.connection.identity;
  const transport = session.connection.transport;
  if (!identity || !transport) return null;
  if (transport === 'usb') {
    if (identity.vid === undefined || identity.pid === undefined) return null;
    return `vid = 0x${identity.vid.toString(16).padStart(4, '0')}, pid = 0x${identity.pid.toString(16).padStart(4, '0')}`;
  }
  if (transport === 'bluetooth-gatt') {
    if (!identity.serviceUuid) return null;
    return `service = ${identity.serviceUuid}${identity.advertisedName ? `, advertised name = "${identity.advertisedName}"` : ''}`;
  }
  if (transport === 'serial' || transport === 'bluetooth-spp') {
    const parts: string[] = [];
    if (identity.serialPath) parts.push(`port = ${identity.serialPath}`);
    if (identity.serialBaud !== undefined) parts.push(`baud = ${String(identity.serialBaud)}`);
    if (identity.advertisedName) parts.push(`name = "${identity.advertisedName}"`);
    return parts.length > 0 ? parts.join(', ') : null;
  }
  return null;
});

// Cast the err.candidates shape for the dropdown; contracts ships
// `DeviceEntry`, the dropdown's local type is structurally
// compatible (key, name, transports).
type DropdownCandidates = NonNullable<typeof pendingChoice.value>['err']['candidates'];
function asCandidates(candidates: DropdownCandidates): DropdownCandidates {
  return candidates;
}
</script>

<template>
  <SectionCard :step="1" title="Connect & confirm" :state="sectionState">
    <template v-if="session.isConnected.value && printerDot" #header-aside>
      <StatusPill :state="printerDot.state" :label="printerDot.label" />
    </template>

    <p v-if="mockMode.isMock" class="mock-banner">
      Running in <strong>mock mode</strong> — the connect button pretends to be a
      <code>{{ mockTargetLabel }}</code> printer. Drop the <code>?mock=…</code> query to talk to
      real hardware.
    </p>

    <template v-if="!session.isConnected.value">
      <TransportButtons
        v-if="!pendingChoice"
        :transports="availableTransports"
        :busy="connecting"
        :driver-key="adapter.driverKey"
        @connect="connect"
      />
      <DeviceDropdown
        v-if="pendingChoice"
        :candidates="asCandidates(pendingChoice.err.candidates)"
        :transport="pendingChoice.transport"
        @pick="pickFromDropdown"
        @cancel="cancelDropdown"
      />
    </template>

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

    <p v-if="identityLine" class="muted small">
      {{ identityLine }}
    </p>

    <p v-if="session.connection.error" class="error">
      {{ session.connection.error }}
    </p>

    <template #advanced>
      <template v-if="session.isConnected.value">
        <!-- Diagnostics panel — driver-decoded status detail rows
             (plan 13 §E.5). The driver owns label/value/severity; the
             shell renders verbatim. Hidden when the driver decodes
             nothing (LM-style presence-only devices). -->
        <template v-if="statusDetails.length > 0">
          <p class="muted small">Device diagnostics:</p>
          <dl class="status-details">
            <div
              v-for="(row, i) in statusDetails"
              :key="i"
              class="status-detail-row"
              :data-severity="row.severity ?? 'info'"
            >
              <dt>{{ row.label }}</dt>
              <dd>{{ row.value }}</dd>
            </div>
          </dl>
        </template>
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

/* Diagnostics panel — driver-decoded status detail rows. */
.status-details {
  margin: 0 0 var(--space-3);
  display: grid;
  gap: 1px;
  background: var(--border);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.status-detail-row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-1) var(--space-3);
  background: var(--bg);
  font-size: 0.82rem;
}

.status-detail-row dt {
  color: var(--fg-muted);
  margin: 0;
}

.status-detail-row dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.status-detail-row[data-severity='warn'] {
  background: var(--warn-bg);
}

.status-detail-row[data-severity='warn'] dd {
  color: var(--warn);
  font-weight: 600;
}

.status-detail-row[data-severity='error'] {
  background: var(--error-bg);
}

.status-detail-row[data-severity='error'] dd {
  color: var(--error);
  font-weight: 600;
}
</style>
