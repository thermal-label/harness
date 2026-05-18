/**
 * End-to-end smoke test: spawns the verify-cli with `--dry-run` and a
 * fully-flagged labelmanager invocation, then parses the embedded JSON
 * block out of stdout to confirm the rendered `IssueBody` is valid.
 *
 * This is the closest thing to "real" coverage we can offer without a
 * printer in the loop — the maintainer runs the live-hardware path
 * separately on bench gear.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HardwareReport } from '@thermal-label/harness-core/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENTRY = resolve(__dirname, '../index.ts');

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runCli(args: readonly string[]): Promise<RunResult> {
  return new Promise((res, rej) => {
    const child = spawn('npx', ['tsx', ENTRY, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', rej);
    child.once('exit', code => {
      res({ stdout, stderr, exitCode: code });
    });
  });
}

function extractJsonReport(body: string): HardwareReport {
  const match = /```json\n([\s\S]*?)\n```/.exec(body);
  if (match?.[1] === undefined) {
    throw new Error(`No JSON block found in body:\n${body}`);
  }
  return JSON.parse(match[1]) as HardwareReport;
}

describe('verify-cli --dry-run end-to-end', () => {
  it('renders a valid HardwareReport for labelmanager LM_PNP usb', async () => {
    const result = await runCli([
      'verify',
      'labelmanager',
      'LM_PNP',
      '--transport',
      'usb',
      '--rung',
      'verified',
      '--notes',
      'bench self-validation',
      '--no-prompt',
      '--dry-run',
    ]);

    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);
    const report = extractJsonReport(result.stdout);

    expect(report.schemaVersion).toBe(1);
    expect(report.driver).toBe('labelmanager');
    expect(report.device.confirmed.model).toBe('LabelManager PnP');
    expect(report.device.detected.vid).toBe(0x0922);
    expect(report.device.detected.pid).toBe(0x1002);
    expect(report.transports).toHaveLength(1);
    expect(report.transports[0]?.name).toBe('usb');
    expect(report.transports[0]?.rung).toBe('verified');
    expect(report.transports[0]?.notes).toBe('bench self-validation');
    expect(report.transports[0]?.patterns.diagnostic).toBe('pass');
    // submittedAt should parse as a valid ISO timestamp.
    expect(Number.isFinite(Date.parse(report.submittedAt))).toBe(true);
  }, 30_000);

  it('rejects unknown model keys', async () => {
    const result = await runCli([
      'verify',
      'labelmanager',
      'LM_NONEXISTENT',
      '--transport',
      'usb',
      '--rung',
      'verified',
      '--no-prompt',
      '--dry-run',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Unknown labelmanager model/);
  }, 30_000);

  it('rejects unsupported transports for labelmanager', async () => {
    const result = await runCli([
      'verify',
      'labelmanager',
      'LM_PNP',
      '--transport',
      'tcp',
      '--rung',
      'verified',
      '--no-prompt',
      '--dry-run',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/labelmanager only speaks usb today/);
  }, 30_000);

  it('renders a valid HardwareReport for labelwriter LW_330_TURBO usb', async () => {
    const result = await runCli([
      'verify',
      'labelwriter',
      'LW_330_TURBO',
      '--transport',
      'usb',
      '--media',
      'ADDRESS_STANDARD',
      '--rung',
      'verified',
      '--notes',
      'bench self-validation',
      '--no-prompt',
      '--dry-run',
    ]);

    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);
    const report = extractJsonReport(result.stdout);

    expect(report.schemaVersion).toBe(1);
    expect(report.driver).toBe('labelwriter');
    expect(report.device.confirmed.model).toBe('LabelWriter 330 Turbo');
    expect(report.device.detected.vid).toBe(0x0922);
    expect(report.device.detected.pid).toBe(0x0008);
    expect(report.transports).toHaveLength(1);
    expect(report.transports[0]?.name).toBe('usb');
    expect(report.transports[0]?.rung).toBe('verified');
    expect(report.transports[0]?.notes).toBe('bench self-validation');
    expect(report.device.confirmed.overrides?.label).toBe('address-standard');
    expect(Number.isFinite(Date.parse(report.submittedAt))).toBe(true);
  }, 30_000);

  it('accepts a SKU as --media for labelwriter', async () => {
    // 30252 → ADDRESS_STANDARD (89×28mm).
    const result = await runCli([
      'verify',
      'labelwriter',
      'LW_330_TURBO',
      '--transport',
      'usb',
      '--media',
      '30252',
      '--rung',
      'verified',
      '--no-prompt',
      '--dry-run',
    ]);
    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);
    const report = extractJsonReport(result.stdout);
    expect(report.device.confirmed.overrides?.label).toBe('address-standard');
  }, 30_000);

  it('rejects unknown labels with a useful list', async () => {
    const result = await runCli([
      'verify',
      'labelwriter',
      'LW_330_TURBO',
      '--transport',
      'usb',
      '--media',
      'NOT_A_REAL_LABEL',
      '--rung',
      'verified',
      '--no-prompt',
      '--dry-run',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Unknown labelwriter label/);
    expect(result.stderr).toMatch(/Known labels:/);
    expect(result.stderr).toMatch(/address-standard/);
  }, 30_000);

  it('requires --media for non-detecting labelwriter under --no-prompt', async () => {
    // LW_330_TURBO has no media detection — flag is mandatory in --no-prompt.
    const result = await runCli([
      'verify',
      'labelwriter',
      'LW_330_TURBO',
      '--transport',
      'usb',
      '--rung',
      'verified',
      '--no-prompt',
      '--dry-run',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/--media is required for labelwriter/);
    expect(result.stderr).toMatch(/no media detection/);
  }, 30_000);

  it('renders a multi-engine HardwareReport for LW_450_DUO --engine label', async () => {
    const result = await runCli([
      'verify',
      'labelwriter',
      'LW_450_DUO',
      '--transport',
      'usb',
      '--engine',
      'label',
      '--media',
      'ADDRESS_STANDARD',
      '--rung',
      'verified',
      '--no-prompt',
      '--dry-run',
    ]);

    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);
    const report = extractJsonReport(result.stdout);
    expect(report.driver).toBe('labelwriter');
    expect(report.device.confirmed.model).toBe('LabelWriter 450 Duo');
    expect(report.engines).toBeDefined();
    expect(report.engines).toHaveLength(1);
    expect(report.engines?.[0]?.role).toBe('label');
    expect(report.engines?.[0]?.mediaKey).toBe('address-standard');
    expect(report.engines?.[0]?.rung).toBe('verified');
  }, 30_000);

  it('renders a multi-engine HardwareReport for LW_450_DUO --engine tape', async () => {
    const result = await runCli([
      'verify',
      'labelwriter',
      'LW_450_DUO',
      '--transport',
      'usb',
      '--engine',
      'tape',
      '--media',
      'STANDARD_BLACK_ON_WHITE_12',
      '--rung',
      'verified',
      '--no-prompt',
      '--dry-run',
    ]);

    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);
    const report = extractJsonReport(result.stdout);
    expect(report.engines).toBeDefined();
    expect(report.engines?.[0]?.role).toBe('tape');
    expect(report.engines?.[0]?.mediaKey).toBe('d1-standard-bw-12');
    // Synthesised identity carries the engine routing for triage.
    expect(report.device.detected.extra?.engineRole).toBe('tape');
    expect(report.device.detected.extra?.engineProtocol).toBe('d1-tape');
  }, 30_000);

  it('Twin Turbo --engine right defaults right roll', async () => {
    const result = await runCli([
      'verify',
      'labelwriter',
      'LW_TWIN_TURBO',
      '--transport',
      'usb',
      '--engine',
      'right',
      '--media',
      'ADDRESS_STANDARD',
      '--rung',
      'verified',
      '--no-prompt',
      '--dry-run',
    ]);
    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0);
    const report = extractJsonReport(result.stdout);
    expect(report.engines?.[0]?.role).toBe('right');
  }, 30_000);

  it('rejects --engine on a multi-engine device with an unknown role', async () => {
    const result = await runCli([
      'verify',
      'labelwriter',
      'LW_450_DUO',
      '--transport',
      'usb',
      '--engine',
      'banana',
      '--media',
      'ADDRESS_STANDARD',
      '--rung',
      'verified',
      '--no-prompt',
      '--dry-run',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/has no engine with role "banana"/);
  }, 30_000);

  it('rejects mismatched media for --engine tape (d1-tape engine wants tape media)', async () => {
    const result = await runCli([
      'verify',
      'labelwriter',
      'LW_450_DUO',
      '--transport',
      'usb',
      '--engine',
      'tape',
      // ADDRESS_STANDARD is paper, not tape — should reject.
      '--media',
      'ADDRESS_STANDARD',
      '--rung',
      'verified',
      '--no-prompt',
      '--dry-run',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(
      /(tape|not compatible with engine "tape"|Unknown labelwriter tape)/i,
    );
  }, 30_000);

  it('rejects a TCP transport on a USB-only labelwriter model', async () => {
    const result = await runCli([
      'verify',
      'labelwriter',
      'LW_330_TURBO',
      '--transport',
      'tcp',
      '--media',
      'ADDRESS_STANDARD',
      '--host',
      '10.0.0.1',
      '--rung',
      'verified',
      '--no-prompt',
      '--dry-run',
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/Device declares no tcp transport/);
  }, 30_000);
});
