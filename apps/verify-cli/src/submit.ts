/**
 * Submit a rendered `IssueBody` to the relevant driver repo's issue
 * tracker.
 *
 * Priority order (plan 05 §decisions):
 *   1. `gh issue create` if `gh` is installed and authenticated.
 *   2. Print a prefilled `https://github.com/.../issues/new?...` URL
 *      to the terminal.
 *   3. Copy the JSON to the clipboard (best-effort) and show an email
 *      fallback. Don't lose the report.
 *
 * The submit code path is reused by every driver; selection between
 * paths is global so the user gets consistent UX. Per-driver concerns
 * are limited to the issue title and the target `owner/repo`.
 *
 * `--dry-run` callers never reach this function — the verify flow
 * short-circuits to stdout before submit.
 */
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

const MAX_PREFILL_URL_LENGTH = 7_500; // GitHub truncates ~8 KB; stay clear.

/**
 * Best-effort cross-platform "open in default browser." Returns the
 * launcher used (or `null` if no plausible launcher is available, which
 * is rare on real systems).
 *
 * Detached + unref'd so the harness exit doesn't kill the browser
 * window. Stdio ignored — we don't care about the launcher's chatter.
 */
export function openInBrowser(url: string): string | null {
  const p = platform();
  if (p === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return 'open';
  }
  if (p === 'win32') {
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    return 'start';
  }
  // Linux / BSD: xdg-open is the de-facto standard. If it's missing the
  // spawn errors silently — caller still has the URL printed to stdout.
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  return 'xdg-open';
}

export interface SubmitTarget {
  /** GitHub `owner/repo` for the driver repo (e.g. `thermal-label/labelmanager`). */
  repo: string;
  /** Issue title. */
  title: string;
  /** Issue body (already rendered by `renderIssueBody`). */
  body: string;
  /** Maintainer fallback email shown when clipboard copy is the last resort. */
  fallbackEmail: string;
}

export interface SubmitResult {
  path: 'gh-cli' | 'prefill-url' | 'clipboard-fallback';
  detail?: string;
}

export async function submitIssue(target: SubmitTarget): Promise<SubmitResult> {
  if (await isGhAvailable()) {
    return submitViaGh(target);
  }
  return submitViaPrefillUrl(target);
}

async function isGhAvailable(): Promise<boolean> {
  // `gh auth status` exits 0 only when authenticated. Path 1 in plan 05
  // §decisions is "installed AND authenticated" — checking both with
  // one process invocation.
  return new Promise(resolve => {
    const child = spawn('gh', ['auth', 'status'], { stdio: 'ignore' });
    child.once('error', () => {
      resolve(false);
    });
    child.once('exit', code => {
      resolve(code === 0);
    });
  });
}

async function submitViaGh(target: SubmitTarget): Promise<SubmitResult> {
  return new Promise((resolve, reject) => {
    const args = [
      'issue',
      'create',
      '--repo',
      target.repo,
      '--title',
      target.title,
      '--body',
      target.body,
    ];
    const child = spawn('gh', args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) {
        resolve({ path: 'gh-cli', detail: stdout.trim() });
      } else {
        reject(new Error(`gh issue create exited with code ${String(code)}`));
      }
    });
  });
}

function submitViaPrefillUrl(target: SubmitTarget): SubmitResult {
  const url = buildPrefillUrl(target);
  if (url.length <= MAX_PREFILL_URL_LENGTH) {
    return { path: 'prefill-url', detail: url };
  }
  // The URL is too long for GitHub's prefill — fall through to
  // clipboard + email rather than losing the report. Plan 05 §decisions
  // priority 3.
  return { path: 'clipboard-fallback', detail: target.fallbackEmail };
}

export function buildPrefillUrl(target: SubmitTarget): string {
  const params = new URLSearchParams({ title: target.title, body: target.body });
  return `https://github.com/${target.repo}/issues/new?${params.toString()}`;
}
