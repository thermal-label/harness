/**
 * Labelmanager verify flow.
 *
 * Wizard by default; expert flags bypass prompts wholesale (plan 05
 * §decisions). Maintainer self-validation against owned hardware
 * typically lands on the all-flags one-liner; community-style runs use
 * the wizard.
 *
 * Flow:
 *   1. Resolve model (flag or pick-from-registry prompt).
 *   2. Resolve transport — labelmanager today is USB-only.
 *   3. Connect via `UsbTransport` + identity probe (status query).
 *   4. Build the diagnostic-print bitmap, encode bytes, write to the
 *      bulk OUT endpoint.
 *   5. Operator inspects what came out, picks the rung + free-text
 *      notes (skipped under flags).
 *   6. Render `IssueBody`. Submit lands in the next commit; today the
 *      rendered body is printed to stdout regardless of `--dry-run`.
 */
import { DEVICES, type LabelManagerDevice } from '@thermal-label/labelmanager-core';
import {
  DeviceNotFoundError,
  TransportClosedError,
  type TransportType,
} from '@thermal-label/contracts';
import {
  renderIssueBody,
  transportInstructions,
  type HardwareReport,
  type IdentitySnapshot,
  type ProposedRung,
  type TransportReport,
} from '@thermal-label/harness-core/shared';
import type { VerifyOptions } from '../../verify.js';
import {
  NoPromptError,
  promptConfirm,
  promptInput,
  promptSelect,
  type PromptContext,
} from '../../prompts.js';
import { connectLabelmanager, writeDiagnosticPrint } from './connect.js';
import { buildDiagnosticBitmap, encodeBitmap } from './diagnostic-print.js';
import { submitIssue, buildPrefillUrl, openInBrowser } from '../../submit.js';
import { renderBitmapPreview } from '../../bitmap-preview.js';
import type { LabelBitmap } from '@mbtech-nl/bitmap';

const DRIVER_KEY = 'labelmanager';
const HARNESS_VERSION = '0.0.0';
const DRIVER_VERSION = '0.5.1';
const DEFAULT_TAPE_WIDTH = 12 as const;
const TARGET_REPO = 'thermal-label/labelmanager';
const FALLBACK_EMAIL = 'mannes@krukje.nl';

const SUPPORTED_TRANSPORTS: readonly TransportType[] = ['usb'];

const RUNG_CHOICES: readonly { value: ProposedRung; name: string; description: string }[] = [
  {
    value: 'verified',
    name: 'verified — looks right end-to-end',
    description: 'Print is legible, edges/cutter behave, no glaring artefacts.',
  },
  {
    value: 'partial',
    name: 'partial — works, but with caveats',
    description: 'Some aspect (margin, cutter, density, occasional drop) is off.',
  },
  {
    value: 'unsupported',
    name: 'unsupported — known-broken on this build',
    description: 'Bytes go out but the printer produces nothing usable.',
  },
];

