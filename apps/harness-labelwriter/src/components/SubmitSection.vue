<script setup lang="ts">
/**
 * Submit / report-card section.
 *
 * Single-engine devices: renders as a regular last-step section
 * (today's behaviour). Builds the `HardwareReport`, opens a prefilled
 * GitHub issue URL in a new tab. Fallbacks: clipboard copy + email.
 *
 * Multi-engine devices: per plan 09 §rails-not-walls, this becomes a
 * sticky-bottom report card that aggregates per-engine assessments.
 * Submit gates on `≥1 engine assessed`, never on full coverage.
 * Submit copy adapts: "Submit verification report" (full coverage) vs
 * "Submit partial report (1 of 2 engines tested)" (partial). No
 * modals, no nags — the operator decides.
 */
import { computed, ref } from 'vue';
import {
  activeSession,
  assessedCount,
  canSubmit,
  connection,
  device,
  engineSessions,
  selectedRole,
  submitState,
  totalEngines,
} from '../state/session';
import {
  FALLBACK_EMAIL,
  TARGET_REPO,
  buildReport,
  copyToClipboard,
  renderBody,
  submitReport,
  urlExceedsLimit,
  buildPrefillUrl,
  buildIssueTitle,
} from '../submit';
import SectionCard from './SectionCard.vue';

const isMultiEngine = computed(() => totalEngines.value > 1);

const sectionState = computed<'pending' | 'active' | 'done'>(() => {
  if (!canSubmit.value) return 'pending';
  if (!submitState.submitted) return 'active';
  return 'done';
});

const reporterHandle = ref('');
const errorMessage = ref<string | null>(null);
const fallbackBody = ref<string | null>(null);

const partialCoverage = computed(
  () => isMultiEngine.value && assessedCount.value < totalEngines.value,
);

const submitButtonLabel = computed(() => {
  if (!canSubmit.value) return 'Submit verification report';
  if (partialCoverage.value) {
    return `Submit partial report (${assessedCount.value} of ${totalEngines.value} engines tested)`;
  }
  return 'Submit verification report';
});

async function doSubmit(): Promise<void> {
  errorMessage.value = null;
  fallbackBody.value = null;
  if (!device.value || !connection.identity || !canSubmit.value) return;

  // Pick a representative session for the legacy single-engine path
  // (transport-level rung still wants a value). Prefer the active
  // tab if it's been assessed; otherwise the first assessed engine.
  const assessedSessions = Object.values(engineSessions).filter(s => s.rung !== null);
  const primary =
    activeSession.value && activeSession.value.rung !== null
      ? activeSession.value
      : assessedSessions[0];
  if (!primary || primary.rung === null || !primary.media) return;

  const report = buildReport({
    device: device.value,
    primarySession: primary,
    allSessions: assessedSessions,
    multiEngine: isMultiEngine.value,
    identity: connection.identity,
    ...(reporterHandle.value.trim() ? { reporter: reporterHandle.value.trim() } : {}),
    mocked: connection.mocked,
  });

  try {
    const result = await submitReport(report);
    submitState.submitted = true;
    submitState.issueUrl = result.url ?? null;
    if (result.path === 'clipboard-fallback') {
      errorMessage.value =
        result.error ??
        "Couldn't open the issue tab — we copied the report body to your clipboard.";
      fallbackBody.value = renderBody(report);
    }
  } catch (err) {
    submitState.submitted = false;
    errorMessage.value = err instanceof Error ? err.message : String(err);
    fallbackBody.value = renderBody(report);
  }
}

async function copyBodyAgain(): Promise<void> {
  if (!fallbackBody.value) return;
  try {
    await copyToClipboard(fallbackBody.value);
    errorMessage.value = 'Copied to clipboard again.';
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : String(err);
  }
}

const previewUrlTooLong = computed(() => {
  if (!device.value || !connection.identity || !canSubmit.value) return false;
  const assessedSessions = Object.values(engineSessions).filter(s => s.rung !== null);
  const primary = assessedSessions[0];
  if (!primary || primary.rung === null || !primary.media) return false;
  const report = buildReport({
    device: device.value,
    primarySession: primary,
    allSessions: assessedSessions,
    multiEngine: isMultiEngine.value,
    identity: connection.identity,
    ...(reporterHandle.value.trim() ? { reporter: reporterHandle.value.trim() } : {}),
    mocked: connection.mocked,
  });
  return urlExceedsLimit(buildPrefillUrl(TARGET_REPO, buildIssueTitle(report), renderBody(report)));
});

