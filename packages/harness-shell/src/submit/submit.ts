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
  /** Did the browser open the prefilled issue tab for us? */
  opened: boolean;
  /**
   * The prefilled new-issue URL we opened (or tried to). The
   * SubmitSection links to it as the manual recovery path.
   */
  url: string;
  /**
   * How much of the issue the URL prefills:
   *  - `'full'`  — title + body; nothing left to paste.
   *  - `'title'` — title only; the body overflowed GitHub's URL limit,
   *    so the operator copies it and pastes it into the description.
   */
  prefill: 'full' | 'title';
}

/**
 * Open the report as a prefilled GitHub issue in a new tab.
 *
 * When the title + body fit GitHub's prefill-URL limit, both are
 * prefilled (`prefill: 'full'`). When the body overflows, a
 * title-only issue is opened instead (`prefill: 'title'`) — the
 * title always fits — and the caller surfaces a copy-the-body step.
 *
 * `opened` reports whether the browser allowed the tab; callers must
 * invoke this from a click handler so pop-up blockers don't fire.
 */
// eslint-disable-next-line @typescript-eslint/require-await
export async function submitReport(
  report: HardwareReport,
  targetRepo: string,
): Promise<SubmitResult> {
  const body = renderIssueBody(report);
  const title = buildIssueTitle(report);

  const fullUrl = buildPrefillUrl(targetRepo, title, body);
  if (!urlExceedsLimit(fullUrl)) {
    return { opened: openIssueTab(fullUrl), url: fullUrl, prefill: 'full' };
  }

  // The body overflows GitHub's prefill limit. Open a title-only
  // prefill so the operator lands on a new issue with the title
  // already set and only has to paste the body in.
  const titleUrl = buildPrefillUrl(targetRepo, title, '');
  return { opened: openIssueTab(titleUrl), url: titleUrl, prefill: 'title' };
}

/**
 * Open `url` in a new tab, reporting whether the browser allowed it.
 *
 * `window.open` returns `null` whenever `noopener` is in the feature
 * string, which makes open-vs-blocked indistinguishable — so we omit
 * it and sever `opener` by hand instead. Safe here: the target is
 * always github.com, a trusted origin.
 */
function openIssueTab(url: string): boolean {
  const opened = window.open(url, '_blank');
  if (!opened) return false;
  try {
    opened.opener = null;
  } catch {
    // A cross-origin WindowProxy may refuse the assignment — harmless.
  }
  return true;
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
