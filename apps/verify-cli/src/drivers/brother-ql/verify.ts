/**
 * Brother-QL verify flow.
 *
 * Wizard-by-default. Mirrors the labelmanager driver's `verify.ts`
 * shape (resolveDevice / resolveTransport / runConnect / resolveRung /
 * resolveNotes / resolveShouldSubmit / submit dispatch) and adds:
 *
 *   - `--media <key>` resolution against `brother-ql-core`'s media
 *     catalog. Mandatory; the diagnostic-print can't be dimensioned
 *     without it. Wizard prompts when absent and the printer's
 *     status response didn't carry a detected media; flag overrides
 *     detection in all cases.
 *   - Multi-transport "test another transport on this device?" loop.
 *     QL-820NWB speaks USB + TCP-9100 (and Bluetooth-SPP, deferred —
 *     see TODO below). After submitting one transport's assessment,
 *     the wizard auto-suggests the unused transports and lets the
 *     operator add another rung in the same report's `transports[]`
 *     array.
 *   - Two-color media handling. When the resolved media carries a
 *     `palette`, the diagnostic-print encoder emits both planes; when
 *     the printer reports two-color media via the status probe but the
 *     operator passed a single-color `--media`, the harness logs the
 *     mismatch and proceeds with the operator's choice.
 *
 * Bluetooth-SPP TODO (deferred, plan-acknowledged):
 *   QL-820NWB declares `bluetooth-spp` and the production node adapter
 *   opens it via `SerialTransport` over OS-paired RFCOMM. Implementing
 *   here means: (a) prompting for `/dev/rfcomm<N>` (Linux) or `COM<N>`
 *   (Windows), (b) bypassing the platform-setup story which is its own
 *   PR (rfcomm-bind systemd unit / Windows Bluetooth pairing UX), and
 *   (c) verifying status-probe parity over a much slower channel. Out
 *   of scope for this MVP — the `--transport bluetooth-spp` path
 *   throws with a clear message pointing at the gap.
 */
import {
  DEVICES,
  MEDIA,
  type BrotherQLDevice,
  type BrotherQLMedia,
} from '@thermal-label/brother-ql-core';
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
  connectBrotherQlTcp,
  connectBrotherQlUsb,
  writeDiagnosticPrint,
  type ConnectedSession,
} from './connect.js';
import {
  buildDiagnosticBitmap,
  encodeBitmap,
  type DiagnosticPrintBitmaps,
} from './diagnostic-print.js';
import { submitIssue, buildPrefillUrl, openInBrowser } from '../../submit.js';
import { renderBitmapPreview } from '../../bitmap-preview.js';
import { writeBitmapPngToTmp, writeTwoColorPngToTmp } from '../../bitmap-png.js';

const DRIVER_KEY = 'brother-ql';
const DRIVER_VERSION = driverVersion('@thermal-label/brother-ql-core');
const TARGET_REPO = 'thermal-label/brother-ql';
const FALLBACK_EMAIL = 'mannes@krukje.nl';

/**
 * Transports the brother-ql driver knows how to drive from this CLI
 * runtime. `bluetooth-spp` is supported by the production node adapter
 * but not wired here — see the TODO at the top of this file.
 */
const SUPPORTED_TRANSPORTS: readonly TransportType[] = ['usb', 'tcp'];

const RUNG_CHOICES: readonly { value: ProposedRung; name: string; description: string }[] = [
  {
    value: 'verified',
    name: 'verified — looks right end-to-end',
    description: 'Print is legible, edges/cutter behave, no glaring artefacts.',
  },
  {
    value: 'partial',
    name: 'partial — works, but with caveats',
    description: 'Some aspect (margin, cutter, density, two-colour, drop) is off.',
  },
  {
    value: 'failing',
    name: 'failing — bytes go out, nothing usable comes back',
    description: 'Bytes go out but the printer produces nothing usable.',
  },
];

interface PerTransportRun {
  transport: TransportType;
  identity: IdentitySnapshot;
  rung: ProposedRung;
  notes: string | undefined;
}

