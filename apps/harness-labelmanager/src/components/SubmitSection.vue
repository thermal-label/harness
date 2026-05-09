<script setup lang="ts">
/**
 * Submit section — the last step.
 *
 * Builds the `HardwareReport`, opens a prefilled GitHub issue URL
 * in a new tab. Fallbacks: clipboard copy + maintainer email surfaced
 * inline. Success view reminds the operator to drop a photo into the
 * GitHub issue comment if they have one (per plan 06's no-photo-
 * handling rule).
 */
import { computed, ref } from 'vue';
import {
  assessment,
  connection,
  device,
  hasAssessment,
  media,
  submitState,
} from '../state/session';
import {
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

const sectionState = computed<'pending' | 'active' | 'done'>(() => {
  if (!hasAssessment.value) return 'pending';
  if (!submitState.submitted) return 'active';
  return 'done';
});

const reporterHandle = ref('');
const errorMessage = ref<string | null>(null);
const fallbackBody = ref<string | null>(null);

const ready = computed(() => device.value !== null && assessment.rung !== null);

async function doSubmit(): Promise<void> {
  errorMessage.value = null;
  fallbackBody.value = null;
  if (!device.value || !assessment.rung || !connection.identity) return;

  const report = buildReport({
    device: device.value,
    media: media.value,
    identity: connection.identity,
    rung: assessment.rung,
    notes: assessment.notes,
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

const copyState = ref<'idle' | 'copied'>('idle');

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
  if (!ready.value || !device.value || !assessment.rung || !connection.identity) return false;
  const report = buildReport({
    device: device.value,
    media: media.value,
    identity: connection.identity,
    rung: assessment.rung,
    notes: assessment.notes,
    ...(reporterHandle.value.trim() ? { reporter: reporterHandle.value.trim() } : {}),
    mocked: connection.mocked,
  });
  return urlExceedsLimit(buildPrefillUrl(TARGET_REPO, buildIssueTitle(report), renderBody(report)));
});
</script>

<template>
  <SectionCard :step="5" title="Submit the report" :state="sectionState">
    <template v-if="!hasAssessment">
      <p class="muted">Pick a verdict in the section above first.</p>
    </template>

    <template v-else-if="!submitState.submitted">
      <p>
        We'll open a prefilled GitHub issue in a new tab — you can review and edit it before
        clicking Submit there. The maintainer reads every report.
      </p>

      <p v-if="connection.mocked" class="warn">
        You're in mock mode — submitting from here will open a real GitHub issue with a synthesised
        report. Drop the <code>?mock=…</code> query before sending it for real.
      </p>

      <p v-if="previewUrlTooLong" class="muted small">
        Heads up: this report's body exceeds GitHub's URL limit. After submit, use the Copy button
        below to grab the body and paste into a fresh issue manually.
      </p>

      <label class="reporter">
        Your handle (optional, attribution only)
        <input v-model="reporterHandle" placeholder="@yourname" />
      </label>

      <div class="actions">
        <button class="primary" :disabled="!ready" type="button" @click="doSubmit">
          Open prefilled issue
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
        If the issue tab didn't open or the URL was too long, copy the report body below and paste
        into a fresh issue at
        <a :href="`https://github.com/${TARGET_REPO}/issues/new`" target="_blank" rel="noopener">
          {{ TARGET_REPO }}/issues/new </a
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
</style>