export async function runLabelmanagerVerify(options: VerifyOptions): Promise<void> {
  const ctx: PromptContext = { noPrompt: !options.wizard };

  const device = await resolveDevice(options, ctx);
  const transport = await resolveTransport(options, ctx);
  const tapeWidth = options.tapeWidth ?? DEFAULT_TAPE_WIDTH;

  printSessionHeader(device, transport, tapeWidth);

  // Build the bitmap up front so `--preview` can show it before any
  // hardware contact, and so dry-run + preview is a useful combo
  // (see what's about to print without needing a printer).
  const bitmap = buildDiagnosticBitmap({
    device,
    tapeWidth,
    harnessVersion: HARNESS_VERSION,
    driverVersion: DRIVER_VERSION,
  });

  if (options.preview) {
    console.log(renderBitmapPreview(bitmap));
    console.log('');
  }

  const identity = await runConnect(device, options, bitmap, tapeWidth);

  const rung = await resolveRung(options, ctx);
  const notes = await resolveNotes(options, ctx);

  const report = buildReport({
    device,
    detectedIdentity: identity,
    transport,
    rung,
    notes,
    reporter: options.reporter,
  });

  const body = renderIssueBody(report);

  if (options.dryRun) {
    // Test path — render to stdout, never submit.
    process.stdout.write(body);
    return;
  }

  // Optional submit step. `--no-submit` is the non-interactive bypass;
  // wizard mode asks. Either way: skip-submit prints the body to stdout
  // so the operator can iterate on the print (re-run the command) and
  // file later by hand.
  const shouldSubmit = await resolveShouldSubmit(options, ctx);
  if (!shouldSubmit) {
    console.log('');
    console.log('Skipping submit. The rendered issue body is below — re-run the');
    console.log('command to print again, or paste this body into a new issue when');
    console.log('you are ready.');
    console.log('');
    process.stdout.write(body);
    return;
  }

  const title = buildIssueTitle(report);
  const result = await submitIssue({
    repo: TARGET_REPO,
    title,
    body,
    fallbackEmail: FALLBACK_EMAIL,
  });

  console.log('');
  switch (result.path) {
    case 'gh-cli':
      console.log(`Filed via gh: ${result.detail ?? '(unknown URL)'}`);
      console.log("Have a photo? Drop it into that issue's comment thread.");
      return;
    case 'prefill-url': {
      const url = result.detail ?? '';
      console.log('gh CLI not available. Opening this URL in your browser:');
      console.log('');
      console.log(url);
      console.log('');
      const launcher = openInBrowser(url);
      if (launcher) {
        console.log(`(Tried ${launcher}; if nothing opened, copy the URL above.)`);
      }
      console.log("Have a photo? Drop it into the issue's comment thread after submit.");
      return;
    }
    case 'clipboard-fallback':
      console.log(
        "Prefill URL would exceed GitHub's limit. Copy the JSON below into a new issue " +
          `at https://github.com/${TARGET_REPO}/issues/new manually, or email it to ` +
          `${result.detail ?? FALLBACK_EMAIL}:`,
      );
      console.log('');
      console.log(body);
      // Surface the raw prefill URL too in case it works despite our
      // length guard — GitHub's actual limit varies per browser.
      console.log('');
      console.log(
        `(prefill URL, may exceed limits: ${buildPrefillUrl({
          repo: TARGET_REPO,
          title,
          body,
          fallbackEmail: FALLBACK_EMAIL,
        })})`,
      );
      return;
    default: {
      const _exhaustive: never = result.path;
      throw new Error(`Unhandled submit path: ${String(_exhaustive)}`);
    }
  }
}

function buildIssueTitle(report: HardwareReport): string {
  const transport = report.transports[0];
  const model = report.device.confirmed.model;
  const rung = transport ? transport.rung : 'unverified';
  return `[harness] ${model} on ${transport?.name ?? 'unknown'} — ${rung}`;
}

function printSessionHeader(
  device: LabelManagerDevice,
  transport: TransportType,
  tapeWidth: 6 | 9 | 12 | 19,
): void {
  console.log('');
  console.log(`Driver:    ${DRIVER_KEY} (core ${DRIVER_VERSION}, harness ${HARNESS_VERSION})`);
  console.log(`Model:     ${device.name}  [${device.key}]`);
  console.log(`Transport: ${transport}`);
  console.log(`Tape:      ${String(tapeWidth)} mm`);
  console.log('');
  console.log(transportInstructions[transport].inline);
  console.log('');
}

async function runConnect(
  device: LabelManagerDevice,
  options: VerifyOptions,
  bitmap: LabelBitmap,
  tapeWidth: 6 | 9 | 12 | 19,
): Promise<IdentitySnapshot> {
  if (options.dryRun) {
    return synthesiseIdentity(device);
  }

  console.log('Connecting over USB...');
  let session;
  try {
    session = await connectLabelmanager(device);
  } catch (err) {
    if (err instanceof DeviceNotFoundError) {
      throw new Error(
        `No USB device found matching ${device.key} (vid=0x${device.transports.usb?.vid ?? '?'} ` +
          `pid=0x${device.transports.usb?.pid ?? '?'}). Plug it in or pass --dry-run to ` +
          `exercise the rendering path without hardware.`,
      );
    }
    throw err;
  }

  console.log(
    `Connected. vid=0x${session.identity.vid?.toString(16) ?? '?'} ` +
      `pid=0x${session.identity.pid?.toString(16) ?? '?'}`,
  );

  console.log('Encoding diagnostic print...');
  const bytes = encodeBitmap(bitmap, tapeWidth);
  console.log(`Sending ${String(bytes.length)} bytes to printer...`);
  try {
    await writeDiagnosticPrint(session.transport, bytes);
  } catch (err) {
    if (err instanceof TransportClosedError) {
      throw new Error(
        'USB transport closed mid-write. Check the cable / device power; ' +
          'no bytes were buffered, so re-running is safe.',
      );
    }
    throw err;
  }
  console.log('Diagnostic print sent.');

  await session.transport.close();
  return session.identity;
}

