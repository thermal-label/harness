/**
 * Marklife verify flow.
 *
 * Wizard by default; expert flags bypass prompts wholesale. Marklife
 * is a Classic-Bluetooth-SPP family — the operator pairs the printer
 * at the OS level and binds an RFCOMM device node, then passes its
 * path with `--device`. See the verify-cli README marklife section
 * for the `rfcomm bind` walkthrough.
 *
 * Flow:
 *   1. Resolve model (flag or pick-from-registry prompt).
 *   2. Resolve transport — marklife today is Bluetooth-SPP only.
 *   3. Resolve media — `--media` flag, else the catalogue default for
 *      the chassis head-size class.
 *   4. Connect via `SerialTransport` over the RFCOMM path + write the
 *      encoded diagnostic job (`marklife-yxq` for the P12).
 *   5. Operator inspects what came out, picks the rung + notes.
 *   6. Render `IssueBody`; submit via `gh` / prefilled URL.
 *
 * BLE: the P12 is dual-mode (Classic SPP + BLE GATT), but there is no
 * Node BLE transport in this ecosystem and the marklife driver
 * declares no BLE profile for the P12 — the BLE route is a web-harness
 * follow-up. This CLI exercises the Classic-SPP transport only.
 */
import {
  DEFAULT_MEDIA,
  DEVICES,
  MEDIA,
  type MarklifeDevice,
  type MarklifeEngine,
  type MarklifeMedia,
  type MarklifePhysicalSizeClass,
  type MarklifeTargetModel,
} from '@thermal-label/marklife-core';
import { TransportClosedError, type TransportType } from '@thermal-label/contracts';
import {
  renderIssueBody,
  transportInstructions,
  type HardwareReport,
  type IdentitySnapshot,
  type ProposedRung,
  type TransportReport,
} from '@thermal-label/harness-core/shared';
import type { LabelBitmap } from '@mbtech-nl/bitmap';
import type { VerifyOptions } from '../../verify.js';
import { captureNodeEnvironment } from '../../environment.js';
import { HARNESS_VERSION, driverVersion } from '../../versions.js';
import {
  NoPromptError,
  promptConfirm,
  promptInput,
  promptSelect,
  type PromptContext,
} from '../../prompts.js';
import { connectMarklife, writeDiagnosticPrint } from './connect.js';
import { buildDiagnosticBitmap, encodeBitmap } from './diagnostic-print.js';
import { submitIssue, buildPrefillUrl, openInBrowser } from '../../submit.js';
import { renderBitmapPreview } from '../../bitmap-preview.js';
import { writeBitmapPngToTmp } from '../../bitmap-png.js';

const DRIVER_KEY = 'marklife';
const DRIVER_VERSION = driverVersion('@thermal-label/marklife-core');
const TARGET_REPO = 'thermal-label/marklife';
const FALLBACK_EMAIL = 'mannes@krukje.nl';

const SUPPORTED_TRANSPORTS: readonly TransportType[] = ['bluetooth-spp'];

/** Chassis head-size class → media-catalogue `targetModels` tag. */
const SIZE_CLASS_TARGET: Record<MarklifePhysicalSizeClass, MarklifeTargetModel> = {
  0.5: 'narrow-tape',
  2.0: 'mobile-2in',
  3.0: 'desktop-3in',
  4.0: 'industrial-4in',
};

const RUNG_CHOICES: readonly { value: ProposedRung; name: string; description: string }[] = [
  {
    value: 'verified',
    name: 'verified — looks right end-to-end',
    description: 'Print is legible, edges behave, no glaring artefacts.',
  },
  {
    value: 'partial',
    name: 'partial — works, but with caveats',
    description: 'Some aspect (margin, density, occasional drop) is off.',
  },
  {
    value: 'failing',
    name: 'failing — bytes go out, nothing usable comes back',
    description: 'Bytes go out but the printer produces nothing usable.',
  },
];

export async function runMarklifeVerify(options: VerifyOptions): Promise<void> {
  const ctx: PromptContext = { noPrompt: !options.wizard };

  const device = await resolveDevice(options, ctx);
  const engine = device.engines[0];
  if (!engine) {
    throw new Error(`marklife device ${device.key} has no engines — registry entry is malformed.`);
  }
  const transport = await resolveTransport(options, ctx);
  const media = resolveMedia(device, options);

  printSessionHeader(device, transport, media);

  // Build the bitmap up front so `--preview` can show it before any
  // hardware contact (preview + dry-run is a useful hardware-free
  // combo).
  const bitmap = buildDiagnosticBitmap({
    device,
    media,
    harnessVersion: HARNESS_VERSION,
    driverVersion: DRIVER_VERSION,
  });

  if (options.preview) {
    console.log(renderBitmapPreview(bitmap));
    console.log('');
  }

  if (options.previewPng) {
    const pngPath = writeBitmapPngToTmp(bitmap, `verify-${device.key}`);
    console.log(`Wrote PNG preview: ${pngPath}`);
    const launcher = openInBrowser(pngPath);
    if (launcher) {
      console.log(`(Opening with ${launcher}; if nothing appeared, open the path above manually.)`);
    }
    console.log('');
  }

  const identity = await runConnect(device, engine, media, options, bitmap, ctx);

  const rung = await resolveRung(options, ctx);
  const notes = await resolveNotes(options, ctx);

  const report = buildReport({ device, detectedIdentity: identity, transport, media, rung, notes });
  const body = renderIssueBody(report);

  if (options.dryRun) {
    // Test path — render to stdout, never submit.
    process.stdout.write(body);
    return;
  }

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
  device: MarklifeDevice,
  transport: TransportType,
  media: MarklifeMedia,
): void {
  console.log('');
  console.log(`Driver:    ${DRIVER_KEY} (core ${DRIVER_VERSION}, harness ${HARNESS_VERSION})`);
  console.log(`Model:     ${device.name}  [${device.key}]`);
  console.log(`Transport: ${transport}`);
  console.log(`Media:     ${media.name}  [${String(media.id)}]  (${String(media.widthMm)} mm)`);
  console.log('');
  console.log(transportInstructions[transport].inline);
  console.log('');
}

