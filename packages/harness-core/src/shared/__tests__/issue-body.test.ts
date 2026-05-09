import { describe, expect, it } from 'vitest';
import type { HardwareReport } from '../hardware-report.js';
import { renderIssueBody } from '../issue-body.js';

const baseReport: HardwareReport = {
  schemaVersion: 1,
  driver: 'brother-ql',
  driverVersion: '0.4.2',
  harnessVersion: '0.1.0',
  device: {
    detected: {
      advertisedName: 'QL-820NWB',
      vid: 0x04f9,
      pid: 0x209d,
    },
    confirmed: {
      model: 'QL-820NWB',
      vid: 0x04f9,
      pid: 0x209d,
    },
  },
  transports: [
    {
      name: 'usb',
      patterns: { T1: 'pass', T2: 'pass', T3: 'fail' },
      rung: 'partial',
      notes: 'cut blade jams on continuous',
    },
  ],
  submittedAt: '2026-05-07T10:00:00.000Z',
  reporter: { handle: 'mannes' },
};

describe('renderIssueBody', () => {
  it('opens with a Markdown headline naming the model + transports + rung', () => {
    const out = renderIssueBody(baseReport);
    expect(out.split('\n')[0]).toBe('## QL-820NWB on usb — partial');
  });

  it('embeds the full report as a fenced json block inside <details>', () => {
    const out = renderIssueBody(baseReport);
    expect(out).toContain('<details>');
    expect(out).toContain('<summary>Machine-readable report</summary>');
    expect(out).toContain('```json');
    expect(out).toContain('```');
    expect(out).toContain('</details>');

    // Plan 04's parser greps for ```json and parses what it finds.
    const match = /```json\n([\s\S]*?)\n```/.exec(out);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(match![1]!) as HardwareReport;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.driver).toBe('brother-ql');
    expect(parsed.transports[0]?.rung).toBe('partial');
  });

  it('renders pattern glyphs per result kind', () => {
    const out = renderIssueBody(baseReport);
    expect(out).toContain('T1 [pass]');
    expect(out).toContain('T2 [pass]');
    expect(out).toContain('T3 [fail]');
  });

  it('quotes operator notes and attributes them when reporter handle is set', () => {
    const out = renderIssueBody(baseReport);
    expect(out).toContain('> cut blade jams on continuous');
    expect(out).toContain('— mannes');
  });

  it('omits the notes block when no transport carries notes', () => {
    const noNotesTransport = { ...baseReport.transports[0]! };
    delete (noNotesTransport as { notes?: string }).notes;
    const out = renderIssueBody({
      ...baseReport,
      transports: [noNotesTransport],
    });
    // Markdown blockquote lines (`> `) appear only in the operator-notes
    // block; the embedded JSON's `</details>` is a different glyph context.
    expect(out).not.toMatch(/^> /m);
  });

  it('uses the worst rung for the headline when transports disagree', () => {
    const mixed: HardwareReport = {
      ...baseReport,
      transports: [
        { name: 'usb', patterns: { T1: 'pass' }, rung: 'verified' },
        {
          name: 'tcp',
          patterns: { T1: 'fail' },
          rung: 'unsupported',
        },
      ],
    };
    const out = renderIssueBody(mixed);
    expect(out.split('\n')[0]).toContain('— unsupported');
  });

  it('round-trips JSON.stringify -> parse with all fields preserved', () => {
    const out = renderIssueBody(baseReport);
    const match = /```json\n([\s\S]*?)\n```/.exec(out)!;
    const parsed = JSON.parse(match[1]!) as HardwareReport;
    expect(parsed).toEqual(baseReport);
  });

  it('renders an Engines block when report.engines is populated', () => {
    const multi: HardwareReport = {
      ...baseReport,
      engines: [
        { role: 'label', mediaKey: 'address-standard', rung: 'verified' },
        { role: 'tape', mediaKey: 'd1-standard-bw-12', rung: 'partial', notes: 'faint print' },
      ],
    };
    const out = renderIssueBody(multi);
    expect(out).toContain('**Engines**');
    expect(out).toContain('- `label` (address-standard) — verified');
    expect(out).toContain('- `tape` (d1-standard-bw-12) — partial — faint print');
  });

  it('omits the Engines block on single-engine reports (back-compat)', () => {
    const out = renderIssueBody(baseReport);
    expect(out).not.toContain('**Engines**');
  });

  it('emits a partial engines array (one of N engines tested) without a fuss', () => {
    const partial: HardwareReport = {
      ...baseReport,
      engines: [{ role: 'label', mediaKey: 'address-standard', rung: 'verified' }],
    };
    const out = renderIssueBody(partial);
    expect(out).toContain('**Engines**');
    expect(out).toContain('- `label` (address-standard) — verified');
    // Only the assessed engine appears; the omitted one is the partial-coverage signal.
    expect(out).not.toContain('`tape`');
  });
});
