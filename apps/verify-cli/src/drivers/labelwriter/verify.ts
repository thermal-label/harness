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
  type LabelWriterAnyMedia,
  type LabelWriterDevice,
  type LabelWriterMedia,
  type LabelWriterTapeMedia,
} from '@thermal-label/labelwriter-core';
import {
  DeviceNotFoundError,
  TransportClosedError,
  type PrintEngine,
  type Transport,
  type TransportType,
} from '@thermal-label/contracts';
import {
  renderIssueBody,
  transportInstructions,
  type EngineReport,
  type HardwareReport,
  type IdentitySnapshot,
  type ProposedRung,
  type TransportReport,
} from '@thermal-label/harness-core/shared';
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
import {
  connectLabelwriterTcp,
  connectLabelwriterUsb,
  probeLabelwriterMedia,
  writeDiagnosticPrint,
} from './connect.js';
import { dispatchEncoder } from './multi-engine.js';
import { submitIssue, buildPrefillUrl, openInBrowser } from '../../submit.js';
import { renderBitmapPreview } from '../../bitmap-preview.js';
import { writeBitmapPngToTmp } from '../../bitmap-png.js';

const DRIVER_KEY = 'labelwriter';
const DRIVER_VERSION = driverVersion('@thermal-label/labelwriter-core');
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
      'mechanical reach (chassis geometry, automatically respected by the driver).',
  },
  {
    value: 'failing',
    name: 'failing — bytes go out, nothing usable comes back',
    description:
      'Bytes go out but the printer produces nothing usable. Empty borders are expected ' +
      'chassis geometry, not a defect.',
  },
];

export async function runLabelwriterVerify(options: VerifyOptions): Promise<void> {
  const ctx: PromptContext = { noPrompt: !options.wizard };

  const device = await resolveDevice(options, ctx);
  const engine = resolveEngine(device, options);
  const media = await resolveMedia(device, engine, options, ctx);

  const availableTransports = deviceTransports(device);
  if (availableTransports.length === 0) {
    throw new Error(`Device ${device.key} has no recognised transports declared.`);
  }

  printSessionHeader(device, engine, media);

  // Multi-transport loop. The first iteration honours `--transport`
  // (or auto-picks if exactly one is available); subsequent iterations
  // present the unused transports and let the operator pick or stop.
  const runs: TransportReport[] = [];
  const engineRuns: EngineReport[] = [];
  await runOneTransport({
    device,
    engine,
    media,
    options,
    ctx,
    isFirstIteration: true,
    availableTransports,
    usedTransports: new Set(),
    runs,
    engineRuns,
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
      engine,
      media,
      options,
      ctx,
      isFirstIteration: false,
      availableTransports,
      usedTransports: usedNames,
      runs,
      engineRuns,
    });
  }
}

interface RunOneTransportInput {
  device: LabelWriterDevice;
  engine: PrintEngine;
  media: LabelWriterAnyMedia;
  options: VerifyOptions;
  ctx: PromptContext;
  isFirstIteration: boolean;
  availableTransports: readonly TransportType[];
  usedTransports: ReadonlySet<TransportType>;
  runs: TransportReport[];
  engineRuns: EngineReport[];
}

