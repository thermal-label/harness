/**
 * Capture the Node runtime + OS for the `environment` block of a
 * `HardwareReport` — the verify-cli counterpart to the browser
 * harness's `captureEnvironment` (`harness-shell`).
 */
import { release } from 'node:os';
import process from 'node:process';
import type { EnvironmentSnapshot } from '@thermal-label/harness-core/shared';

/** Canonical OS names keyed by `process.platform`. */
const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
  android: 'Android',
};

/** The Node runtime + OS this verify-cli process is running on. */
export function captureNodeEnvironment(): EnvironmentSnapshot {
  return {
    runtime: 'node',
    nodeVersion: process.versions.node,
    os: OS_NAMES[process.platform] ?? process.platform,
    osVersion: release(),
  };
}
