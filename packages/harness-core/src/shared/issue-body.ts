import type { HardwareReport, TransportReport } from './hardware-report.js';

const RUNG_LABEL: Record<TransportReport['rung'], string> = {
  verified: 'verified',
  partial: 'partial',
  unsupported: 'unsupported',
};

const RESULT_GLYPH = {
  pass: '[pass]',
  fail: '[fail]',
  skipped: '[skip]',
} as const;

/**
 * Serialize a `HardwareReport` into a GitHub issue body, hybrid shape:
 * human-readable prose summary on top, fenced JSON block at the bottom in a
 * collapsed `<details>` for the parser.
 *
 * Plan 04's parser greps for the fenced ` ```json ` block and parses it
 * directly — the prose above is for the maintainer's eyes only. No marker
 * field, no hidden HTML comment, no rigid form-prefill schema.
 *
 * Two submission paths feed the parser:
 *  - Harness-generated body (this function) — contains the JSON block.
 *  - Manual issue-form body (no harness, see plan 04) — no JSON block;
 *    parser routes to maintainer-eyeball review.
 */
export function renderIssueBody(report: HardwareReport): string {
  const headline = renderHeadline(report);
  const transportLines = report.transports.map(renderTransportLine);
  const notesBlock = renderOperatorNotes(report);

  const sections = [headline, ...transportLines];
  if (notesBlock) sections.push(notesBlock);
  sections.push(renderJsonBlock(report));

  return `${sections.join('\n\n')}\n`;
}

function renderHeadline(report: HardwareReport): string {
  const model = report.device.confirmed.model;
  const transports = report.transports.map((t) => t.name).join(', ');
  const overallRung = pickHeadlineRung(report);
  return `## ${model} on ${transports} — ${RUNG_LABEL[overallRung]}`;
}

/**
 * The headline carries one rung even when the report covers multiple
 * transports. Rule: worst rung wins (unsupported beats partial beats
 * verified) — matches how a human would summarise "two transports tested,
 * one broke" at a glance.
 */
function pickHeadlineRung(report: HardwareReport): TransportReport['rung'] {
  const rungs = new Set(report.transports.map((t) => t.rung));
  if (rungs.has('unsupported')) return 'unsupported';
  if (rungs.has('partial')) return 'partial';
  return 'verified';
}

function renderTransportLine(transport: TransportReport): string {
  const patternEntries = Object.entries(transport.patterns);
  const glyphs = patternEntries
    .map(([id, result]) => `${id} ${RESULT_GLYPH[result]}`)
    .join('  ');
  const head = `**${transport.name}** — ${RUNG_LABEL[transport.rung]}`;
  const note = transport.notes ? ` — ${transport.notes}` : '';
  return `${head}\n\n${glyphs}${note}`;
}

function renderOperatorNotes(report: HardwareReport): string | undefined {
  const notes = report.transports
    .map((t) => t.notes)
    .filter((n): n is string => Boolean(n));
  if (notes.length === 0) return undefined;
  // Reporter attribution is intentionally light — plan 03 keeps PII opt-in.
  const reporter = report.reporter?.handle ? ` — ${report.reporter.handle}` : '';
  const quoted = notes.map((n) => `> ${n}`).join('\n');
  return `${quoted}${reporter}`;
}

function renderJsonBlock(report: HardwareReport): string {
  const json = JSON.stringify(report, null, 2);
  return [
    '<details>',
    '<summary>Machine-readable report</summary>',
    '',
    '```json',
    json,
    '```',
    '',
    '</details>',
  ].join('\n');
}
