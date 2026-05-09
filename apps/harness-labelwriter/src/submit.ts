/**
 * Submit-flow helpers — building the `HardwareReport`, formatting
 * the issue title, and computing the prefilled GitHub URL.
 *
 * Mirrors the verify-cli's submit shape: prefer the prefilled-URL
 * path; fall back to copy-the-JSON when the URL would exceed
 * GitHub's ~8 kB limit. We don't have a `gh` CLI in the browser, so
 * the CLI's third path (`gh-cli`) doesn't exist here.
 *
 * Multi-engine model (plan 09): the `engines[]` array is populated
 * when the device has more than one engine. Single-engine devices
 * still emit a single transport report with no engines axis (the
 * report shape stays back-compatible).
 */
import {
  renderIssueBody,
  type EngineReport,
  type HardwareReport,
  type IdentitySnapshot,
  type TransportReport,
} from '@thermal-label/harness-core/shared';
import type { LabelWriterDevice } from '@thermal-label/labelwriter-core';
import type { EngineSession } from './state/session';
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
  /**
   * The session whose rung drives the transport-level report. On a
   * single-engine device this is the only session; on multi-engine
   * devices we pick the active or first-assessed session so the
   * legacy transport shape carries a non-null rung. Per-engine
   * results land in `allSessions` → `engines[]` array.
   */
  primarySession: EngineSession;
  /** All engine sessions the operator has assessed (rung set). */
  allSessions: readonly EngineSession[];
  /** True for devices declaring more than one engine. */
  multiEngine: boolean;
  identity: IdentitySnapshot;
  reporter?: string;
  /** True if the run used the mock transport. */
  mocked: boolean;
}

export function buildReport(input: BuildReportInput): HardwareReport {
  const usb = input.device.transports.usb;
  const primaryRung = input.primarySession.rung;
  const primaryMedia = input.primarySession.media;
  if (primaryRung === null || primaryMedia === null) {
    throw new Error('buildReport: primary session must have rung and media set.');
  }
  const transportReport: TransportReport = {
    name: 'usb',
    patterns: { diagnostic: 'pass' },
    rung: primaryRung,
    ...(input.primarySession.notes.trim() ? { notes: input.primarySession.notes.trim() } : {}),
  };

  const detected: IdentitySnapshot = {
    ...input.identity,
    extra: { ...input.identity.extra, ...(input.mocked ? { mocked: true } : {}) },
  };

  const engineReports: EngineReport[] = input.allSessions.flatMap<EngineReport>(s => {
    if (s.rung === null || s.media === null) return [];
    return [
      {
        role: s.engine.role,
        mediaKey: String(s.media.id),
        rung: s.rung,
        ...(s.notes.trim() ? { notes: s.notes.trim() } : {}),
      },
    ];
  });

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
        overrides: { label: String(primaryMedia.id) },
      },
    },
    transports: [transportReport],
    ...(input.multiEngine && engineReports.length > 0 ? { engines: engineReports } : {}),
    submittedAt: new Date().toISOString(),
    ...(input.reporter ? { reporter: { handle: input.reporter } } : {}),
  };
}

export function buildIssueTitle(report: HardwareReport): string {
  const model = report.device.confirmed.model;
  const transports = report.transports.map(t => `${t.name}=${t.rung}`).join(' / ');
  const enginesSummary =
    report.engines && report.engines.length > 0
      ? ` [${report.engines.map(e => `${e.role}=${e.rung}`).join(' / ')}]`
      : '';
  return `[harness] ${model} — ${transports || 'unverified'}${enginesSummary}`;
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
