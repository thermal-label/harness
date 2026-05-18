import type { EngineReport, HardwareReport, TransportReport } from './hardware-report.js';

const RUNG_LABEL: Record<TransportReport['rung'], string> = {
  verified: 'verified',
  partial: 'partial',
  failing: 'failing',
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
  const envLine = renderEnvironmentLine(report);
  const transportLines = report.transports.map(renderTransportLine);
  const engineBlock = renderEnginesBlock(report);
  const notesBlock = renderOperatorNotes(report);

  const sections = [headline];
  if (envLine) sections.push(envLine);
  sections.push(...transportLines);
  if (engineBlock) sections.push(engineBlock);
  if (notesBlock) sections.push(notesBlock);
  sections.push(renderJsonBlock(report));

  return `${sections.join('\n\n')}\n`;
}

function renderHeadline(report: HardwareReport): string {
  const model = report.device.confirmed.model;
  const transports = report.transports.map(t => t.name).join(', ');
  const overallRung = pickHeadlineRung(report);
  return `## ${model} on ${transports} — ${RUNG_LABEL[overallRung]}`;
}

/**
 * The headline carries one rung even when the report covers multiple
 * transports. Rule: worst rung wins (failing beats partial beats
 * verified) — matches how a human would summarise "two transports tested,
 * one broke" at a glance.
 */
function pickHeadlineRung(report: HardwareReport): TransportReport['rung'] {
  const rungs = new Set(report.transports.map(t => t.rung));
  if (rungs.has('failing')) return 'failing';
  if (rungs.has('partial')) return 'partial';
  return 'verified';
}

/**
 * One-line environment note rendered under the headline — the browser
 * + OS the report was captured on. Absent when the report carries no
 * `environment` block (the CLI runtime, or a pre-environment build).
 */
function renderEnvironmentLine(report: HardwareReport): string | undefined {
  const env = report.environment;
  if (!env) return undefined;
  const os = env.osVersion ? `${env.os} ${env.osVersion}` : env.os;
  let runtime: string;
  if (env.runtime === 'node') {
    runtime = env.nodeVersion ? `Node.js ${env.nodeVersion}` : 'Node.js';
  } else {
    const browser = env.browser ?? 'browser';
    runtime = env.browserVersion ? `${browser} ${env.browserVersion}` : browser;
  }
  return `_Captured on ${runtime} · ${os}._`;
}

function renderTransportLine(transport: TransportReport): string {
  const patternEntries = Object.entries(transport.patterns);
  const glyphs = patternEntries.map(([id, result]) => `${id} ${RESULT_GLYPH[result]}`).join('  ');
  const head = `**${transport.name}** — ${RUNG_LABEL[transport.rung]}`;
  // The operator note is not appended here — it stands on its own as a
  // blockquote (`renderOperatorNotes`); the line stays rung + glyphs.
  return `${head}\n\n${glyphs}`;
}

/**
 * Per-engine block rendered for multi-engine devices (Twin Turbo,
 * Duo). Absent on single-engine reports — the parser falls back to the
 * transport-level rung in that case.
 *
 * Each engine line: role, label/cassette key, rung, optional note.
 * Coverage is communicated by which engines appear: a Duo report with
 * only `label` listed signals "tape was not exercised", which plan
 * 04's triage maps to amber-with-`(label only)` on the matrix cell.
 */
function renderEnginesBlock(report: HardwareReport): string | undefined {
  const engines = report.engines;
  if (!engines || engines.length === 0) return undefined;
  const lines = engines.map(renderEngineLine);
  return ['**Engines**', ...lines].join('\n');
}

function renderEngineLine(engine: EngineReport): string {
  const note = engine.notes ? ` — ${engine.notes}` : '';
  return `- \`${engine.role}\` (${engine.mediaKey}) — ${RUNG_LABEL[engine.rung]}${note}`;
}

/**
 * Operator notes block — the free-text caveats the operator typed,
 * rendered as a standalone Markdown blockquote so each note stands on
 * its own rather than riding on a transport's glyph line. Absent when
 * no transport carries a note.
 */
function renderOperatorNotes(report: HardwareReport): string | undefined {
  const notes = report.transports.map(t => t.notes).filter((n): n is string => Boolean(n));
  if (notes.length === 0) return undefined;
  return notes.map(n => `> ${n}`).join('\n');
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
