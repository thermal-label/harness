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
import { encodeDiagnosticPrint } from './diagnostic-print.js';

const DRIVER_KEY = 'labelmanager';
const HARNESS_VERSION = '0.0.0';
const DRIVER_VERSION = '0.5.1';
const DEFAULT_TAPE_WIDTH = 12 as const;

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

  const identity = await runConnect(device, options, tapeWidth);

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

  // Submit-flow path lands in plan 05 step 5; for now both modes print
  // the rendered body to stdout. `--dry-run` is the explicit signal
  // that this is the test path.
  process.stdout.write(renderIssueBody(report));
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
  const bytes = encodeDiagnosticPrint({
    device,
    tapeWidth,
    harnessVersion: HARNESS_VERSION,
    driverVersion: DRIVER_VERSION,
  });
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

  if (SUPPORTED_TRANSPORTS.length === 1) {
    return SUPPORTED_TRANSPORTS[0]!;
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