async function runOneTransport(input: RunOneTransportInput): Promise<void> {
  const {
    device,
    engine,
    media,
    options,
    ctx,
    isFirstIteration,
    availableTransports,
    usedTransports,
  } = input;

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

  // Build the bitmap up front so `--preview` works hardware-free.
  // The dispatch helper picks the right encoder pair per
  // `engine.protocol` (lw-450/550 vs d1-tape) and prepends the Twin
  // roll-select prefix when the engine carries `bind.address`.
  const dispatched = dispatchEncoder({
    device,
    engine,
    media,
    harnessVersion: HARNESS_VERSION,
    driverVersion: DRIVER_VERSION,
  });
  const result = dispatched.buildBitmap();

  if (options.preview) {
    // Preview the AUTHORED bitmap — it shows the operator the full
    // label-sized layout, including the dead-zone bands they can
    // see in the photo afterwards. The wire bitmap is what actually
    // ships to the printer.
    console.log(renderBitmapPreview(result.authored));
    console.log('');
  }

  if (options.previewPng) {
    const pngPath = writeBitmapPngToTmp(
      result.authored,
      `verify-${device.key}-${engine.role}-${transport}`,
    );
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
  // the actual label pitch for form-feed/cut sequencing. The dispatch
  // helper prepends Twin's `ESC q <addr>` prefix internally; on
  // d1-tape the labelLengthDots argument is ignored.
  const identity = await runConnectAndPrint(device, engine, transport, host, options, () =>
    dispatched.encodeBitmap(result.wire, result.authored.heightPx),
  );

  const rung = await resolveRung(options, ctx);

  const notes = await resolveNotes(options, ctx);

  const transportReport: TransportReport = {
    name: transport,
    patterns: { diagnostic: 'pass' },
    rung,
    ...(notes ? { notes } : {}),
  };

  input.runs.push(transportReport);

  const engineReport: EngineReport = {
    role: engine.role,
    mediaKey: String(media.id),
    rung,
    ...(notes ? { notes } : {}),
  };
  // One entry per engine — `runs` is keyed by transport, but multiple
  // transports on the same engine should not duplicate the engine
  // report. Replace if we already have an entry for this role.
  const existingIndex = input.engineRuns.findIndex(e => e.role === engineReport.role);
  if (existingIndex >= 0) input.engineRuns[existingIndex] = engineReport;
  else input.engineRuns.push(engineReport);

  const report = buildReport({
    device,
    media,
    detectedIdentity: identity,
    transports: input.runs,
    engines: device.engines.length > 1 ? input.engineRuns : undefined,
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

function printSessionHeader(
  device: LabelWriterDevice,
  engine: PrintEngine,
  media: LabelWriterAnyMedia,
): void {
  console.log('');
  console.log(`Driver:    ${DRIVER_KEY} (core ${DRIVER_VERSION}, harness ${HARNESS_VERSION})`);
  console.log(`Model:     ${device.name}  [${device.key}]`);
  if (device.engines.length > 1) {
    console.log(`Engine:    ${engine.role} (${engine.protocol})`);
  }
  console.log(`Label:     ${media.name}  [${String(media.id)}]`);
  console.log('');
}

/**
 * Resolve which engine to drive on this device.
 *
 * `--engine <role>` always wins. Without the flag, default to
 * `engines[0]` for back-compat; single-engine devices ignore the flag
 * entirely. On a multi-engine device with no flag passed, we still
 * default to the first engine but flag it visibly so the operator
 * knows the other engines are not being exercised.
 */
function resolveEngine(device: LabelWriterDevice, options: VerifyOptions): PrintEngine {
  const requested = options.engine;
  if (requested !== undefined) {
    const match = device.engines.find(e => e.role === requested);
    if (!match) {
      const roles = device.engines.map(e => e.role).join(', ');
      throw new Error(
        `Device ${device.key} has no engine with role "${requested}". Available: ${roles}.`,
      );
    }
    return match;
  }
  const first = device.engines[0];
  if (!first) {
    throw new Error(`Device ${device.key} declares no engines.`);
  }
  if (device.engines.length > 1) {
    const others = device.engines
      .slice(1)
      .map(e => e.role)
      .join(', ');
    console.log(
      `[labelwriter] ${device.key} is multi-engine; defaulting to "${first.role}". ` +
        `Pass --engine <role> to drive ${others} instead.`,
    );
  }
  return first;
}

async function runConnectAndPrint(
  device: LabelWriterDevice,
  engine: PrintEngine,
  transport: TransportType,
  host: string | undefined,
  options: VerifyOptions,
  encode: () => Uint8Array,
): Promise<IdentitySnapshot> {
  if (options.dryRun) {
    // Materialise the encoded bytes so dry-run smoke tests can
    // observe the encoder dispatch (per-engine, per-protocol). The
    // bytes themselves go nowhere — `--dry-run` doesn't open
    // hardware.
    void encode();
    return synthesiseIdentity(device, engine, transport, host);
  }

  console.log(`Connecting over ${transport}${host !== undefined ? ` to ${host}:9100` : ''}...`);
  let session: { transport: Transport; identity: IdentitySnapshot };
  try {
    if (transport === 'usb') {
      // Duo's `tape` engine sits on a different USB interface from
      // its `label` engine. Pass the engine through so `connect.ts`
      // claims the right `bInterfaceNumber`.
      session = await connectLabelwriterUsb(device, engine);
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
  const bytes = encode();
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
  engine: PrintEngine,
  options: VerifyOptions,
  ctx: PromptContext,
): Promise<LabelWriterAnyMedia> {
  const isTapeEngine = engine.protocol === 'd1-tape';
  const compatible = isTapeEngine ? labelwriterTapeMedia() : labelwriterLabelMedia();

  if (options.media !== undefined) {
    const match = findMediaByKeyOrSku(options.media, isTapeEngine);
    if (!match) {
      throw new Error(formatUnknownLabel(options.media, compatible, isTapeEngine));
    }
    if (!isMediaCompatibleWithEngine(match, engine)) {
      throw new Error(
        `--media "${options.media}" is not compatible with engine "${engine.role}" ` +
          `(media targets: ${(match.targetModels ?? []).join(', ') || '(none)'}, ` +
          `engine accepts: ${(engine.mediaCompatibility ?? []).join(', ') || '(any)'}).`,
      );
    }
    return match;
  }

  // Try printer auto-detection on capable models. Skip on dry-run —
  // synthesised identity, no hardware contact. Only the label engine
  // does NFC SKU detection; the tape engine has no comparable probe.
  const detectsMedia = !isTapeEngine && engine.capabilities?.mediaDetection === true;
  if (detectsMedia && !options.dryRun) {
    const detected = await probeLabelwriterMedia(device);
    if (detected) {
      const match = findMediaByKeyOrSku(detected.sku, false);
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
    const reason = isTapeEngine
      ? `${device.key} engine "${engine.role}" is a tape engine (no auto-detection)`
      : detectsMedia
        ? `${device.key} has media detection but the probe returned nothing usable`
        : `${device.key} has no media detection`;
    const example = isTapeEngine
      ? '--media STANDARD_BLACK_ON_WHITE_12 or --media d1-standard-bw-12'
      : '--media ADDRESS_STANDARD or --media 30334';
    throw new Error(`--media is required for labelwriter (${reason}). Pass ${example}.`);
  }

  // Filter to media compatible with the active engine.
  const filtered = compatible.filter(m => isMediaCompatibleWithEngine(m, engine));
  const choices = (filtered.length > 0 ? filtered : compatible).map(m => ({
    value: String(m.id),
    name: `${m.name}  [${String(m.id)}]`,
  }));

  const picked = await promptSelect<string>(
    ctx,
    'media',
    isTapeEngine ? 'Pick the loaded D1 tape:' : 'Pick the loaded label:',
    choices,
  );
  const found = compatible.find(m => String(m.id) === picked);
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

function labelwriterTapeMedia(): readonly LabelWriterTapeMedia[] {
  return (Object.values(MEDIA) as readonly unknown[]).filter(isLabelWriterTapeMedia);
}

function findMediaByKeyOrSku(value: string, prefersTape: boolean): LabelWriterAnyMedia | undefined {
  const upper = value.toUpperCase();
  // First try MEDIA-registry key (e.g. ADDRESS_STANDARD,
  // STANDARD_BLACK_ON_WHITE_12).
  const byKey = (MEDIA as Record<string, unknown>)[upper];
  if (byKey !== undefined) {
    if (prefersTape && isLabelWriterTapeMedia(byKey)) return byKey;
    if (!prefersTape && isLabelWriterLabelMedia(byKey)) return byKey;
  }

  // Then try id / SKU lookup (e.g. `d1-standard-bw-12` for tape;
  // `30334` for paper). The id may be the lower-case dashed form.
  if (prefersTape) {
    for (const m of labelwriterTapeMedia()) {
      if (String(m.id) === value) return m;
    }
  } else {
    for (const m of labelwriterLabelMedia()) {
      if (m.skus?.includes(value)) return m;
      if (String(m.id) === value) return m;
    }
  }
  return undefined;
}

function isLabelWriterLabelMedia(m: unknown): m is LabelWriterMedia {
  if (typeof m !== 'object' || m === null) return false;
  const t = (m as { type?: string }).type;
  return t === 'die-cut' || t === 'continuous';
}

function isLabelWriterTapeMedia(m: unknown): m is LabelWriterTapeMedia {
  if (typeof m !== 'object' || m === null) return false;
  return (m as { type?: string }).type === 'tape';
}

function isMediaCompatibleWithEngine(media: LabelWriterAnyMedia, engine: PrintEngine): boolean {
  const targets = media.targetModels ?? [];
  const compat = engine.mediaCompatibility;
  if (compat === undefined) return true;
  return targets.some(t => compat.includes(t));
}

function formatUnknownLabel(
  value: string,
  media: readonly LabelWriterAnyMedia[],
  isTape: boolean,
): string {
  const lines: string[] = [];
  const noun = isTape ? 'tape' : 'label';
  lines.push(`Unknown labelwriter ${noun} "${value}". Pass either a media key or an id/SKU.`);
  lines.push('');
  lines.push(isTape ? 'Known tapes:' : 'Known labels:');
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

async function resolveRung(options: VerifyOptions, ctx: PromptContext): Promise<ProposedRung> {
  if (options.rung !== undefined) return options.rung;
  if (!ctx.noPrompt) {
    console.log(
      "FYI: empty space at the top or bottom is the head's mechanical reach (chassis " +
        'geometry, automatically respected by the driver), not a defect.',
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
  media: LabelWriterAnyMedia;
  detectedIdentity: IdentitySnapshot;
  transports: readonly TransportReport[];
  engines: readonly EngineReport[] | undefined;
  reporter: string | undefined;
}

function synthesiseIdentity(
  device: LabelWriterDevice,
  engine: PrintEngine,
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
      engineRole: engine.role,
      engineProtocol: engine.protocol,
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
    ...(input.engines && input.engines.length > 0 ? { engines: input.engines } : {}),
    environment: captureNodeEnvironment(),
    submittedAt: new Date().toISOString(),
    ...(input.reporter ? { reporter: { handle: input.reporter } } : {}),
  };
}
