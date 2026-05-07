/**
 * `verify-cli` entry point.
 *
 * Per plan 05: maintainer-self-validation tool that walks the operator
 * through connect → identity confirm → diagnostic print → assessment →
 * submit. Wizard prompts by default; expert flags bypass for
 * known-good-hardware one-liners.
 *
 * Single-driver scope today (labelmanager); subsequent drivers land as
 * separate PRs and grow `--driver` into a real dispatcher.
 */
import { Command } from 'commander';
import { runVerify } from './verify.js';
import type { TransportType } from '@thermal-label/contracts';
import type { ProposedRung } from '@thermal-label/harness-core/shared';

const TRANSPORT_TYPES: readonly TransportType[] = [
  'usb',
  'tcp',
  'serial',
  'bluetooth-spp',
  'bluetooth-gatt',
];
const RUNGS: readonly ProposedRung[] = ['verified', 'partial', 'unsupported'];
const SUPPORTED_DRIVERS = ['labelmanager'] as const;

interface VerifyCommandOptions {
  transport?: TransportType;
  rung?: ProposedRung;
  notes?: string;
  /** Inverted by commander from `--no-prompt`; `true` (default) = wizard. */
  prompt?: boolean;
  dryRun?: boolean;
  /** Inverted by commander from `--no-submit`; `true` (default) = submit. */
  submit?: boolean;
  preview?: boolean;
  reporter?: string;
  tapeWidth?: 6 | 9 | 12 | 19;
}

function parseChoice<T extends string>(label: string, allowed: readonly T[]): (value: string) => T {
  return (value: string): T => {
    if (!(allowed as readonly string[]).includes(value)) {
      throw new Error(`Invalid ${label}: ${value}. Expected one of: ${allowed.join(', ')}`);
    }
    return value as T;
  };
}

const program = new Command();
program
  .name('verify-cli')
  .description('Thermal-label hardware-reporting harness (CLI runtime).')
  .version('0.0.0');

program
  .command('verify')
  .description('Run the verify wizard against a driver/model.')
  .argument('<driver>', `Driver key (one of: ${SUPPORTED_DRIVERS.join(', ')}).`)
  .argument('[model]', 'Device key from the driver registry (e.g. LM_PNP). Prompted if omitted.')
  .option(
    '-t, --transport <type>',
    `Transport to exercise (one of: ${TRANSPORT_TYPES.join(', ')}). Skips auto-detect.`,
    parseChoice<TransportType>('transport', TRANSPORT_TYPES),
  )
  .option(
    '-r, --rung <rung>',
    `Pre-fill the assessment rung (one of: ${RUNGS.join(', ')}). Skips the assessment prompt.`,
    parseChoice<ProposedRung>('rung', RUNGS),
  )
  .option('-n, --notes <notes>', 'Pre-fill the operator notes free-text field.')
  .option('--no-prompt', 'Fail fast if any further prompt would be needed.')
  .option(
    '--dry-run',
    'Render the IssueBody to stdout instead of submitting (no print, no transport).',
  )
  .option(
    '--no-submit',
    'Run the print + assessment, but render the body to stdout instead of submitting. Useful when iterating on the print.',
  )
  .option(
    '--preview',
    'Print the diagnostic bitmap as ASCII to stdout before sending bytes (or alone, with --dry-run).',
  )
  .option(
    '--reporter <handle>',
    'Optional reporter handle (e.g. @mannes); appears in the issue body.',
  )
  .option(
    '--tape-width <mm>',
    'Tape width in millimetres (6, 9, 12, 19). Labelmanager-only; defaults to 12.',
    (value): 6 | 9 | 12 | 19 => {
      const n = Number(value);
      if (n !== 6 && n !== 9 && n !== 12 && n !== 19) {
        throw new Error(`Invalid --tape-width ${value}; expected 6, 9, 12, or 19.`);
      }
      return n;
    },
  )
  .action(async (driver: string, model: string | undefined, options: VerifyCommandOptions) => {
    if (!(SUPPORTED_DRIVERS as readonly string[]).includes(driver)) {
      console.error(
        `Unsupported driver "${driver}". Supported: ${SUPPORTED_DRIVERS.join(', ')}.\n` +
          `Additional drivers land in subsequent PRs (plan 05 §sequencing).`,
      );
      process.exit(2);
    }
    try {
      await runVerify({
        driver: driver as (typeof SUPPORTED_DRIVERS)[number],
        model,
        transport: options.transport,
        rung: options.rung,
        notes: options.notes,
        // commander turns `--no-prompt` into `prompt: false` and the default
        // (no flag) is `prompt: true`. Map it to a positive `wizard` boolean.
        wizard: options.prompt !== false,
        dryRun: options.dryRun === true,
        // commander turns `--no-submit` into `submit: false`; absence is the
        // default, treated as wanting submit.
        noSubmit: options.submit === false,
        preview: options.preview === true,
        reporter: options.reporter,
        tapeWidth: options.tapeWidth,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`verify-cli: ${message}`);
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
