/**
 * Labelwriter verify flow.
 *
 * Wizard by default; expert flags bypass prompts wholesale (plan 05
 * §decisions). Multi-transport: after the operator submits one
 * transport's assessment, the wizard asks "test another transport on
 * this same device?" — auto-selects unused transports, allows manual
 * skip, repeats the print + assess + submit cycle. Per-transport
 * rungs are preserved in the report's `transports[]` array (the
 * standard `HardwareReport` shape already supports multiple entries).
 *
 * Per the maintainer's hardware: LW 330 Turbo and LW 400 are USB-only
 * (the registry's per-device transports drive this); LW Wireless /
 * LW 4xx Wi-Fi / 550 Turbo / 5XL declare `tcp: { port: 9100 }` in
 * addition. The orchestrator looks at the device entry rather than
 * hardcoding a list.
 *
 * Flow:
 *   1. Resolve device (flag or pick-from-registry prompt).
 *   2. Resolve media (`--label <key|sku>` or pick prompt). Mandatory —
 *      no defaults; different labels have wildly different dimensions.
 *   3. Multi-transport loop:
 *      a. Resolve transport (flag for first iter, prompt-from-remaining
 *         for subsequent). USB / TCP-9100 supported.
 *      b. If TCP: resolve host (flag or prompt).
 *      c. Connect via the matching `connectLabelwriter*` + identity probe.
 *      d. Build + encode the diagnostic bitmap, write it to the wire.
 *      e. Operator inspects, picks a rung + free-text notes.
 *      f. Submit (or `--no-submit` / `--dry-run` short-circuits).
 *      g. Ask "test another transport?" → loop back to (a).
 *   4. Once the operator stops adding transports, the wizard ends.
 *
 * `--dry-run` short-circuits at step 3d: the report renders to stdout
 * with a synthesised identity. `--no-submit` runs the print but
 * renders the body to stdout instead of submitting.
 */
import {
  DEVICES,
  MEDIA,
  type LabelWriterDevice,
  type LabelWriterMedia,
} from '@thermal-label/labelwriter-core';
import {
  DeviceNotFoundError,
  TransportClosedError,
  type Transport,
  type TransportType,
} from '@thermal-label/contracts';
import {
  renderIssueBody,
  transportInstructions,
  type HardwareReport,
  type IdentitySnapshot,
  type OffsetCalibration,
  type ProposedRung,
  type TransportReport,
} from '@thermal-label/harness-core/shared';
import { getForcedTrailingFeedMm, getPrintableArea } from '@thermal-label/contracts';
import type { LabelBitmap } from '@mbtech-nl/bitmap';
import type { VerifyOptions } from '../../verify.js';
import {
  NoPromptError,
  promptConfirm,
  promptInput,
  promptSelect,
  type PromptContext,
} from '../../prompts.js';
import {
  connectLabelwriterTcp,
  connectLabelwriterUsb,
  probeLabelwriterMedia,
  writeDiagnosticPrint,
} from './connect.js';
import {
  buildDiagnosticBitmap,
  encodeBitmap,
  type PrintableAreaOverride,
} from '@thermal-label/harness-core/labelwriter';
import { submitIssue, buildPrefillUrl, openInBrowser } from '../../submit.js';
import { renderBitmapPreview } from '../../bitmap-preview.js';
import { writeBitmapPngToTmp } from '../../bitmap-png.js';

const DRIVER_KEY = 'labelwriter';
const HARNESS_VERSION = '0.0.0';
const DRIVER_VERSION = '0.0.0';
const TARGET_REPO = 'thermal-label/labelwriter';
const FALLBACK_EMAIL = 'mannes@krukje.nl';

const SUPPORTED_TRANSPORTS: readonly TransportType[] = ['usb', 'tcp'];

const RUNG_CHOICES: readonly { value: ProposedRung; name: string; description: string }[] = [
  {
    value: 'verified',
    name: 'verified — looks right end-to-end',
    description: 'Print is legible, density is even, no glaring artefacts.',
  },
  {
    value: 'partial',
    name: 'partial — works, but with caveats',
    description:
      'Something the printer produces wrong: faint output, dropped rows, jammed cuts. ' +
      "Empty borders / missing top or bottom strips are NOT partial — that is the head's " +
      'mechanical reach. Use --leading / --trailing / --left / --right to dial in your ' +
      "printer's offsets, then re-print.",
  },
  {
    value: 'unsupported',
    name: 'unsupported — known-broken on this build',
    description:
      'Bytes go out but the printer produces nothing usable. Same caveat as partial — ' +
      'an empty top / bottom strip is calibration, not a defect.',
  },
];

