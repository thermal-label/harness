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
 * Niimbot-RFID block as it lands on `NiimbotStatus.rfid`. Defined here
 * (rather than imported from niimbot-core) so the shell stays
 * driver-agnostic at the type layer — the shape is duck-typed off
 * whatever the driver puts on `status.rfid`.
 */
export interface RfidBlock {
  source?: 'paper' | 'ribbon';
  uuid?: string;
  barcode?: string;
  serialNumber?: string;
  allPaper?: number;
  usedPaper?: number;
  labelType?: number;
  capacity?: number;
  rawHex?: string;
}

/**
 * Pretty-print an RFID payload for the catalogue-contribution issue
 * body. Lists only the fields the niimbot parser populated; ends with a
 * fenced hex dump when the raw bytes are available. The maintainer
 * pastes this verbatim into a new `media.json5` entry — barcode +
 * labelType become catalogue fields; allPaper / usedPaper are
 * roll-instance forensics that survive in the report.
 */
export function renderRfidBlock(rfid: RfidBlock): string {
  const lines: string[] = ['', 'RFID payload (from `0x1A` / `0x1C`):'];
  if (rfid.source !== undefined) lines.push(`- source: ${rfid.source}`);
  if (rfid.uuid !== undefined) lines.push(`- uuid: ${rfid.uuid}`);
  if (rfid.barcode !== undefined) lines.push(`- barcode: ${rfid.barcode}`);
  if (rfid.serialNumber !== undefined) lines.push(`- serialNumber: ${rfid.serialNumber}`);
  if (rfid.allPaper !== undefined) lines.push(`- allPaper: ${String(rfid.allPaper)}`);
  if (rfid.usedPaper !== undefined) lines.push(`- usedPaper: ${String(rfid.usedPaper)}`);
  if (rfid.labelType !== undefined) lines.push(`- labelType: ${String(rfid.labelType)}`);
  if (rfid.capacity !== undefined) lines.push(`- capacity: ${String(rfid.capacity)}`);
  if (rfid.rawHex !== undefined) {
    lines.push('', 'Raw RFID payload (hex):', '```', rfid.rawHex, '```');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Prefilled "catalogue this new RFID barcode" GitHub issue, mirroring
 * the LW 5xx unrecognized-NFC flow for niimbot. Fires once the operator
 * has confirmed physical dimensions in the `detected-unrecognized`
 * panel (the synthetic media id starts with `unknown-`), so the body
 * carries everything the maintainer needs to append a `media.json5`
 * entry without a second round-trip.
 */
export function buildRfidCatalogueIssue(opts: {
  driver: string;
  targetRepo: string;
  device: string;
  rfid: RfidBlock;
  /** Operator-confirmed media (from `customMedia.build`). */
  confirmedMedia?: {
    widthMm?: number;
    heightMm?: number;
    type?: string;
    name?: string;
  } | null;
}): { url: string; title: string; body: string } {
  const { driver, targetRepo, device, rfid, confirmedMedia } = opts;
  const w =
    typeof confirmedMedia?.widthMm === 'number' && confirmedMedia.widthMm > 0
      ? String(confirmedMedia.widthMm)
      : '?';
  const h =
    typeof confirmedMedia?.heightMm === 'number' && confirmedMedia.heightMm > 0
      ? String(confirmedMedia.heightMm)
      : confirmedMedia?.type === 'continuous'
        ? 'continuous'
        : '?';
  const barcode = rfid.barcode ?? '(unknown)';
  const title = `media(${driver}): catalogue new barcode ${barcode} (${w}×${h})`;
  const dimsLine =
    confirmedMedia?.type === 'continuous'
      ? `- Width: ${w} mm (continuous)`
      : `- Dimensions: ${w} × ${h} mm`;
  const identifierLine = confirmedMedia?.name
    ? `- Operator identifier: ${confirmedMedia.name}\n`
    : '';
  const intro =
    `The harness read an RFID tag whose barcode isn't in ` +
    `\`niimbot/packages/core/data/media.json5\` yet. Operator-confirmed ` +
    `physical dimensions below; full RFID payload pretty-printed for the ` +
    `new catalogue entry.`;
  const footer =
    `Please append a new entry to \`media.json5\` using the barcode + ` +
    `labelType above and the operator-confirmed dimensions.`;
  const body = `${intro}

Driver: ${driver}
Device: ${device}

Operator-confirmed dimensions:
${dimsLine}
- Type: ${confirmedMedia?.type ?? '(not confirmed)'}
${identifierLine}${renderRfidBlock(rfid)}
${footer}
`;
  const url = buildPrefillUrl(targetRepo, title, body);
  return { url, title, body };
}

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
  /**
   * Did the browser open the prefilled issue tab? Always `false` for
   * `prefill: 'title'` — that path is operator-driven (copy first,
   * then open), so the tab is never auto-opened.
   */
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
 * Submit the report as a prefilled GitHub issue.
 *
 * When the title + body fit GitHub's prefill-URL limit, the fully
 * prefilled issue is opened straight away (`prefill: 'full'`).
 *
 * When the body overflows, `prefill: 'title'` is returned *without*
 * opening anything: the caller guides the operator to copy the report
 * first, then open the title-only issue, then paste. Auto-opening
 * there would strand them on a near-empty GitHub page with no cue that
 * the body is waiting back in the harness tab.
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
    // Body fits — open the fully prefilled issue straight away.
    return { opened: openIssueTab(fullUrl), url: fullUrl, prefill: 'full' };
  }

  // Body overflows the prefill URL. Deliberately do NOT auto-open the
  // tab — the operator copies the report here first, then opens the
  // (title-only) issue via the guided recovery step. Auto-opening would
  // drop them on a near-empty GitHub page with no cue to come back.
  const titleUrl = buildPrefillUrl(targetRepo, title, '');
  return { opened: false, url: titleUrl, prefill: 'title' };
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
