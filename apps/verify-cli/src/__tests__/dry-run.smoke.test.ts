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
  const match = body.match(/```json\n([\s\S]*?)\n```/);
  if (!match || match[1] === undefined) {
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
      '--reporter',
      '@mannes',
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
    expect(report.reporter?.handle).toBe('@mannes');
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
});