export async function runLabelwriterVerify(options: VerifyOptions): Promise<void> {
  const ctx: PromptContext = { noPrompt: !options.wizard };

  const device = await resolveDevice(options, ctx);
  const media = await resolveMedia(device, options, ctx);

  const availableTransports = deviceTransports(device);
  if (availableTransports.length === 0) {
    throw new Error(`Device ${device.key} has no recognised transports declared.`);
  }

  printSessionHeader(device, media);

  // Multi-transport loop. The first iteration honours `--transport`
  // (or auto-picks if exactly one is available); subsequent iterations
  // present the unused transports and let the operator pick or stop.
  const runs: TransportReport[] = [];
  await runOneTransport({
    device,
    media,
    options,
    ctx,
    isFirstIteration: true,
    availableTransports,
    usedTransports: new Set(),
    runs,
  });

  // For dry-run, the first iteration short-circuits inside
  // `runOneTransport` after rendering the body. Don't enter the
  // "another transport?" loop on dry-run because the synthesised
  // identity is identical across transports — running twice adds no
  // information.
  if (options.dryRun) return;

  // Subsequent iterations only when wizard mode and another transport
  // is on the device + not yet exercised.
  while (options.wizard && runs.length < availableTransports.length && runs.length > 0) {
    const usedNames = new Set(runs.map(r => r.name));
    const remaining = availableTransports.filter(t => !usedNames.has(t));
    if (remaining.length === 0) break;

    const wantsMore = await promptConfirm(
      ctx,
      'another-transport',
      `Test another transport on ${device.key}? (remaining: ${remaining.join(', ')})`,
      false,
    );
    if (!wantsMore) break;

    await runOneTransport({
      device,
      media,
      options,
      ctx,
      isFirstIteration: false,
      availableTransports,
      usedTransports: usedNames,
      runs,
    });
  }
}

interface RunOneTransportInput {
  device: LabelWriterDevice;
  media: LabelWriterMedia;
  options: VerifyOptions;
  ctx: PromptContext;
  isFirstIteration: boolean;
  availableTransports: readonly TransportType[];
  usedTransports: ReadonlySet<TransportType>;
  runs: TransportReport[];
}