async function resolveDevice(
  options: VerifyOptions,
  ctx: PromptContext,
): Promise<LabelManagerDevice> {
  const known = Object.values(DEVICES);

  if (options.model !== undefined) {
    const match = known.find(d => d.key === options.model);
    if (!match) {
      throw new Error(
        `Unknown labelmanager model "${options.model}". Known keys:\n  ${known
          .map(d => d.key)
          .join('\n  ')}`,
      );
    }
    return match;
  }

  if (ctx.noPrompt) throw new NoPromptError('model');

  const key = await promptSelect<string>(
    ctx,
    'model',
    'Pick a labelmanager model:',
    known.map(d => ({ value: d.key, name: `${d.name}  [${d.key}]` })),
  );
  const found = known.find(d => d.key === key);
  if (!found) throw new Error(`Picked unknown key ${key}`);
  return found;
}

async function resolveTransport(
  options: VerifyOptions,
  ctx: PromptContext,
): Promise<TransportType> {
  if (options.transport !== undefined) {
    if (!SUPPORTED_TRANSPORTS.includes(options.transport)) {
      throw new Error(
        `labelmanager only speaks ${SUPPORTED_TRANSPORTS.join(', ')} today; ` +
          `got "${options.transport}".`,
      );
    }
    return options.transport;
  }

  const [only, ...rest] = SUPPORTED_TRANSPORTS;
  if (only !== undefined && rest.length === 0) {
    return only;
  }

  return promptSelect<TransportType>(
    ctx,
    'transport',
    'Pick a transport:',
    SUPPORTED_TRANSPORTS.map(t => ({ value: t, name: t })),
  );
}

async function resolveRung(options: VerifyOptions, ctx: PromptContext): Promise<ProposedRung> {
  if (options.rung !== undefined) return options.rung;
  return promptSelect<ProposedRung>(
    ctx,
    'rung',
    'How does the diagnostic print look?',
    RUNG_CHOICES,
  );
}

async function resolveShouldSubmit(options: VerifyOptions, ctx: PromptContext): Promise<boolean> {
  // Explicit `--no-submit` always wins, regardless of wizard mode.
  if (options.noSubmit) return false;
  // Non-interactive default: submit (matches the maintainer one-liner
  // for self-validating known-good hardware).
  if (ctx.noPrompt) return true;
  // Wizard: ask. Default to submit-yes because that's the common path
  // and re-running for another print is cheap.
  return promptConfirm(ctx, 'submit', 'Submit this report now?', true);
}

async function resolveNotes(
  options: VerifyOptions,
  ctx: PromptContext,
): Promise<string | undefined> {
  if (options.notes !== undefined) return options.notes;
  if (ctx.noPrompt) return undefined;
  const confirmAdd = await promptConfirm(
    ctx,
    'notes',
    'Add a free-text note about what came out? (e.g. "left edge clipped")',
    false,
  );
  if (!confirmAdd) return undefined;
  const text = await promptInput(ctx, 'notes', 'Notes:');
  return text.trim() || undefined;
}

interface BuildReportInput {
  device: LabelManagerDevice;
  detectedIdentity: IdentitySnapshot;
  transport: TransportType;
  rung: ProposedRung;
  notes: string | undefined;
  reporter: string | undefined;
}

function synthesiseIdentity(device: LabelManagerDevice): IdentitySnapshot {
  const usb = device.transports.usb;
  return {
    advertisedName: device.name,
    ...(usb ? { vid: parseInt(usb.vid, 16), pid: parseInt(usb.pid, 16) } : {}),
    extra: { synthesised: true, source: 'dry-run-fallback' },
  };
}

function buildReport(input: BuildReportInput): HardwareReport {
  const usb = input.device.transports.usb;

  const transportReport: TransportReport = {
    name: input.transport,
    patterns: { diagnostic: 'pass' },
    rung: input.rung,
    ...(input.notes ? { notes: input.notes } : {}),
  };

  return {
    schemaVersion: 1,
    driver: DRIVER_KEY,
    driverVersion: DRIVER_VERSION,
    harnessVersion: HARNESS_VERSION,
    device: {
      detected: input.detectedIdentity,
      confirmed: {
        model: input.device.name,
        ...(usb ? { vid: parseInt(usb.vid, 16), pid: parseInt(usb.pid, 16) } : {}),
      },
    },
    transports: [transportReport],
    submittedAt: new Date().toISOString(),
    ...(input.reporter ? { reporter: { handle: input.reporter } } : {}),
  };
}
