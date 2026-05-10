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
import { useAdapter } from '../state/adapterContext';
import { useSession } from '../state/session';
import {
  buildIssueTitle,
  buildPrefillUrl,
  copyToClipboard,
  renderBody,
  submitReport,
  urlExceedsLimit,
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

const reporterHandle = ref('');
const errorMessage = ref<string | null>(null);
const fallbackBody = ref<string | null>(null);
const copyState = ref<'idle' | 'copied'>('idle');

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

  return adapter.buildReport({
    device: session.device.value,
    identity: session.connection.identity,
    primarySession: primary,
    allSessions: assessedSessions,
    multiEngine: isMultiEngine.value,
    mocked: session.connection.mocked,
    ...(reporterHandle.value.trim() ? { reporter: reporterHandle.value.trim() } : {}),
  });
}

async function doSubmit(): Promise<void> {
  errorMessage.value = null;
  fallbackBody.value = null;
  const report = buildReport();
  if (!report) return;

  try {
    const result = await submitReport(report, adapter.targetRepo);
    session.submitState.submitted = true;
    session.submitState.issueUrl = result.url ?? null;
    if (result.path === 'clipboard-fallback') {
      errorMessage.value =
        result.error ??
        "Couldn't open the issue tab — we copied the report body to your clipboard.";
      fallbackBody.value = renderBody(report);
    }
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
        Heads up: this report's body exceeds GitHub's URL limit. After submit, use the Copy button
        below to grab the body and paste it into a fresh issue manually.
      </p>

      <label class="reporter">
        Your handle (optional, attribution only)
        <input v-model="reporterHandle" placeholder="@yourname" />
      </label>

      <div class="actions">
        <button
          class="primary"
          :disabled="!session.canSubmit.value"
          type="button"
          @click="doSubmit"
        >
          {{ submitButtonLabel }}
        </button>
      </div>
    </template>

    <template v-else>
      <p class="ok-banner">
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

      <p>
        <strong>Have a photo of the print?</strong> Drop it into the GitHub issue's comment thread
        you just opened — GitHub's native attachment UI handles the upload. The harness
        intentionally doesn't host photos.
      </p>

      <p class="muted small">
        If the issue tab didn't open or the URL was too long, copy the report body below and paste
        into a fresh issue at
        <a
          :href="`https://github.com/${adapter.targetRepo}/issues/new`"
          target="_blank"
          rel="noopener"
        >
          {{ adapter.targetRepo }}/issues/new </a
        >.
      </p>
    </template>

    <p v-if="errorMessage" class="error">{{ errorMessage }}</p>

    <div v-if="fallbackBody" class="fallback">
      <p class="muted small">Report body — copy and paste into a fresh issue manually:</p>
      <textarea readonly rows="10" :value="fallbackBody" />
      <div class="fallback-actions">
        <button class="primary" type="button" @click="copyBody">
          {{ copyState === 'copied' ? 'Copied ✓' : 'Copy to clipboard' }}
        </button>
      </div>
    </div>
  </SectionCard>
</template>

<style scoped>
.reporter {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: 0.9rem;
  margin-top: var(--space-3);
}

.reporter input {
  max-width: 16rem;
}

.actions {
  margin-top: var(--space-4);
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
}

.fallback textarea {
  width: 100%;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  resize: vertical;
  margin-top: var(--space-2);
}

.fallback-actions {
  display: flex;
  gap: var(--space-3);
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
