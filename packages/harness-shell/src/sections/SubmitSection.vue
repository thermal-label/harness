<script setup lang="ts">
/**
 * Submit / report-card section. Generic over the adapter's
 * `buildReport` callback.
 *
 * Single-engine devices: renders as a regular last-step section.
 * Multi-engine devices: per-engine coverage list + sticky-bottom
 * report card + "Test the [other-role] engine →" CTA per
 * plan-09 §rails-not-walls. Submit gates on `≥1 engine assessed`,
 * never on full coverage. Submit copy adapts: "Submit verification
 * report" (full) vs "Submit partial report (1 of 2 engines tested)"
 * (partial). No modals, no nags.
 *
 * Fallbacks: clipboard copy + inline textarea — surfaces when the
 * URL exceeds GitHub's prefill limit OR a pop-up blocker eats the
 * `window.open` call. Fallback textarea is the always-recoverable
 * path.
 */
import { computed, ref } from 'vue';
import type { PrintEngine } from '@thermal-label/contracts';
import {
  buildDiagnosticsSnapshot,
  renderDiagnosticsBlock,
  type DiagnosticsSnapshot,
} from '@thermal-label/harness-core/shared';
import { useAdapter } from '../state/adapterContext';
import { useSession } from '../state/session';
import {
  buildIssueTitle,
  buildPrefillUrl,
  buildRfidCatalogueIssue,
  copyToClipboard,
  renderBody,
  submitReport,
  urlExceedsLimit,
  type RfidBlock,
  type SubmitResult,
} from '../submit/submit';
import SectionCard from './SectionCard.vue';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const adapter = useAdapter<any, any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const session = useSession<any, any>();

const isMultiEngine = computed(() => {
  const dev = session.device.value as { engines?: readonly unknown[] } | null;
  if (!dev?.engines) return false;
  return dev.engines.length > 1;
});

const sectionState = computed<'pending' | 'active' | 'done'>(() => {
  if (!session.canSubmit.value) return 'pending';
  if (!session.submitState.submitted) return 'active';
  return 'done';
});

const errorMessage = ref<string | null>(null);
const fallbackBody = ref<string | null>(null);
/**
 * Structured result of the last submit attempt — `null` before the
 * first attempt or after a hard error. Drives the post-submit banner
 * and the recovery block.
 */
const submitResult = ref<SubmitResult | null>(null);
const copyState = ref<'idle' | 'copied'>('idle');
const reportCopyState = ref<'idle' | 'copied'>('idle');

// ─── Diagnostics snapshot (ungated — available from connect) ──────
//
// A copy-only triage artifact, separate from the verdict-gated
// HardwareReport. Available the moment a device is connected so a
// reporter can paste a structured snapshot into an *existing* GitHub
// ticket — no print, no new issue. Recomputed live so a Copy reflects
// the latest polled status.

const diagnosticsSnapshot = computed<DiagnosticsSnapshot | null>(() => {
  const identity = session.connection.identity;
  if (!session.isConnected.value || !identity) return null;
  const engines = Object.entries(session.engineSessions).map(([role, es]) => ({
    role,
    status: session.printerStatus[role] ?? null,
    // Connect-time ESC V / ESC U capture (LW 5xx) — the shell folds
    // these onto the engine session; surface them in the snapshot too.
    ...(es.engineVersion ? { engineVersion: es.engineVersion } : {}),
    ...(es.skuInfo ? { skuInfo: es.skuInfo } : {}),
  }));
  return buildDiagnosticsSnapshot({
    driverKey: adapter.driverKey,
    harnessVersion: adapter.harnessVersion,
    driverVersion: adapter.driverVersion,
    mocked: session.connection.mocked,
    device: identity,
    engines,
    ...(session.environment.value ? { environment: session.environment.value } : {}),
  });
});

const diagnosticsJson = computed(() =>
  diagnosticsSnapshot.value ? JSON.stringify(diagnosticsSnapshot.value, null, 2) : '',
);

const diagnosticsCopyState = ref<'idle' | 'copied'>('idle');

async function copyDiagnostics(): Promise<void> {
  const snapshot = diagnosticsSnapshot.value;
  if (!snapshot) return;
  try {
    await copyToClipboard(renderDiagnosticsBlock(snapshot));
    diagnosticsCopyState.value = 'copied';
    setTimeout(() => {
      diagnosticsCopyState.value = 'idle';
    }, 2000);
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
  }
}

