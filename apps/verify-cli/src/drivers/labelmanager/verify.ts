/**
 * Labelmanager verify flow.
 *
 * Wizard by default; expert flags bypass prompts wholesale (plan 05
 * §decisions). Maintainer self-validation against owned hardware
 * typically lands on the all-flags one-liner; community-style runs use
 * the wizard.
 *
 * Steps:
 *   1. Resolve model (flag or pick-from-registry prompt).
 *   2. Resolve transport — labelmanager today is USB-only; if the user
 *      passes anything else we error out early.
 *   3. Connect (wired in step 4 of plan 05's commit ordering).
 *   4. Identity confirm.
 *   5. "Print diagnostic now?" + send bytes.
 *   6. Operator assessment (rung + notes).
 *   7. Submit (or dry-run print).
 */
import { DEVICES, type LabelManagerDevice } from '@thermal-label/labelmanager-core';
import type { TransportType } from '@thermal-label/contracts';
import type {
  HardwareReport,
  ProposedRung,
  TransportReport,
} from '@thermal-label/harness-core/shared';
import { transportInstructions } from '@thermal-label/harness-core/shared';
import type { VerifyOptions } from '../../verify.js';
import {
  NoPromptError,
  promptConfirm,
  promptInput,
  promptSelect,
  type PromptContext,
} from '../../prompts.js';

const DRIVER_KEY = 'labelmanager';
// Pinned harness-app version — bumped manually as the verify-cli evolves.
// Surfaces in the issue body so triage can correlate output to the harness
// build that produced it.
const HARNESS_VERSION = '0.0.0';
// Read once from the labelmanager core's `package.json` at runtime would be
// nicer, but adding a JSON import for one field isn't worth it; bump on
// driver-core upgrades. The matching version is in `package.json` deps.
const DRIVER_VERSION = '0.5.1';

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

  console.log('');
  console.log(`Driver:    ${DRIVER_KEY} (core ${DRIVER_VERSION}, harness ${HARNESS_VERSION})`);
  console.log(`Model:     ${device.name}  [${device.key}]`);
  console.log(`Transport: ${transport}`);
  console.log('');
  console.log(transportInstructions[transport].inline);
  console.log('');

  // Connect step lands in the next commit. Today the wizard stops here
  // unless --dry-run was passed — dry-run mode renders an IssueBody with
  // mock probe data so the smoke test of plan 05 step 6 has something to
  // exercise.
  if (!options.dryRun) {
    throw new Error(
      'Transport wiring lands in plan 05 step 4. ' +
        'For now run with `--dry-run` to exercise the wizard end-to-end.',
    );
  }

  const rung = await resolveRung(options, ctx);
  const notes = await resolveNotes(options, ctx);

  const report = buildMockReport({
    device,
    transport,
    rung,
    notes,
    reporter: options.reporter,
  });

  // Submit flow + actual `gh issue create` path land in plan 05 step 5.
  // For now `--dry-run` prints the rendered body. A non-dry-run code path
  // does not exist yet; the throw above guards it.
  const { renderIssueBody } = await import('@thermal-label/harness-core/shared');
  process.stdout.write(renderIssueBody(report));
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

  return promptSelect<string>(
    ctx,
    'model',
    'Pick a labelmanager model:',
    known.map(d => ({ value: d.key, name: `${d.name}  [${d.key}]` })),
  ).then(key => {
    const found = known.find(d => d.key === key);
    if (!found) throw new Error(`Picked unknown key ${key}`);
    return found;
  });
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

  // Single-transport driver — no point prompting if there's only one
  // option. Document it in stdout for transparency.
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

async function resolveNotes(options: VerifyOptions, ctx: PromptContext): Promise<string | undefined> {
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

interface MockReportInput {
  device: LabelManagerDevice;
  transport: TransportType;
  rung: ProposedRung;
  notes: string | undefined;
  reporter: string | undefined;
}

/**
 * For `--dry-run` we don't actually connect, so detected identity is
 * synthesised from the registry entry (vid/pid + advertisedName from the
 * model name). This lets plan 05 step 6's smoke test render a complete
 * `HardwareReport` without hardware in the loop.
 *
 * The real flow (plan 05 step 4) replaces this with values pulled from
 * the live `UsbTransport` + identity probe.
 */
function buildMockReport(input: MockReportInput): HardwareReport {
  const usb = input.device.transports.usb;
  const detected = {
    advertisedName: input.device.name,
    ...(usb ? { vid: parseInt(usb.vid, 16), pid: parseInt(usb.pid, 16) } : {}),
  };

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
      detected,
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