const mailtoFallback = computed(() => {
  if (!fallbackBody.value) return '';
  const subject = encodeURIComponent('thermal-label labelwriter harness report');
  const body = encodeURIComponent(fallbackBody.value);
  return `mailto:${FALLBACK_EMAIL}?subject=${subject}&body=${body}`;
});

interface CoverageRow {
  role: string;
  badge: 'empty' | 'in-progress' | 'done';
  mediaName: string;
  rung: string;
  notes: string;
}

const coverageRows = computed<CoverageRow[]>(() => {
  if (!device.value) return [];
  return device.value.engines.map(engine => {
    const session = engineSessions[engine.role];
    const badge: CoverageRow['badge'] = session
      ? session.rung !== null
        ? 'done'
        : session.media !== null || session.printed
          ? 'in-progress'
          : 'empty'
      : 'empty';
    return {
      role: engine.role,
      badge,
      mediaName: session?.media ? String(session.media.id) : '—',
      rung: session?.rung ?? '—',
      notes: session?.notes ?? '',
    };
  });
});

function activate(role: string): void {
  selectedRole.value = role;
}
</script>

<template>
  <SectionCard :step="6" title="Submit the report" :state="sectionState">
    <template v-if="!canSubmit">
      <p class="muted">Pick a verdict in the section above first.</p>
    </template>

    <template v-else-if="!submitState.submitted">
      <p>
        We'll open a prefilled GitHub issue in a new tab — you can review and edit it before
        clicking Submit there. The maintainer reads every report.
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
          You're submitting a partial report covering {{ assessedCount }} of
          {{ totalEngines }} engines. The matrix cell will reflect partial coverage. That's fine —
          partial reports help too.
        </p>
      </div>

      <p v-if="connection.mocked" class="warn">
        You're in mock mode — submitting from here will open a real GitHub issue with a synthesised
        report. Drop the <code>?mock=…</code> query before sending it for real.
      </p>

      <p v-if="previewUrlTooLong" class="muted small">
        Heads up: this report's body would exceed GitHub's URL limit. We'll copy the JSON to your
        clipboard automatically and you can paste it into a fresh issue manually.
      </p>

      <label class="reporter">
        Your handle (optional, attribution only)
        <input v-model="reporterHandle" placeholder="@yourname" />
      </label>

      <div class="actions">
        <button class="primary" :disabled="!canSubmit" type="button" @click="doSubmit">
          {{ submitButtonLabel }}
        </button>
      </div>
    </template>

    <template v-else>
      <p class="ok-banner">
        Thanks — the report is on its way.
        <a v-if="submitState.issueUrl" :href="submitState.issueUrl" target="_blank" rel="noopener">
          Re-open the issue tab →
        </a>
      </p>

      <p>
        <strong>Have a photo of the print?</strong> Drop it into the GitHub issue's comment thread
        you just opened — GitHub's native attachment UI handles the upload. The harness
        intentionally doesn't host photos.
      </p>

      <p class="muted small">
        If the issue tab didn't open or the URL was too long, the report body is on your clipboard.
        Paste it into a fresh issue at
        <a :href="`https://github.com/${TARGET_REPO}/issues/new`" target="_blank" rel="noopener">
          {{ TARGET_REPO }}/issues/new </a
        >.
      </p>
    </template>

    <p v-if="errorMessage" class="error">{{ errorMessage }}</p>

    <div v-if="fallbackBody" class="fallback">
      <p class="muted small">Report body (copy this into a fresh issue if the tab didn't open):</p>
      <textarea readonly rows="10" :value="fallbackBody" />
      <div class="fallback-actions">
        <button class="ghost" type="button" @click="copyBodyAgain">Copy again</button>
        <a class="ghost" :href="mailtoFallback">Email to {{ FALLBACK_EMAIL }}</a>
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

.ghost {
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  font-size: 0.9rem;
  text-decoration: none;
  display: inline-block;
}

.ghost:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
  color: var(--fg);
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