async function runConnect(
  device: MarklifeDevice,
  engine: MarklifeEngine,
  media: MarklifeMedia,
  options: VerifyOptions,
  bitmap: LabelBitmap,
  ctx: PromptContext,
): Promise<IdentitySnapshot> {
  if (options.dryRun) {
    return synthesiseIdentity(device);
  }

  const serialPath = await resolveSerialPath(options, ctx);

  console.log(`Connecting over Bluetooth-SPP (${serialPath})...`);
  let session;
  try {
    session = await connectMarklife(device, serialPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not open ${serialPath}. Pair the printer and bind an RFCOMM node first ` +
        `(see the verify-cli README marklife section), or pass --dry-run to exercise ` +
        `the rendering path without hardware. Underlying error: ${message}`,
    );
  }

  console.log(`Connected on ${serialPath}.`);
  console.log('Encoding diagnostic print...');
  const bytes = encodeBitmap(bitmap, engine, media);
  console.log(`Sending ${String(bytes.length)} bytes to printer...`);
  try {
    await writeDiagnosticPrint(session.transport, bytes);
  } catch (err) {
    if (err instanceof TransportClosedError) {
      throw new Error(
        'Bluetooth-SPP transport closed mid-write. Check the printer is powered and ' +
          'in range; re-running is safe.',
      );
    }
    throw err;
  }
  console.log('Diagnostic print sent.');

  await session.transport.close();
  return session.identity;
}

async function resolveDevice(options: VerifyOptions, ctx: PromptContext): Promise<MarklifeDevice> {
  const known = Object.values(DEVICES) as MarklifeDevice[];

  if (options.model !== undefined) {
    const match = known.find(d => d.key === options.model);
    if (!match) {
      throw new Error(
        `Unknown marklife model "${options.model}". Known keys:\n  ${known
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
    'Pick a marklife model:',
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
        `marklife only speaks ${SUPPORTED_TRANSPORTS.join(', ')} today; ` +
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

/**
 * Resolve `--media <key>` to a marklife media descriptor.
 *
 * Precedence: explicit `--media` (matched against the registry key or
 * the media `id`) → the first catalogue entry whose `targetModels`
 * matches the chassis head-size class → `DEFAULT_MEDIA`.
 *
 * The YXQ encoder for the P12 (protocol id 4) does not read media
 * geometry — the field is informational for the report — so an
 * imperfect default still produces a valid diagnostic print.
 */
function resolveMedia(device: MarklifeDevice, options: VerifyOptions): MarklifeMedia {
  const entries = Object.entries(MEDIA) as [string, MarklifeMedia][];

  if (options.media !== undefined) {
    const wanted = options.media;
    const match = entries.find(
      ([key, m]) => key === wanted || String(m.id) === wanted,
    );
    if (!match) {
      const known = entries.map(([key, m]) => `  ${key}  (${m.name})`).join('\n');
      throw new Error(`Unknown marklife media "${wanted}". Known media:\n${known}`);
    }
    return match[1];
  }

  const sizeClass = device.engines[0]?.capabilities?.physicalSizeClass;
  const target = sizeClass !== undefined ? SIZE_CLASS_TARGET[sizeClass] : undefined;
  const byClass = target
    ? entries.find(([, m]) => m.targetModels.includes(target))?.[1]
    : undefined;
  return byClass ?? DEFAULT_MEDIA;
}

async function resolveSerialPath(options: VerifyOptions, ctx: PromptContext): Promise<string> {
  if (options.device !== undefined && options.device.trim() !== '') {
    return options.device.trim();
  }
  if (ctx.noPrompt) throw new NoPromptError('device');
  const path = await promptInput(
    ctx,
    'device',
    'RFCOMM / serial device path (e.g. /dev/rfcomm0):',
  );
  const trimmed = path.trim();
  if (trimmed === '') throw new Error('No device path entered.');
  return trimmed;
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
  if (options.noSubmit) return false;
  if (ctx.noPrompt) return true;
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
  device: MarklifeDevice;
  detectedIdentity: IdentitySnapshot;
  transport: TransportType;
  media: MarklifeMedia;
  rung: ProposedRung;
  notes: string | undefined;
}

function synthesiseIdentity(device: MarklifeDevice): IdentitySnapshot {
  // Marklife has no host-readable identity probe and Bluetooth-SPP
  // surfaces no vid/pid — the synthesised snapshot is the registry
  // name plus a dry-run marker so triage can tell it from a real run.
  return {
    advertisedName: device.name,
    extra: { synthesised: true, source: 'dry-run-fallback' },
  };
}

function buildReport(input: BuildReportInput): HardwareReport {
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
        // No vid/pid — Bluetooth-SPP carries none. Record the media
        // the operator printed against so triage can reproduce.
        overrides: { media: String(input.media.id) },
      },
    },
    transports: [transportReport],
    environment: captureNodeEnvironment(),
    submittedAt: new Date().toISOString(),
  };
}
