/**
 * `verify-cli` entry point.
 *
 * Per plan 05: maintainer-self-validation tool that walks the operator
 * through connect → identity confirm → diagnostic print → assessment →
 * submit. Wizard prompts by default; expert flags bypass for
 * known-good-hardware one-liners.
 *
 * Drivers covered today: labelmanager, brother-ql. Subsequent drivers
 * land as separate PRs.
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
const SUPPORTED_DRIVERS = ['labelmanager', 'labelwriter', 'brother-ql'] as const;

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
  previewPng?: boolean;
  reporter?: string;
  tapeWidth?: 6 | 9 | 12 | 19;
  /** Loaded label / tape SKU. Optional when the printer auto-detects (LW 5xx, brother-ql). */
  media?: string;
  /** TCP-9100 host (IP or hostname). Labelwriter Wi-Fi or brother-ql TCP. */
  host?: string;
  /** TCP-9100 port (default 9100). Brother-ql TCP only. */
  port?: number;
  /** Printable-area override: leading edge, in mm (labelwriter only). */
  leading?: number;
  /** Printable-area override: trailing edge, in mm (labelwriter only). */
  trailing?: number;
  /** Printable-area override: left edge, in mm (labelwriter only). */
  left?: number;
  /** Printable-area override: right edge, in mm (labelwriter only). */
  right?: number;
  /** Forced trailing feed override, in mm (labelwriter only). */
  trailingFeed?: number;
}

function parseChoice<T extends string>(label: string, allowed: readonly T[]): (value: string) => T {
  return (value: string): T => {
    if (!(allowed as readonly string[]).includes(value)) {
      throw new Error(`Invalid ${label}: ${value}. Expected one of: ${allowed.join(', ')}`);
    }
    return value as T;
  };
}

function parseNonNegative(label: string): (value: string) => number {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Invalid --${label}: ${value}. Expected a non-negative number in mm.`);
    }
    return n;
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
    'Print the diagnostic bitmap as Braille to stdout before sending bytes (or alone, with --dry-run).',
  )
  .option(
    '--preview-png',
    'Write the diagnostic bitmap as a PNG to a tmp file and auto-open it in your default image viewer.',
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
  .option(
    '--media <key>',
    'Loaded label / tape (e.g. ADDRESS_STANDARD or 30334 for labelwriter; DK-22205, DK-22251 for brother-ql). Optional when the printer auto-detects (LW 5xx, brother-ql); required for LW 3xx/4xx and labelmanager-via-tape-width. Wizard prompts when it cannot be detected and no flag is passed.',
  )
  .option(
    '--host <host>',
    'TCP-9100 host (IP or hostname). Required for labelwriter tcp transport and brother-ql tcp transport.',
  )
  .option('--port <port>', 'TCP-9100 port (default 9100). Brother-ql tcp transport only.', v =>
    Number.parseInt(v, 10),
  )
  .option(
    '--leading <mm>',
    'Labelwriter only: override the leading-edge dead-zone in mm (plan 08 §7a). Defaults to the engine value (zero in phase 1).',
    parseNonNegative('leading'),
  )
  .option(
    '--trailing <mm>',
    'Labelwriter only: override the trailing-edge dead-zone in mm. Defaults to the engine value.',
    parseNonNegative('trailing'),
  )
  .option(
    '--left <mm>',
    'Labelwriter only: override the left-edge dead-zone in mm. Defaults to the engine value.',
    parseNonNegative('left'),
  )
  .option(
    '--right <mm>',
    'Labelwriter only: override the right-edge dead-zone in mm. Defaults to the engine value.',
    parseNonNegative('right'),
  )
  .option(
    '--trailing-feed <mm>',
    'Labelwriter only: override the post-print forced trailing feed in mm. Defaults to the engine value (zero on LW today; the LW family uses variable form-feed).',
    parseNonNegative('trailing-feed'),
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
        previewPng: options.previewPng === true,
        reporter: options.reporter,
        tapeWidth: options.tapeWidth,
        media: options.media,
        host: options.host,
        port: options.port,
        leadingMm: options.leading,
        trailingMm: options.trailing,
        leftMm: options.left,
        rightMm: options.right,
        forcedTrailingFeedMm: options.trailingFeed,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`verify-cli: ${message}`);
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
