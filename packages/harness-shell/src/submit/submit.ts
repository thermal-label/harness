/**
 * Submit-flow helpers — building the issue title, computing the
 * prefilled GitHub URL, and orchestrating submit / clipboard-fallback.
 *
 * Driver-specific assembly of the `HardwareReport` is the adapter's
 * job (`adapter.buildReport(input) → HardwareReport`). The shell
 * takes the report and renders / opens / falls back from there.
 *
 * Mirrors the per-app submit.ts shape both LW and LM previously
 * carried verbatim.
 */
import { renderIssueBody, type HardwareReport } from '@thermal-label/harness-core/shared';

/**
 * GitHub's prefill URL has a soft limit somewhere around 8 kB. We
 * stay conservative and switch to the clipboard-fallback path before
 * we hit the actual cap.
 */
export const URL_LENGTH_LIMIT = 7_500;

export function buildIssueTitle(report: HardwareReport): string {
  const model = report.device.confirmed.model;
  const transports = report.transports.map(t => `${t.name}=${t.rung}`).join(' / ');
  const enginesSummary =
    report.engines && report.engines.length > 0
      ? ` [${report.engines.map(e => `${e.role}=${e.rung}`).join(' / ')}]`
      : '';
  return `[harness] ${model} — ${transports || 'unverified'}${enginesSummary}`;
}

export function buildPrefillUrl(repo: string, title: string, body: string): string {
  const params = new URLSearchParams();
  params.set('title', title);
  params.set('body', body);
  return `https://github.com/${repo}/issues/new?${params.toString()}`;
}

export function urlExceedsLimit(url: string): boolean {
  return url.length > URL_LENGTH_LIMIT;
}

export interface SubmitResult {
  /** Path taken: opened the URL, or fell back to clipboard. */
  path: 'prefill-url' | 'clipboard-fallback';
  /** The issue URL when applicable. */
  url?: string;
  /** Error if anything went wrong. */
  error?: string;
}

/**
 * Try to open the prefilled URL in a new tab. If the URL exceeds the
 * safe length, surface the clipboard-fallback path so the caller
 * renders the textarea + Copy button.
 *
 * Browser pop-up blockers fire when `window.open` runs outside a
 * direct user gesture — callers must invoke this from a click
 * handler. We do best-effort detection of a blocked pop-up and fall
 * back gracefully.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function submitReport(
  report: HardwareReport,
  targetRepo: string,
): Promise<SubmitResult> {
  const body = renderIssueBody(report);
  const title = buildIssueTitle(report);
  const url = buildPrefillUrl(targetRepo, title, body);

  if (urlExceedsLimit(url)) {
    return { path: 'clipboard-fallback', error: 'URL would exceed GitHub limits' };
  }

  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) {
    return {
      path: 'clipboard-fallback',
      error: 'Browser blocked the new tab — use the Copy button below to grab the report body.',
      url,
    };
  }

  return { path: 'prefill-url', url };
}

export async function copyToClipboard(text: string): Promise<void> {
  // `navigator.clipboard` is always present in modern browsers but
  // can throw on insecure (non-HTTPS) origins. The caller surfaces
  // the error to the user via the inline textarea fallback.
  await navigator.clipboard.writeText(text);
}

/**
 * Render the issue body alone — used by the SubmitSection to surface
 * a copy-pasteable textarea so the operator can recover even if both
 * the URL path and the clipboard path fail.
 */
export function renderBody(report: HardwareReport): string {
  return renderIssueBody(report);
}
