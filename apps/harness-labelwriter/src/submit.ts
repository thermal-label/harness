/**
 * Submit-flow helpers — building the `HardwareReport`, formatting
 * the issue title, and computing the prefilled GitHub URL.
 *
 * Mirrors the verify-cli's submit shape: prefer the prefilled-URL
 * path; fall back to copy-the-JSON when the URL would exceed
 * GitHub's ~8 kB limit. We don't have a `gh` CLI in the browser, so
 * the CLI's third path (`gh-cli`) doesn't exist here.
 */
import {
  renderIssueBody,
  type HardwareReport,
  type IdentitySnapshot,
  type ProposedRung,
  type TransportReport,
} from '@thermal-label/harness-core/shared';
import type { LabelWriterDevice, LabelWriterMedia } from '@thermal-label/labelwriter-core';
import { HARNESS_VERSION, DRIVER_VERSION } from './version';

const DRIVER_KEY = 'labelwriter';
export const TARGET_REPO = 'thermal-label/labelwriter';
export const FALLBACK_EMAIL = 'mannes@krukje.nl';

/**
 * GitHub's prefill URL has a soft limit somewhere around 8 kB. We
 * stay conservative and switch to the clipboard-fallback path before
 * we hit the actual cap.
 */
const URL_LENGTH_LIMIT = 7_500;

export interface BuildReportInput {
  device: LabelWriterDevice;
  media: LabelWriterMedia;
  identity: IdentitySnapshot;
  rung: ProposedRung;
  notes: string;
  reporter?: string;
  /** True if the run used the mock transport. */
  mocked: boolean;
}

export function buildReport(input: BuildReportInput): HardwareReport {
  const usb = input.device.transports.usb;
  const transportReport: TransportReport = {
    name: 'usb',
    patterns: { diagnostic: 'pass' },
    rung: input.rung,
    ...(input.notes.trim() ? { notes: input.notes.trim() } : {}),
  };

  const detected: IdentitySnapshot = {
    ...input.identity,
    extra: { ...input.identity.extra, ...(input.mocked ? { mocked: true } : {}) },
  };

  return {
    schemaVersion: 1,
    driver: DRIVER_KEY,
    driverVersion: DRIVER_VERSION,
    harnessVersion: HARNESS_VERSION,
    device: {
      detected,
      confirmed: {
        model: input.device.name,
        ...(usb ? { vid: parseInt(usb.vid, 16), pid: parseInt(usb.pid, 16) } : {}),
        overrides: { label: String(input.media.id) },
      },
    },
    transports: [transportReport],
    submittedAt: new Date().toISOString(),
    ...(input.reporter ? { reporter: { handle: input.reporter } } : {}),
  };
}

export function buildIssueTitle(report: HardwareReport): string {
  const model = report.device.confirmed.model;
  const transports = report.transports.map(t => `${t.name}=${t.rung}`).join(' / ');
  return `[harness] ${model} — ${transports || 'unverified'}`;
}

/**
 * Build the prefilled-issue URL. GitHub accepts `title` and `body`
 * as URL params; we URL-encode both. Returns the URL even if it
 * exceeds the safe length — the caller uses `urlExceedsLimit` to
 * decide whether to open it or fall through to the clipboard path.
 */
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
 * Try to open the prefilled URL in a new tab. If the URL exceeds
 * the safe length, copy the body to the clipboard and surface the
 * fallback path.
 *
 * Browser pop-up blockers fire when `window.open` runs outside a
 * direct user gesture — callers must invoke this from a click
 * handler. We do best-effort detection of a blocked pop-up and
 * fall back gracefully.
 */
export async function submitReport(report: HardwareReport): Promise<SubmitResult> {
  const body = renderIssueBody(report);
  const title = buildIssueTitle(report);
  const url = buildPrefillUrl(TARGET_REPO, title, body);

  if (urlExceedsLimit(url)) {
    await copyToClipboard(body);
    return { path: 'clipboard-fallback', error: 'URL would exceed GitHub limits' };
  }

  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (!opened) {
    // Pop-up blocker fired. Copy and tell the user.
    await copyToClipboard(body);
    return {
      path: 'clipboard-fallback',
      error: 'Browser blocked the new tab — body copied to clipboard.',
      url,
    };
  }

  return { path: 'prefill-url', url };
}

export async function copyToClipboard(text: string): Promise<void> {
  // `navigator.clipboard` is always present in modern browsers but
  // can throw on insecure (non-HTTPS) origins. The check stays a
  // try/catch around `writeText`; the caller surfaces the error to
  // the user via the inline textarea fallback.
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
