/**
 * Brother-QL `DriverAdapter` — wires brother-ql-core into the shared
 * harness shell.
 *
 * Placeholder during the bootstrap commit; the real wiring (catalogue,
 * connect, status, encoder, report) lands in the next commit. Kept as
 * a typed stub so `main.ts` compiles and the workspace install /
 * typecheck / lint gates stay green at this commit.
 */
import type { DriverAdapter } from '@thermal-label/harness-shell';
import {
  DEVICES,
  type BrotherQLDevice,
  type BrotherQLMedia,
  type BrotherQLStatus,
} from '@thermal-label/brother-ql-core';

export const adapter: DriverAdapter<BrotherQLDevice, BrotherQLMedia, BrotherQLStatus> = {
  driverKey: 'brother-ql',
  driverDisplayName: 'Brother QL',
  targetRepo: 'thermal-label/brother-ql',
  harnessVersion: '0.0.0-dev',
  driverVersion: '0.5.0',
  devices: Object.values(DEVICES),
  deviceKey: d => d.key,
  deviceName: d => d.name,
  // eslint-disable-next-line @typescript-eslint/require-await
  connect: async () => {
    throw new Error('brother-ql adapter not yet implemented');
  },
  mockTargets: {},
  media: [],
  mediaPicker: {
    filterByDeviceEngine: m => m,
    groupBy: () => ({ key: 'all', label: 'All', priority: 'primary' }),
    defaultMediaId: () => 0,
    detectionCapability: () => 'none',
  },
  encoder: {
    buildBitmap: () => {
      throw new Error('not implemented');
    },
    encodeBytes: () => {
      throw new Error('not implemented');
    },
  },
  buildReport: () => {
    throw new Error('not implemented');
  },
};