async function runOneTransport(input: RunOneTransportInput): Promise<void> {
  const { device, media, options, ctx, isFirstIteration, availableTransports, usedTransports } =
    input;

  const transport = await resolveTransport(
    options,
    ctx,
    availableTransports,
    usedTransports,
    isFirstIteration,
  );

  const host = transport === 'tcp' ? await resolveHost(options, ctx) : undefined;

  console.log('');
  console.log(`Transport: ${transport}${host !== undefined ? ` (${host}:9100)` : ''}`);
  console.log(transportInstructions[transport].inline);
  console.log('');

  // Resolve the per-session printable-area / forced-trailing-feed
  // overrides. CLI flags win over wizard prompts win over engine
  // defaults (zero in phase 1). The values flow into the bitmap
  // pipeline and ride along on the submitted report.
  const calibration = await resolveCalibration(device, media, options, ctx);
  reportCalibrationSummary(calibration);

  // Build the bitmap up front so `--preview` works hardware-free.
  const result = buildDiagnosticBitmap({
    device,
    media,
    harnessVersion: HARNESS_VERSION,
    driverVersion: DRIVER_VERSION,
    override: calibrationToOverride(calibration),
  });

  if (options.preview) {
    // Preview the AUTHORED bitmap — it shows the operator the full
    // label-sized layout, including the dead-zone bands they can
    // see in the photo afterwards. The wire bitmap is what actually
    // ships to the printer.
    console.log(renderBitmapPreview(result.authored));
    console.log('');
  }

  if (options.previewPng) {
    const pngPath = writeBitmapPngToTmp(result.authored, `verify-${device.key}-${transport}`);
    console.log(`Wrote PNG preview: ${pngPath}`);
    const launcher = openInBrowser(pngPath);
    if (launcher) {
      console.log(`(Opening with ${launcher}; if nothing appeared, open the path above manually.)`);
    }
    console.log('');
  }

  // Pass `result.authored.heightPx` as the label pitch — `result.wire`
  // may be shorter than the label (the LW mechanical leading offset
  // is skipped from the raster stream) but the printer still needs
  // the actual label pitch for form-feed/cut sequencing.
  const identity = await runConnectAndPrint(
    device,
    transport,
    host,
    options,
    result.wire,
    result.authored.heightPx,
  );

  const rung = await resolveRung(options, ctx);

  // Soft check (plan 08 §7a): if the operator picked partial /
  // unsupported AND adjusted any override away from the default,
  // print a one-line FYI prompting them to confirm the rung
  // reflects an actual defect rather than the calibration. Easy to
  // ignore; visible enough to catch the noisy case.
  maybeSoftCheckRungVsCalibration(rung, calibration);

  const notes = await resolveNotes(options, ctx);

  const offsetCalibration = buildOffsetCalibrationField(calibration);

  const transportReport: TransportReport = {
    name: transport,
    patterns: { diagnostic: 'pass' },
    rung,
    ...(notes ? { notes } : {}),
    ...(offsetCalibration ? { offsetCalibration } : {}),
  };

  input.runs.push(transportReport);

  const report = buildReport({
    device,
    media,
    detectedIdentity: identity,
    transports: input.runs,
    reporter: options.reporter,
  });

  const body = renderIssueBody(report);

  if (options.dryRun) {
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

  await submitToGitHub(report, body);
}

async function submitToGitHub(report: HardwareReport, body: string): Promise<void> {
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
  const model = report.device.confirmed.model;
  const transports = report.transports.map(t => `${t.name}=${t.rung}`).join(' / ');
  return `[harness] ${model} — ${transports || 'unverified'}`;
}

function printSessionHeader(device: LabelWriterDevice, media: LabelWriterMedia): void {
  console.log('');
  console.log(`Driver:    ${DRIVER_KEY} (core ${DRIVER_VERSION}, harness ${HARNESS_VERSION})`);
  console.log(`Model:     ${device.name}  [${device.key}]`);
  console.log(`Label:     ${media.name}  [${String(media.id)}]`);
  console.log('');
}

async function runConnectAndPrint(
  device: LabelWriterDevice,
  transport: TransportType,
  host: string | undefined,
  options: VerifyOptions,
  bitmap: LabelBitmap,
  labelLengthDots: number,
): Promise<IdentitySnapshot> {
  if (options.dryRun) {
    return synthesiseIdentity(device, transport, host);
  }

  console.log(`Connecting over ${transport}${host !== undefined ? ` to ${host}:9100` : ''}...`);
  let session: { transport: Transport; identity: IdentitySnapshot };
  try {
    if (transport === 'usb') {
      session = await connectLabelwriterUsb(device);
    } else {
      if (host === undefined) {
        throw new Error('Internal: TCP transport selected without a host.');
      }
      session = await connectLabelwriterTcp(device, host);
    }
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
    transport === 'usb'
      ? `Connected. vid=0x${session.identity.vid?.toString(16) ?? '?'} pid=0x${
          session.identity.pid?.toString(16) ?? '?'
        }`
      : `Connected to ${host ?? '?'}:9100.`,
  );

  console.log('Encoding diagnostic print...');
  const bytes = encodeBitmap(bitmap, device, labelLengthDots);
  console.log(`Sending ${String(bytes.length)} bytes to printer...`);
  try {
    await writeDiagnosticPrint(session.transport, bytes);
  } catch (err) {
    if (err instanceof TransportClosedError) {
      throw new Error(
        `${transport} transport closed mid-write. Check the cable / network / device power; ` +
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
): Promise<LabelWriterDevice> {
  const known = Object.values(DEVICES);

  if (options.model !== undefined) {
    const match = known.find(d => d.key === options.model);
    if (!match) {
      throw new Error(
        `Unknown labelwriter model "${options.model}". Known keys:\n  ${known
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
    'Pick a labelwriter model:',
    known.map(d => ({ value: d.key, name: `${d.name}  [${d.key}]` })),
  );
  const found = known.find(d => d.key === key);
  if (!found) throw new Error(`Picked unknown key ${key}`);
  return found;
}

/**
 * Resolve `--media` to a media descriptor.
 *
 * Resolution order: explicit flag → printer auto-detection (LW 5xx
 * `capabilities.mediaDetection`) → wizard prompt → hard-fail in
 * `--no-prompt`. The flag always wins; a mismatch with detection is
 * logged as a warning but proceeds.
 *
 * Auto-detection skips entirely on `--dry-run` (no hardware contact)
 * and on devices that don't declare `mediaDetection`.
 */
async function resolveMedia(
  device: LabelWriterDevice,
  options: VerifyOptions,
  ctx: PromptContext,
): Promise<LabelWriterMedia> {
  const labelMedia = labelwriterLabelMedia();

  if (options.media !== undefined) {
    const match = findMediaByKeyOrSku(options.media);
    if (!match) {
      throw new Error(formatUnknownLabel(options.media, labelMedia));
    }
    return match;
  }

  // Try printer auto-detection on capable models. Skip on dry-run —
  // synthesised identity, no hardware contact.
  const detectsMedia = device.engines[0]?.capabilities?.mediaDetection === true;
  if (detectsMedia && !options.dryRun) {
    const detected = await probeLabelwriterMedia(device);
    if (detected) {
      const match = findMediaByKeyOrSku(detected.sku);
      if (match) {
        console.log(
          `[labelwriter] Detected media from printer NFC: ${detected.sku} (${match.name}).`,
        );
        return match;
      }
      console.warn(
        `[labelwriter] Printer reports SKU "${detected.sku}" but it isn't in the labelwriter-core MEDIA registry. Pass --media explicitly.`,
      );
    }
  }

  if (ctx.noPrompt) {
    const reason = detectsMedia
      ? `${device.key} has media detection but the probe returned nothing usable`
      : `${device.key} has no media detection`;
    throw new Error(
      `--media is required for labelwriter (${reason}). ` +
        `Pass --media <key|sku> (e.g. --media ADDRESS_STANDARD or --media 30334).`,
    );
  }

  // Filter to media compatible with the device's primary engine
  // (rough cut: `targetModels` overlaps `mediaCompatibility`).
  const choices = labelMedia
    .filter(m => isMediaCompatibleWithDevice(m, device))
    .map(m => ({
      value: String(m.id),
      name: `${m.name}  [${String(m.id)}]`,
    }));

  const picked = await promptSelect<string>(
    ctx,
    'media',
    'Pick the loaded label:',
    choices.length > 0 ? choices : labelMedia.map(m => ({ value: String(m.id), name: m.name })),
  );
  const found = labelMedia.find(m => String(m.id) === picked);
  if (!found) throw new Error(`Picked unknown media ${picked}`);
  return found;
}

function labelwriterLabelMedia(): readonly LabelWriterMedia[] {
  // The shared MEDIA registry contains both labelwriter (die-cut /
  // continuous) and Duo tape (D1) entries; filter to label media via
  // a structural narrow on `type`. The registry's compile-time literal
  // union types are too narrow for our generic `LabelWriterMedia`
  // descriptor; cast through `unknown` keeps the runtime check honest
  // while letting the broader interface flow through.
  return (Object.values(MEDIA) as readonly unknown[]).filter(isLabelWriterLabelMedia);
}

function findMediaByKeyOrSku(value: string): LabelWriterMedia | undefined {
  const upper = value.toUpperCase();
  // First try MEDIA-registry key (e.g. ADDRESS_STANDARD).
  const byKey = (MEDIA as Record<string, unknown>)[upper];
  if (byKey !== undefined && isLabelWriterLabelMedia(byKey)) return byKey;

  // Then try SKU lookup (e.g. 30334 → which media carries this SKU).
  for (const m of labelwriterLabelMedia()) {
    if (m.skus?.includes(value)) return m;
  }
  return undefined;
}

function isLabelWriterLabelMedia(m: unknown): m is LabelWriterMedia {
  if (typeof m !== 'object' || m === null) return false;
  const t = (m as { type?: string }).type;
  return t === 'die-cut' || t === 'continuous';
}

function isMediaCompatibleWithDevice(media: LabelWriterMedia, device: LabelWriterDevice): boolean {
  const targets = media.targetModels ?? [];
  const compat = device.engines[0]?.mediaCompatibility ?? [];
  return targets.some(t => compat.includes(t));
}

function formatUnknownLabel(value: string, media: readonly LabelWriterMedia[]): string {
  const lines: string[] = [];
  lines.push(`Unknown labelwriter label "${value}". Pass either a media key or a SKU.`);
  lines.push('');
  lines.push('Known labels:');
  for (const m of media) {
    const skus = m.skus && m.skus.length > 0 ? `  (skus: ${m.skus.join(', ')})` : '';
    lines.push(`  ${String(m.id)} — ${m.name}${skus}`);
  }
  return lines.join('\n');
}

function deviceTransports(device: LabelWriterDevice): readonly TransportType[] {
  const out: TransportType[] = [];
  if (device.transports.usb) out.push('usb');
  if (device.transports.tcp) out.push('tcp');
  return out;
}

async function resolveTransport(
  options: VerifyOptions,
  ctx: PromptContext,
  available: readonly TransportType[],
  used: ReadonlySet<TransportType>,
  isFirstIteration: boolean,
): Promise<TransportType> {
  // First iteration: respect `--transport` if given.
  if (isFirstIteration && options.transport !== undefined) {
    if (!SUPPORTED_TRANSPORTS.includes(options.transport)) {
      throw new Error(
        `labelwriter only supports ${SUPPORTED_TRANSPORTS.join(', ')} transports today; ` +
          `got "${options.transport}".`,
      );
    }
    if (!available.includes(options.transport)) {
      throw new Error(
        `Device declares no ${options.transport} transport. Available: ${available.join(', ')}.`,
      );
    }
    return options.transport;
  }

  const remaining = available.filter(t => !used.has(t));
  const [only, ...rest] = remaining;
  if (only !== undefined && rest.length === 0) {
    return only;
  }

  if (remaining.length === 0) {
    throw new Error('No transports remaining to test.');
  }

  return promptSelect<TransportType>(
    ctx,
    'transport',
    'Pick a transport:',
    remaining.map(t => ({ value: t, name: t })),
  );
}

async function resolveHost(options: VerifyOptions, ctx: PromptContext): Promise<string> {
  if (options.host !== undefined) return options.host;
  if (ctx.noPrompt) throw new NoPromptError('host');
  return promptInput(ctx, 'host', "Printer's IP address or hostname:");
}

/**
 * Resolved per-session calibration values plus the engine defaults
 * they were derived from. Both sets ride along on the submitted
 * report so triage can tell "operator confirmed the default" apart
 * from "operator typed the same value as the default".
 */
interface CalibrationSession {
  effective: {
    leadingMm: number;
    trailingMm: number;
    leftMm: number;
    rightMm: number;
    forcedTrailingFeedMm: number;
  };
  defaults: {
    leadingMm: number;
    trailingMm: number;
    leftMm: number;
    rightMm: number;
    forcedTrailingFeedMm: number;
  };
  /** Whether the operator touched any field (CLI flag or wizard input). */
  edited: boolean;
}

/**
 * Resolve the per-session printable-area / forced-trailing-feed
 * overrides for this transport run.
 *
 * Resolution order, per field:
 *  1. CLI flag (`--leading`, `--trailing`, `--left`, `--right`,
 *     `--trailing-feed`).
 *  2. Wizard prompt (when `wizard` mode and no flag for the field).
 *     The prompt offers the engine default; pressing Enter accepts it.
 *  3. Engine default (`getPrintableArea(engine, media)` /
 *     `getForcedTrailingFeedMm(engine)` — zero in phase 1).
 *
 * `--no-prompt` mode skips the wizard and uses defaults for unset
 * fields, so headless runs always succeed without operator input.
 */
async function resolveCalibration(
  device: LabelWriterDevice,
  media: LabelWriterMedia,
  options: VerifyOptions,
  ctx: PromptContext,
): Promise<CalibrationSession> {
  const engine = device.engines[0];
  const defaultPrintableArea = engine
    ? getPrintableArea(engine, media)
    : { leading: 0, trailing: 0, left: 0, right: 0 };
  const defaultForcedFeed = engine ? getForcedTrailingFeedMm(engine) : 0;
  const defaults = {
    leadingMm: defaultPrintableArea.leading,
    trailingMm: defaultPrintableArea.trailing,
    leftMm: defaultPrintableArea.left,
    rightMm: defaultPrintableArea.right,
    forcedTrailingFeedMm: defaultForcedFeed,
  };

  const flagsTouched =
    options.leadingMm !== undefined ||
    options.trailingMm !== undefined ||
    options.leftMm !== undefined ||
    options.rightMm !== undefined ||
    options.forcedTrailingFeedMm !== undefined;

  // Headless / no-prompt: defaults everywhere unless flags override.
  if (ctx.noPrompt || !options.wizard) {
    const effective = {
      leadingMm: options.leadingMm ?? defaults.leadingMm,
      trailingMm: options.trailingMm ?? defaults.trailingMm,
      leftMm: options.leftMm ?? defaults.leftMm,
      rightMm: options.rightMm ?? defaults.rightMm,
      forcedTrailingFeedMm: options.forcedTrailingFeedMm ?? defaults.forcedTrailingFeedMm,
    };
    return { effective, defaults, edited: flagsTouched };
  }

  // Wizard mode: ask whether to adjust at all. If yes, prompt each
  // field with the default pre-filled. Per-field flag short-circuits
  // the prompt for that field.
  const wantsAdjust = flagsTouched
    ? true
    : await promptConfirm(
        ctx,
        'calibration',
        'Adjust printable-area overrides for this run? (default: use engine values, all zero in phase 1)',
        false,
      );

  if (!wantsAdjust) {
    return { effective: { ...defaults }, defaults, edited: false };
  }

  const leadingMm =
    options.leadingMm ?? (await promptMm(ctx, 'leading', 'Leading edge (mm):', defaults.leadingMm));
  const trailingMm =
    options.trailingMm ??
    (await promptMm(ctx, 'trailing', 'Trailing edge (mm):', defaults.trailingMm));
  const leftMm =
    options.leftMm ?? (await promptMm(ctx, 'left', 'Left edge (mm):', defaults.leftMm));
  const rightMm =
    options.rightMm ?? (await promptMm(ctx, 'right', 'Right edge (mm):', defaults.rightMm));
  const forcedTrailingFeedMm =
    options.forcedTrailingFeedMm ??
    (await promptMm(
      ctx,
      'trailing-feed',
      'Forced trailing feed (mm):',
      defaults.forcedTrailingFeedMm,
    ));

  return {
    effective: { leadingMm, trailingMm, leftMm, rightMm, forcedTrailingFeedMm },
    defaults,
    edited: true,
  };
}

async function promptMm(
  ctx: PromptContext,
  key: string,
  label: string,
  defaultValue: number,
): Promise<number> {
  const text = await promptInput(ctx, key, `${label} [default: ${String(defaultValue)}]`);
  if (text.trim() === '') return defaultValue;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid ${key} value "${text}" — expected a non-negative number in mm.`);
  }
  return parsed;
}

function calibrationToOverride(calibration: CalibrationSession): PrintableAreaOverride {
  return {
    leadingMm: calibration.effective.leadingMm,
    trailingMm: calibration.effective.trailingMm,
    leftMm: calibration.effective.leftMm,
    rightMm: calibration.effective.rightMm,
    forcedTrailingFeedMm: calibration.effective.forcedTrailingFeedMm,
  };
}

/**
 * Build the `offsetCalibration` field for `TransportReport` if (and
 * only if) the operator surfaced the calibration drawer (via flags
 * or by accepting the wizard prompt) OR any field's effective value
 * differs from the engine default. Returns `undefined` to omit the
 * field entirely from the report when there's nothing useful to
 * record.
 */
function buildOffsetCalibrationField(
  calibration: CalibrationSession,
): OffsetCalibration | undefined {
  const e = calibration.effective;
  const d = calibration.defaults;
  const differs =
    e.leadingMm !== d.leadingMm ||
    e.trailingMm !== d.trailingMm ||
    e.leftMm !== d.leftMm ||
    e.rightMm !== d.rightMm ||
    e.forcedTrailingFeedMm !== d.forcedTrailingFeedMm;
  if (!calibration.edited && !differs) return undefined;

  return {
    ...(e.leadingMm !== d.leadingMm ? { leadingMm: e.leadingMm } : {}),
    ...(e.trailingMm !== d.trailingMm ? { trailingMm: e.trailingMm } : {}),
    ...(e.leftMm !== d.leftMm ? { leftMm: e.leftMm } : {}),
    ...(e.rightMm !== d.rightMm ? { rightMm: e.rightMm } : {}),
    ...(e.forcedTrailingFeedMm !== d.forcedTrailingFeedMm
      ? { forcedTrailingFeedMm: e.forcedTrailingFeedMm }
      : {}),
    defaults: { ...d },
  };
}

function maybeSoftCheckRungVsCalibration(
  rung: ProposedRung,
  calibration: CalibrationSession,
): void {
  if (rung !== 'partial' && rung !== 'unsupported') return;
  const e = calibration.effective;
  const d = calibration.defaults;
  const differs =
    e.leadingMm !== d.leadingMm ||
    e.trailingMm !== d.trailingMm ||
    e.leftMm !== d.leftMm ||
    e.rightMm !== d.rightMm ||
    e.forcedTrailingFeedMm !== d.forcedTrailingFeedMm;
  if (!differs) return;
  console.log('');
  console.log(
    `FYI: you adjusted offset values from the engine defaults — confirm the "${rung}" rung ` +
      'reflects an actual printer defect (faint output, dropped rows, jammed cuts), not a ' +
      'calibration mismatch (empty borders / margin off). Margin-only complaints belong on ' +
      'the calibration loop, not the rung.',
  );
  console.log('');
}

function reportCalibrationSummary(calibration: CalibrationSession): void {
  const e = calibration.effective;
  const d = calibration.defaults;
  const allZero =
    e.leadingMm === 0 &&
    e.trailingMm === 0 &&
    e.leftMm === 0 &&
    e.rightMm === 0 &&
    e.forcedTrailingFeedMm === 0;
  const matchesDefault =
    e.leadingMm === d.leadingMm &&
    e.trailingMm === d.trailingMm &&
    e.leftMm === d.leftMm &&
    e.rightMm === d.rightMm &&
    e.forcedTrailingFeedMm === d.forcedTrailingFeedMm;
  if (allZero && matchesDefault) {
    console.log('Printable area: defaults (no overrides). All zero — phase-1 framework.');
  } else {
    console.log(
      `Printable area: leading=${String(e.leadingMm)}mm trailing=${String(e.trailingMm)}mm ` +
        `left=${String(e.leftMm)}mm right=${String(e.rightMm)}mm; ` +
        `forced trailing feed=${String(e.forcedTrailingFeedMm)}mm.`,
    );
  }
  console.log('');
}

async function resolveRung(options: VerifyOptions, ctx: PromptContext): Promise<ProposedRung> {
  if (options.rung !== undefined) return options.rung;
  if (!ctx.noPrompt) {
    console.log(
      "FYI: empty space at the top or bottom is the head's mechanical reach, not a defect. " +
        'Use --leading / --trailing (or the wizard prompt above) to dial in offsets, then re-print ' +
        'before picking partial / unsupported.',
    );
    console.log('');
  }
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
  device: LabelWriterDevice;
  media: LabelWriterMedia;
  detectedIdentity: IdentitySnapshot;
  transports: readonly TransportReport[];
  reporter: string | undefined;
}

function synthesiseIdentity(
  device: LabelWriterDevice,
  transport: TransportType,
  host: string | undefined,
): IdentitySnapshot {
  const usb = device.transports.usb;
  return {
    advertisedName: device.name,
    ...(transport === 'usb' && usb
      ? { vid: parseInt(usb.vid, 16), pid: parseInt(usb.pid, 16) }
      : {}),
    extra: {
      synthesised: true,
      source: 'dry-run-fallback',
      transport,
      ...(host !== undefined ? { host } : {}),
    },
  };
}

function buildReport(input: BuildReportInput): HardwareReport {
  const usb = input.device.transports.usb;

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
        overrides: { label: String(input.media.id) },
      },
    },
    transports: input.transports,
    submittedAt: new Date().toISOString(),
    ...(input.reporter ? { reporter: { handle: input.reporter } } : {}),
  };
}