// ─── Multi-engine "test the other engine" CTA ────────────────────

const nextUnassessedRole = computed<string | null>(() => {
  const dev = session.device.value as { engines?: readonly PrintEngine[] } | null;
  if (!dev?.engines) return null;
  for (const eng of dev.engines) {
    const slot = session.engineSessions[eng.role];
    if (slot && slot.rung !== null) continue;
    return eng.role;
  }
  return null;
});

function switchToEngine(role: string): void {
  session.selectedRole.value = role;
  setTimeout(() => {
    document.getElementById('engine-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 50);
}

const partialCoverage = computed(
  () => isMultiEngine.value && session.assessedCount.value < session.totalEngines.value,
);

const submitButtonLabel = computed(() => {
  if (!session.canSubmit.value) return 'Submit verification report';
  if (partialCoverage.value) {
    return `Submit partial report (${session.assessedCount.value} of ${session.totalEngines.value} engines tested)`;
  }
  return 'Submit verification report';
});

function buildReport() {
  if (!session.device.value || !session.connection.identity || !session.canSubmit.value) {
    return null;
  }
  const assessedSessions = Object.values(session.engineSessions).filter(s => s.rung !== null);
  const primary =
    session.activeSession.value && session.activeSession.value.rung !== null
      ? session.activeSession.value
      : assessedSessions[0];
  if (!primary || primary.rung === null || !primary.media) return null;

  const report = adapter.buildReport({
    device: session.device.value,
    identity: session.connection.identity,
    primarySession: primary,
    allSessions: assessedSessions,
    multiEngine: isMultiEngine.value,
    mocked: session.connection.mocked,
  });
  // The runtime/OS snapshot is shell-owned context, folded in here so
  // no per-driver `buildReport` has to thread it through.
  const env = session.environment.value;
  return env ? { ...report, environment: env } : report;
}

async function doSubmit(): Promise<void> {
  errorMessage.value = null;
  fallbackBody.value = null;
  submitResult.value = null;
  const report = buildReport();
  if (!report) return;

  try {
    const result = await submitReport(report, adapter.targetRepo);
    submitResult.value = result;
    session.submitState.submitted = true;
    session.submitState.issueUrl = result.url;
    // The body must be hand-pasted only when it overflowed the prefill
    // URL — a title-only issue was opened in that case.
    if (result.prefill === 'title') fallbackBody.value = renderBody(report);
  } catch (err) {
    session.submitState.submitted = false;
    errorMessage.value = err instanceof Error ? err.message : String(err);
    fallbackBody.value = renderBody(report);
  }
}

async function copyBody(): Promise<void> {
  if (!fallbackBody.value) return;
  try {
    await copyToClipboard(fallbackBody.value);
    copyState.value = 'copied';
    setTimeout(() => {
      copyState.value = 'idle';
    }, 2000);
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
  }
}

const previewUrlTooLong = computed(() => {
  const report = buildReport();
  if (!report) return false;
  return urlExceedsLimit(
    buildPrefillUrl(adapter.targetRepo, buildIssueTitle(report), renderBody(report)),
  );
});

/** The exact issue body that submit will file — for the preview + Copy. */
const reportPreview = computed(() => {
  const report = buildReport();
  return report ? renderBody(report) : '';
});

/** True only when the browser opened a fully-prefilled issue — a clean submit. */
const submitCleanlyOpened = computed(
  () => submitResult.value?.opened === true && submitResult.value.prefill === 'full',
);

/** The recovery block shows whenever submit didn't cleanly open a full prefill. */
const showRecovery = computed(
  () => fallbackBody.value !== null || (submitResult.value !== null && !submitCleanlyOpened.value),
);

/** New-issue URL the recovery link points at — the prefilled one when we have it. */
const recoveryUrl = computed(
  () => submitResult.value?.url ?? `https://github.com/${adapter.targetRepo}/issues/new`,
);

async function copyReport(): Promise<void> {
  const text = reportPreview.value;
  if (!text) return;
  try {
    await copyToClipboard(text);
    reportCopyState.value = 'copied';
    setTimeout(() => {
      reportCopyState.value = 'idle';
    }, 2000);
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
  }
}

interface CoverageRow {
  role: string;
  badge: 'empty' | 'in-progress' | 'done';
  mediaName: string;
  rung: string;
  notes: string;
}

const coverageRows = computed<CoverageRow[]>(() => {
  const dev = session.device.value as { engines?: readonly PrintEngine[] } | null;
  if (!dev?.engines) return [];
  return dev.engines.map(engine => {
    const slot = session.engineSessions[engine.role];
    const badge: CoverageRow['badge'] = slot
      ? slot.rung !== null
        ? 'done'
        : slot.media !== null || slot.printed
          ? 'in-progress'
          : 'empty'
      : 'empty';
    return {
      role: engine.role,
      badge,
      mediaName: slot?.media ? String((slot.media as { id?: unknown }).id ?? '—') : '—',
      rung: slot?.rung ?? '—',
      notes: slot?.notes ?? '',
    };
  });
});

function activate(role: string): void {
  session.selectedRole.value = role;
}

// ─── Niimbot: catalogue-new-RFID-barcode CTA ─────────────────────
//
// Mirrors the LW 5xx unrecognized-NFC SubmitSection flow for niimbot.
// Fires when the chassis reported an RFID barcode whose value isn't
// in the driver's media catalogue — `status.detectedMedia` is
// undefined but `status.rfid.barcode` is populated. The MediaSection
// has by then dropped into `detected-unrecognized` mode and the
// operator has confirmed physical dimensions (the picker synthesises
// a media via `adapter.mediaPicker.customMedia.build`); this CTA
// renders the operator-confirmed dimensions + the full rfid payload
// as a prefilled GitHub issue body the maintainer can paste straight
// into `media.json5`.

const rfidUnknownIssue = computed<{ url: string; title: string } | null>(() => {
  const status = session.activeStatus.value as
    | (typeof session.activeStatus.value & {
        detectedMedia?: unknown;
        rfid?: RfidBlock;
      })
    | null;
  if (!status) return null;
  // Only fire on the unknown-barcode shape: rfid carries a barcode AND
  // the driver couldn't resolve it to a catalogue entry.
  if (status.detectedMedia !== undefined) return null;
  const rfid = status.rfid;
  if (!rfid?.barcode) return null;

  // Operator-confirmed dimensions ride from the synthetic media the
  // picker emitted. Undefined when the operator hasn't reached the
  // panel yet — the issue body still files, just with the unconfirmed
  // placeholders.
  const media = session.activeSession.value?.media as
    | { widthMm?: number; heightMm?: number; type?: string; name?: string }
    | null
    | undefined;

  const device = session.device.value ? adapter.deviceName(session.device.value) : '(unknown)';
  const { url, title } = buildRfidCatalogueIssue({
    driver: adapter.driverKey,
    targetRepo: adapter.targetRepo,
    device,
    rfid,
    confirmedMedia: media ?? null,
  });
  return { url, title };
});
</script>

<template>
  <SectionCard :step="5" title="Submit the report" :state="sectionState">
    <template v-if="!session.canSubmit.value">
      <p class="muted">Pick a verdict in the section above first.</p>
    </template>

    <template v-else-if="!session.submitState.submitted">
      <p>
        We'll open a prefilled GitHub issue in a new tab — you can review and edit it before
        clicking Submit there. The maintainer reads every report; these populate the
        supported-hardware matrix on thermal-label.github.io.
      </p>

      <div v-if="isMultiEngine" class="coverage">
        <p class="muted small">Per-engine coverage:</p>
        <ul class="coverage-list">
          <li
            v-for="row in coverageRows"
            :key="row.role"
            :class="['coverage-row', `badge-${row.badge}`]"
          >
            <button class="role-link" type="button" @click="activate(row.role)">
              <span class="badge">{{
                row.badge === 'done' ? '✓' : row.badge === 'in-progress' ? '…' : '·'
              }}</span>
              <strong>{{ row.role }}</strong>
            </button>
            <span class="muted small">
              {{ row.mediaName }} · {{ row.rung
              }}<template v-if="row.notes">— {{ row.notes }}</template>
            </span>
          </li>
        </ul>
        <p v-if="partialCoverage" class="muted small partial-hint">
          You're submitting a partial report covering {{ session.assessedCount.value }} of
          {{ session.totalEngines.value }} engines. The matrix cell will reflect partial coverage.
          That's fine — partial reports help too.
        </p>

        <!-- "Rails not walls" CTA: when there's another engine left
             to test, offer the switch alongside Submit. -->
        <div v-if="nextUnassessedRole" class="next-engine-cta">
          <p class="cta-blurb">
            You can also test the <strong>{{ nextUnassessedRole }}</strong> engine on this printer
            for a fully covered report.
          </p>
          <button class="cta-button" type="button" @click="switchToEngine(nextUnassessedRole)">
            Test the {{ nextUnassessedRole }} engine →
          </button>
        </div>
      </div>

      <p v-if="session.connection.mocked" class="warn">
        You're in mock mode — submitting from here will open a real GitHub issue with a synthesised
        report. Drop the <code>?mock=…</code> query before sending it for real.
      </p>

      <p v-if="previewUrlTooLong" class="muted small">
        Heads up — this report is too detailed for GitHub to prefill in one click. Submit walks you
        through it: copy the report, open a title-prefilled issue, paste. About ten seconds.
      </p>

      <details class="payload-preview">
        <summary>Preview the report you're filing</summary>
        <textarea readonly rows="12" :value="reportPreview" aria-label="Report payload" />
      </details>

      <div class="actions">
        <button
          class="primary"
          :disabled="!session.canSubmit.value"
          type="button"
          @click="doSubmit"
        >
          {{ submitButtonLabel }}
        </button>
        <button class="secondary" type="button" @click="copyReport">
          {{ reportCopyState === 'copied' ? 'Copied ✓' : 'Copy report' }}
        </button>
        <!-- Niimbot unrecognized-barcode CTA: mirrors the LW 5xx
             unrecognized-NFC catalogue-contribution flow. Renders next
             to the main Submit button when the chassis reported an
             RFID barcode the driver couldn't resolve to a catalogue
             entry — opens a prefilled issue at the driver repo with
             the operator-confirmed dimensions + the full rfid payload,
             ready for the maintainer to append to `media.json5`. -->
        <a
          v-if="rfidUnknownIssue"
          class="secondary catalogue-cta"
          :href="rfidUnknownIssue.url"
          target="_blank"
          rel="noopener"
          :title="rfidUnknownIssue.title"
        >
          Catalogue this RFID barcode →
        </a>
      </div>
    </template>

    <template v-else>
      <p v-if="submitCleanlyOpened" class="ok-banner">
        Thanks — the report is on its way.
        <a
          v-if="session.submitState.issueUrl"
          :href="session.submitState.issueUrl"
          target="_blank"
          rel="noopener"
        >
          Re-open the issue tab →
        </a>
      </p>
      <p v-else class="warn">
        Almost there — the report didn't reach GitHub on its own. The steps below take a few seconds
        to finish filing it.
      </p>

      <p v-if="submitCleanlyOpened">
        <strong>Have a photo of the print?</strong> Drop it into the GitHub issue's comment thread
        you just opened — GitHub's native attachment UI handles the upload. The harness
        intentionally doesn't host photos.
      </p>
    </template>

    <p v-if="errorMessage" class="error">{{ errorMessage }}</p>

    <div v-if="showRecovery" class="fallback">
      <template v-if="submitResult && submitResult.prefill === 'full' && !submitResult.opened">
        <p class="fallback-lead">
          Your browser blocked the new tab — no problem. The issue is fully prefilled, so a single
          click finishes it:
        </p>
        <p class="fallback-single">
          <a class="step-link" :href="submitResult.url" target="_blank" rel="noopener">
            Open the prefilled issue ↗
          </a>
        </p>
      </template>
      <template v-else>
        <p class="fallback-lead">
          <template v-if="submitResult?.prefill === 'title'">
            This report is too detailed for GitHub to prefill in one click — no problem. Three quick
            steps file it; the link sets the issue title for you:
          </template>
          <template v-else>
            The report didn't reach GitHub automatically — no problem. File it in three quick steps:
          </template>
        </p>
        <ol class="fallback-steps">
          <li>
            <button class="primary" type="button" @click="copyBody">
              {{ copyState === 'copied' ? 'Report copied ✓' : 'Copy the report' }}
            </button>
          </li>
          <li>
            <a class="step-link" :href="recoveryUrl" target="_blank" rel="noopener">
              Open the new issue ↗
            </a>
          </li>
          <li>Paste the report into the issue description, then submit it there.</li>
        </ol>
        <textarea readonly rows="10" :value="fallbackBody ?? ''" aria-label="Report body" />
      </template>
    </div>
    <!-- Diagnostics — copy-only, ungated by the verdict. Rendered in
         SectionCard's `#ungated` slot so it stays interactive while
         the Submit step is `pending`. Shown only until a verdict is
         picked: once there's a real report, the "Preview the report"
         payload above supersedes it — two payloads at once confuse. -->
    <template #ungated>
      <div v-if="diagnosticsSnapshot && !session.canSubmit.value" class="diagnostics">
        <p class="muted small">
          Triaging an existing issue? Copy this and paste it into the ticket — no need to submit a
          new report.
        </p>
        <details class="diagnostics-preview">
          <summary>Preview diagnostics JSON</summary>
          <textarea readonly rows="12" :value="diagnosticsJson" />
        </details>
        <div class="diagnostics-actions">
          <button class="primary" type="button" @click="copyDiagnostics">
            {{ diagnosticsCopyState === 'copied' ? 'Copied ✓' : 'Copy diagnostics (JSON)' }}
          </button>
        </div>
      </div>
    </template>
  </SectionCard>
</template>

<style scoped>
.actions {
  margin-top: var(--space-4);
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: center;
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

.secondary {
  background: transparent;
  color: var(--accent);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-4);
  font-weight: 600;
  font-size: 0.95rem;
  cursor: pointer;
}

.secondary:hover {
  background: var(--bg);
}

.catalogue-cta {
  display: inline-flex;
  align-items: center;
  text-decoration: none;
  cursor: pointer;
}

.ok-banner {
  background: var(--ok-bg);
  color: var(--ok);
  border: 1px solid var(--ok);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  font-size: 0.95rem;
}

.warn {
  background: var(--warn-bg);
  color: var(--warn);
  border: 1px solid var(--warn);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  font-size: 0.92rem;
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

.small {
  font-size: 0.85rem;
}

.fallback {
  margin-top: var(--space-4);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
}

.fallback-lead {
  margin: 0;
  font-size: 0.92rem;
}

.fallback-steps {
  margin: var(--space-3) 0;
  padding-left: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  font-size: 0.9rem;
}

.fallback-single {
  margin: var(--space-3) 0 0;
  font-size: 0.9rem;
}

.fallback textarea {
  width: 100%;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  resize: vertical;
  margin-top: var(--space-2);
}

.diagnostics {
  margin-top: var(--space-4);
  padding: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
}

.payload-preview {
  margin-top: var(--space-3);
}

.payload-preview summary {
  cursor: pointer;
  font-size: 0.85rem;
}

.payload-preview textarea {
  width: 100%;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  resize: vertical;
  margin-top: var(--space-2);
}

.diagnostics-preview {
  margin-top: var(--space-2);
}

.diagnostics-preview summary {
  cursor: pointer;
  font-size: 0.85rem;
}

.diagnostics-preview textarea {
  width: 100%;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  resize: vertical;
  margin-top: var(--space-2);
}

.diagnostics-actions {
  margin-top: var(--space-3);
}

.next-engine-cta {
  margin-top: var(--space-3);
  padding: var(--space-3);
  background: var(--bg);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  align-items: flex-start;
}

.cta-blurb {
  margin: 0;
  font-size: 0.9rem;
  color: var(--fg-muted, var(--muted));
}

.cta-blurb strong {
  text-transform: capitalize;
  color: var(--fg);
}

.cta-button {
  background: var(--accent);
  color: var(--accent-fg);
  border: none;
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-4);
  font-size: 0.92rem;
  font-weight: 600;
  cursor: pointer;
  text-transform: capitalize;
}

.cta-button:hover {
  background: var(--accent-hover);
}

.coverage {
  margin-top: var(--space-3);
  margin-bottom: var(--space-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
}

.coverage-list {
  list-style: none;
  margin: var(--space-2) 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.coverage-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: baseline;
}

.role-link {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  color: inherit;
  font: inherit;
  display: inline-flex;
  gap: var(--space-2);
  align-items: baseline;
}

.role-link:hover strong {
  text-decoration: underline;
}

.badge {
  display: inline-block;
  width: 1.25rem;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 0.95rem;
}

.badge-done .badge {
  color: var(--ok);
}

.badge-in-progress .badge {
  color: var(--warn);
}

.badge-empty .badge {
  color: var(--fg-faint);
}

.partial-hint {
  margin-top: var(--space-3);
}
</style>
