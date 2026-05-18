/**
 * `DiagnosticsSnapshot` — a lightweight, always-available diagnostic
 * artifact produced by the harness submit block the moment a device is
 * connected, *before* the print/verdict gate.
 *
 * This is deliberately **not** a `HardwareReport`: no rung, no verdict,
 * no print, no `schemaVersion`. A `HardwareReport` is the verified
 * output of a full print run feeding the supported-hardware matrix; a
 * `DiagnosticsSnapshot` is a "what does your device/connection actually
 * look like?" forensics dump for triaging an *existing* GitHub ticket.
 * The reporter connects, copies a comment-ready fenced ` ```json `
 * block, and pastes it into a reply — no new issue.
 *
 * The shape is driver-agnostic: identity, `PrinterStatus`, and
 * `MediaDescriptor` are all standard contract shapes, so a single
 * generic builder assembles it from session + adapter state with no
 * per-driver hook.
 */

import type { PrinterStatus } from '@thermal-label/contracts';
import type { EnvironmentSnapshot, IdentitySnapshot } from './hardware-report.js';
import { serializeStatus, type SerializedStatus } from './serialize-status.js';

/**
 * JSON-safe projection of one engine's detected media — a subset of
 * `MediaDescriptor`. The full descriptor carries driver-specific
 * supersets (head geometry, margins, etc.); the snapshot keeps only the
 * fields a triage reader needs to identify the media at a glance.
 */
export interface DiagnosticsMedia {
  id: string | number;
  name: string;
  widthMm: number;
  heightMm?: number;
  type: string;
}

/**
 * Per-engine slice of the snapshot.
 *
 * `status` is a {@link SerializedStatus} — the shared JSON-safe
 * projection of `PrinterStatus` (`rawBytes` as a hex string, every
 * other field verbatim). `null` when the engine has not been polled
 * yet.
 */
export interface DiagnosticsEngine {
  /** Engine role — matches `PrintEngine.role` (`'label'`, `'tape'`, ...). */
  role: string;
  /** Shared JSON-safe `PrinterStatus` projection — see {@link SerializedStatus}. */
  status: SerializedStatus | null;
  /** JSON-safe projection of the detected media, if the printer reports any. */
  detectedMedia: DiagnosticsMedia | null;
}

/**
 * Top-level diagnostics artifact. Copied as a fenced ` ```json ` block
 * (see `renderDiagnosticsBlock`) so it pastes straight into a GitHub
 * comment.
 */
export interface DiagnosticsSnapshot {
  /** ISO-8601 timestamp at capture time. */
  capturedAt: string;
  harness: {
    /** Driver key — matches the driver's repo name (e.g. `'letratag'`). */
    driverKey: string;
    /** Harness app version. */
    harnessVersion: string;
    /** Driver `-core` package version the harness was built against. */
    driverVersion: string;
  };
  /** True when the connection is mock-backed. */
  mocked: boolean;
  /**
   * Browser + OS the harness ran in. Optional — absent on a snapshot
   * captured before the environment probe resolved.
   */
  environment?: EnvironmentSnapshot;
  device: IdentitySnapshot;
  engines: DiagnosticsEngine[];
}

/** One engine's input to the builder — its role + latest polled status. */
export interface DiagnosticsEngineInput {
  role: string;
  status: PrinterStatus | null;
}

/** Input to {@link buildDiagnosticsSnapshot}. */
export interface BuildDiagnosticsSnapshotInput {
  driverKey: string;
  harnessVersion: string;
  driverVersion: string;
  mocked: boolean;
  /** Browser + OS the harness ran in. Omitted ⇒ no `environment` block. */
  environment?: EnvironmentSnapshot;
  device: IdentitySnapshot;
  engines: readonly DiagnosticsEngineInput[];
  /**
   * Capture timestamp. Optional — defaults to `new Date()` at call
   * time. Exposed so tests can pin a deterministic value.
   */
  capturedAt?: Date;
}

/**
 * Project a printer-reported `MediaDescriptor` into the snapshot's
 * narrow {@link DiagnosticsMedia} shape — drops driver-specific
 * supersets, keeps the identifying fields.
 */
function projectMedia(media: PrinterStatus['detectedMedia']): DiagnosticsMedia | null {
  if (!media) return null;
  const projected: DiagnosticsMedia = {
    id: media.id,
    name: media.name,
    widthMm: media.widthMm,
    type: media.type,
  };
  if (media.heightMm !== undefined) projected.heightMm = media.heightMm;
  return projected;
}

/**
 * Generic builder — assembles a {@link DiagnosticsSnapshot} from session
 * + adapter state. Driver-agnostic: no per-driver hook, because every
 * input is a standard contract shape.
 */
export function buildDiagnosticsSnapshot(
  input: BuildDiagnosticsSnapshotInput,
): DiagnosticsSnapshot {
  return {
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    harness: {
      driverKey: input.driverKey,
      harnessVersion: input.harnessVersion,
      driverVersion: input.driverVersion,
    },
    mocked: input.mocked,
    ...(input.environment ? { environment: input.environment } : {}),
    device: input.device,
    engines: input.engines.map(engine => ({
      role: engine.role,
      status: engine.status ? serializeStatus(engine.status) : null,
      detectedMedia: engine.status ? projectMedia(engine.status.detectedMedia) : null,
    })),
  };
}

/**
 * Render a {@link DiagnosticsSnapshot} as a GitHub-comment-ready fenced
 * ` ```json ` block. Unlike `renderIssueBody`, there is no prose
 * summary and no `<details>` wrapper — the snapshot is meant to be
 * pasted inline into a reply on an existing ticket.
 */
export function renderDiagnosticsBlock(snapshot: DiagnosticsSnapshot): string {
  const json = JSON.stringify(snapshot, null, 2);
  return ['```json', json, '```'].join('\n');
}