export async function runBrotherQlVerify(options: VerifyOptions): Promise<void> {
  const ctx: PromptContext = { noPrompt: !options.wizard };

  const device = await resolveDevice(options, ctx);

  // First-pass transport resolution. The multi-transport loop below
  // can re-prompt for additional transports.
  const firstTransport = await resolveTransport(options.transport, device, ctx, []);

  // First pass: media resolution. The flag overrides; otherwise we
  // attempt to detect from the first transport's status probe (if
  // online). The wizard's "test another transport" loop reuses the
  // same media for subsequent runs (the user re-runs to swap rolls).
  // For dry-run, we resolve from the flag or hard-fail with a useful
  // listing.
  const detected = await probeForDetectedMedia(device, firstTransport, options);
  const media = await resolveMedia(options, ctx, detected);

  printSessionHeader(device, firstTransport, media);

  const bitmaps = buildDiagnosticBitmap({
    device,
    media,
    harnessVersion: HARNESS_VERSION,
    driverVersion: DRIVER_VERSION,
  });

  if (options.preview) {
    if (bitmaps.red) {
      console.log('Black plane:');
      console.log(renderBitmapPreview(bitmaps.black));
      console.log('');
      console.log('Red plane:');
      console.log(renderBitmapPreview(bitmaps.red));
    } else {
      console.log(renderBitmapPreview(bitmaps.black));
    }
    console.log('');
  }
  if (options.previewPng) {
    const path = bitmaps.red
      ? writeTwoColorPngToTmp({ black: bitmaps.black, red: bitmaps.red }, `verify-${device.key}`)
      : writeBitmapPngToTmp(bitmaps.black, `verify-${device.key}`);
    console.log(`Wrote PNG preview: ${path}`);
    const launcher = openInBrowser(path);
    if (launcher) {
      console.log(`(Opening with ${launcher}; if nothing appeared, open the path above manually.)`);
    }
    console.log('');
  }

  const runs: PerTransportRun[] = [];

  // First transport pass.
  const firstRun = await runTransportPass({
    transport: firstTransport,
    device,
    media,
    bitmaps,
    options,
    ctx,
  });
  runs.push(firstRun);

  // Multi-transport loop. Auto-suggest unused supported transports.
  for (;;) {
    const used = new Set(runs.map(r => r.transport));
    const remaining = SUPPORTED_TRANSPORTS.filter(t => !used.has(t));
    if (remaining.length === 0) break;
    const cont = await resolveContinueAnotherTransport(ctx, remaining);
    if (!cont) break;

    const nextTransport = await resolveTransport(
      undefined,
      device,
      ctx,
      runs.map(r => r.transport),
    );
    const nextRun = await runTransportPass({
      transport: nextTransport,
      device,
      media,
      bitmaps,
      options,
      ctx,
    });
    runs.push(nextRun);
  }

  const report = buildReport({
    device,
    media,
    runs,
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

interface TransportPassInput {
  transport: TransportType;
  device: BrotherQLDevice;
  media: BrotherQLMedia;
  bitmaps: DiagnosticPrintBitmaps;
  options: VerifyOptions;
  ctx: PromptContext;
}

async function runTransportPass(input: TransportPassInput): Promise<PerTransportRun> {
  const { transport, device, media, bitmaps, options, ctx } = input;

  console.log('');
  console.log(`--- ${transport} ---`);
  console.log(transportInstructions[transport].inline);
  console.log('');

  const identity = await runConnect({ transport, device, bitmaps, media, options, ctx });
  const rung = await resolveRung(options, ctx);
  const notes = await resolveNotes(options, ctx);

  return { transport, identity, rung, notes };
}

async function runConnect(input: TransportPassInput): Promise<IdentitySnapshot> {
  const { transport, device, bitmaps, media, options, ctx } = input;

  if (options.dryRun) {
    return synthesiseIdentity(device, transport);
  }

  const session = await openSession(transport, device, options, ctx);
  console.log(`Connected. ${describeIdentity(session.identity)}`);

  console.log('Encoding diagnostic print...');
  const bytes = encodeBitmap(bitmaps, device, media);
  console.log(`Sending ${String(bytes.length)} bytes to printer...`);
  try {
    await writeDiagnosticPrint(session.transport, bytes);
  } catch (err) {
    if (err instanceof TransportClosedError) {
      throw new Error(
        `${transport} transport closed mid-write. Check the cable / power / network; ` +
          'no bytes were buffered, so re-running is safe.',
      );
    }
    throw err;
  }
  console.log('Diagnostic print sent.');

  await session.transport.close();
  return session.identity;
}

async function openSession(
  transport: TransportType,
  device: BrotherQLDevice,
  options: VerifyOptions,
  ctx: PromptContext,
): Promise<ConnectedSession> {
  switch (transport) {
    case 'usb':
      try {
        return await connectBrotherQlUsb({ device });
      } catch (err) {
        if (err instanceof DeviceNotFoundError) {
          throw new Error(
            `No USB device found matching ${device.key} (vid=0x${device.transports.usb?.vid ?? '?'} ` +
              `pid=0x${device.transports.usb?.pid ?? '?'}). Plug it in (off Editor Lite mode), ` +
              'or pass --dry-run to exercise the rendering path without hardware.',
          );
        }
        throw err;
      }
    case 'tcp': {
      const host = await resolveTcpHost(options, ctx);
      const port = options.port;
      return connectBrotherQlTcp({ device, host, ...(port === undefined ? {} : { port }) });
    }
    case 'bluetooth-spp':
      throw new Error(
        'bluetooth-spp transport for brother-ql is not implemented in verify-cli yet. ' +
          'See the TODO note in `apps/verify-cli/src/drivers/brother-ql/verify.ts` — ' +
          'the production node adapter does support it via SerialTransport over OS-paired RFCOMM, ' +
          'but the platform-setup story (rfcomm-bind on Linux, OS pairing on Windows) is its own PR.',
      );
    default:
      throw new Error(`Unsupported brother-ql transport: ${transport}`);
  }
}

async function resolveTcpHost(options: VerifyOptions, ctx: PromptContext): Promise<string> {
  if (options.host !== undefined) return options.host;
  if (ctx.noPrompt) throw new NoPromptError('host');
  const value = await promptInput(ctx, 'host', 'TCP host (IP address or hostname of the printer):');
  const trimmed = value.trim();
  if (!trimmed) throw new Error('TCP host is required for the tcp transport.');
  return trimmed;
}

function describeIdentity(identity: IdentitySnapshot): string {
  const parts: string[] = [];
  if (identity.vid !== undefined && identity.pid !== undefined) {
    parts.push(`vid=0x${identity.vid.toString(16)} pid=0x${identity.pid.toString(16)}`);
  }
  const extra = identity.extra ?? {};
  if (typeof extra.host === 'string') parts.push(`host=${extra.host}`);
  if (extra.mediaLoaded === true && extra.detectedMedia) {
    const det = extra.detectedMedia as { name?: string };
    parts.push(`detected=${det.name ?? '?'}`);
  }
  if (extra.twoColorRoll === true) parts.push('two-color roll');
  return parts.join(' ') || '(no identifying metadata)';
}

async function resolveContinueAnotherTransport(
  ctx: PromptContext,
  remaining: readonly TransportType[],
): Promise<boolean> {
  if (ctx.noPrompt) return false;
  return promptConfirm(
    ctx,
    'continue',
    `Test another transport on this device? (remaining: ${remaining.join(', ')})`,
    false,
  );
}

function printSessionHeader(
  device: BrotherQLDevice,
  transport: TransportType,
  media: BrotherQLMedia,
): void {
  console.log('');
  console.log(`Driver:    ${DRIVER_KEY} (core ${DRIVER_VERSION}, harness ${HARNESS_VERSION})`);
  console.log(`Model:     ${device.name}  [${device.key}]`);
  console.log(`Transport: ${transport}  (first pass; the wizard may add more after submit)`);
  const skus = (media.skus ?? []).join(', ') || `id ${media.id.toString()}`;
  const colorTag = media.palette ? '  (two-color)' : '';
  console.log(`Media:     ${media.name}  [${skus}]${colorTag}`);
}

async function resolveDevice(options: VerifyOptions, ctx: PromptContext): Promise<BrotherQLDevice> {
  const known = Object.values(DEVICES).filter(d => d.engines.some(e => e.protocol === 'ql-raster'));

  if (options.model !== undefined) {
    const match = known.find(d => d.key === options.model);
    if (!match) {
      throw new Error(
        `Unknown brother-ql model "${options.model}". Known QL keys:\n  ${known
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
    'Pick a brother-ql model:',
    known.map(d => ({ value: d.key, name: `${d.name}  [${d.key}]` })),
  );
  const found = known.find(d => d.key === key);
  if (!found) throw new Error(`Picked unknown key ${key}`);
  return found;
}

async function resolveTransport(
  flag: TransportType | undefined,
  device: BrotherQLDevice,
  ctx: PromptContext,
  alreadyUsed: readonly TransportType[],
): Promise<TransportType> {
  if (flag !== undefined) {
    if (!SUPPORTED_TRANSPORTS.includes(flag)) {
      throw new Error(
        `brother-ql verify-cli only supports ${SUPPORTED_TRANSPORTS.join(', ')} today; ` +
          `got "${flag}". (bluetooth-spp lives in the production node adapter but is not wired here yet — see the TODO in verify.ts.)`,
      );
    }
    if (!hasTransport(device, flag)) {
      throw new Error(`Device ${device.key} does not declare a ${flag} transport in the registry.`);
    }
    return flag;
  }

  const available = SUPPORTED_TRANSPORTS.filter(
    t => hasTransport(device, t) && !alreadyUsed.includes(t),
  );
  if (available.length === 0) {
    throw new Error(
      `No supported transports remaining for ${device.key}. Used: ${alreadyUsed.join(', ') || '(none)'}.`,
    );
  }
  const [only, ...rest] = available;
  if (only !== undefined && rest.length === 0) return only;

  return promptSelect<TransportType>(
    ctx,
    'transport',
    'Pick a transport:',
    available.map(t => ({ value: t, name: t })),
  );
}

function hasTransport(device: BrotherQLDevice, transport: TransportType): boolean {
  return device.transports[transport] !== undefined;
}

/**
 * Best-effort detection probe ahead of `resolveMedia`. Opens the first
 * transport just long enough to read the printer's status response,
 * then closes — `resolveMedia` then has a `detected` candidate to
 * default to.
 *
 * Skipped when:
 *   - `--dry-run` (no hardware access)
 *   - `--media <sku>` was passed (the flag wins; no point probing)
 *   - first transport is TCP (host isn't known until `runTransportPass`
 *     prompts for it; TCP detection happens implicitly during the
 *     real connect later, but media has to be resolved before the
 *     bitmap is built — pass `--media` for TCP-only setups)
 *
 * Failures are silent: if the probe throws, returns undefined and
 * `resolveMedia` falls through to its prompt / hard-fail path.
 */
async function probeForDetectedMedia(
  device: BrotherQLDevice,
  transport: TransportType,
  options: VerifyOptions,
): Promise<BrotherQLMedia | undefined> {
  if (options.dryRun) return undefined;
  if (options.media !== undefined) return undefined;
  if (transport !== 'usb') return undefined;
  try {
    const session = await connectBrotherQlUsb({ device });
    // `BrotherQLStatus.detectedMedia` is typed as the upstream's
    // `MediaDescriptor`; the brother-ql core's MEDIA registry hits the
    // same shape with the structural `BrotherQLMedia` extension. Same
    // cast pattern as connect.ts uses internally.
    const detected = session.status?.detectedMedia as BrotherQLMedia | undefined;
    await session.transport.close();
    return detected;
  } catch {
    return undefined;
  }
}

async function resolveMedia(
  options: VerifyOptions,
  ctx: PromptContext,
  detected?: BrotherQLMedia,
): Promise<BrotherQLMedia> {
  if (options.media !== undefined) {
    const match = findMediaBySku(options.media);
    if (!match) {
      throw new Error(
        `Unknown brother-ql media "${options.media}". Pass a SKU from the brother-ql-core ` +
          `media catalog. Common DK SKUs:\n  ${listKnownSkus(20).join('\n  ')}\n` +
          `(See \`@thermal-label/brother-ql-core\` MEDIA registry for the full list.)`,
      );
    }
    if (detected && detected.id !== match.id) {
      console.warn(
        `[brother-ql] Status probe detected ${detected.name}, but --media overrode to ${match.name}. Proceeding with the flag.`,
      );
    }
    return match;
  }
  if (detected) {
    console.log(`[brother-ql] Detected media from status probe: ${detected.name}.`);
    return detected;
  }
  if (ctx.noPrompt) {
    throw new Error(
      `--media is required for brother-ql when status detection isn't available. ` +
        `Pass --media <SKU> (e.g. --media DK-22205). Common DK SKUs:\n  ${listKnownSkus(20).join('\n  ')}`,
    );
  }
  const sku = await promptSelect<string>(
    ctx,
    'media',
    'Pick the loaded DK media:',
    listDkMediaChoices(),
  );
  const match = findMediaBySku(sku);
  if (!match) throw new Error(`Picked unknown media SKU ${sku}`);
  return match;
}

function findMediaBySku(sku: string): BrotherQLMedia | undefined {
  const want = sku.trim().toUpperCase();
  return Object.values(MEDIA).find(m => (m.skus ?? []).some(s => s.toUpperCase() === want));
}

function listKnownSkus(limit: number): string[] {
  const out: string[] = [];
  for (const media of Object.values(MEDIA)) {
    if (media.tapeSystem !== 'dk') continue;
    for (const sku of media.skus ?? []) {
      if (!out.includes(sku)) out.push(sku);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function listDkMediaChoices(): { value: string; name: string }[] {
  const seen = new Set<string>();
  const choices: { value: string; name: string }[] = [];
  for (const media of Object.values(MEDIA)) {
    if (media.tapeSystem !== 'dk') continue;
    for (const sku of media.skus ?? []) {
      if (seen.has(sku)) continue;
      seen.add(sku);
      choices.push({ value: sku, name: `${sku} — ${media.name}` });
    }
  }
  return choices;
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
    'Add a free-text note about what came out? (e.g. "two-colour red looks faded")',
    false,
  );
  if (!confirmAdd) return undefined;
  const text = await promptInput(ctx, 'notes', 'Notes:');
  return text.trim() || undefined;
}

interface BuildReportInput {
  device: BrotherQLDevice;
  media: BrotherQLMedia;
  runs: readonly PerTransportRun[];
  reporter: string | undefined;
}

function synthesiseIdentity(device: BrotherQLDevice, transport: TransportType): IdentitySnapshot {
  const usb = device.transports.usb;
  const tcp = device.transports.tcp;
  return {
    advertisedName: device.name,
    ...(usb ? { vid: parseInt(usb.vid, 16), pid: parseInt(usb.pid, 16) } : {}),
    extra: {
      synthesised: true,
      source: 'dry-run-fallback',
      transport,
      ...(transport === 'tcp' && tcp ? { tcpPort: tcp.port } : {}),
    },
  };
}

function buildReport(input: BuildReportInput): HardwareReport {
  const usb = input.device.transports.usb;

  // Use the first transport's identity as the canonical "detected"
  // snapshot. The triage parser surfaces per-transport details
  // separately via `transports[].notes`; this matches how labelmanager
  // reports its single-transport identity.
  const firstIdentity = input.runs[0]?.identity ?? {
    advertisedName: input.device.name,
  };

  const transportReports: TransportReport[] = input.runs.map(run => ({
    name: run.transport,
    patterns: { diagnostic: 'pass' },
    rung: run.rung,
    ...(run.notes ? { notes: run.notes } : {}),
  }));

  return {
    schemaVersion: 1,
    driver: DRIVER_KEY,
    driverVersion: DRIVER_VERSION,
    harnessVersion: HARNESS_VERSION,
    device: {
      detected: firstIdentity,
      confirmed: {
        model: input.device.name,
        ...(usb ? { vid: parseInt(usb.vid, 16), pid: parseInt(usb.pid, 16) } : {}),
        overrides: {
          mediaSku: (input.media.skus ?? [])[0] ?? `id-${input.media.id.toString()}`,
          mediaName: input.media.name,
          twoColor: input.media.palette !== undefined,
        },
      },
    },
    transports: transportReports,
    environment: captureNodeEnvironment(),
    submittedAt: new Date().toISOString(),
    ...(input.reporter ? { reporter: { handle: input.reporter } } : {}),
  };
}

function buildIssueTitle(report: HardwareReport): string {
  const transports = report.transports.map(t => t.name).join('+');
  const model = report.device.confirmed.model;
  // Worst rung wins for the title — same convention as the issue body
  // headline (`renderIssueBody` does the same internally).
  const rung = pickWorstRung(report.transports.map(t => t.rung));
  return `[harness] ${model} on ${transports} — ${rung}`;
}

function pickWorstRung(rungs: readonly ProposedRung[]): ProposedRung {
  if (rungs.includes('failing')) return 'failing';
  if (rungs.includes('partial')) return 'partial';
  return 'verified';
}
