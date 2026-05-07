import { describe, expect, it } from 'vitest';
import type { TransportType } from '@thermal-label/contracts';
import { transportInstructions } from '../transport-instructions.js';

const ALL_TRANSPORTS: readonly TransportType[] = [
  'usb',
  'tcp',
  'serial',
  'bluetooth-spp',
  'bluetooth-gatt',
];

describe('transportInstructions registry', () => {
  it('has an entry for every TransportType the contracts package exports', () => {
    for (const t of ALL_TRANSPORTS) {
      expect(transportInstructions[t]).toBeDefined();
      expect(transportInstructions[t].inline.length).toBeGreaterThan(0);
    }
  });

  it('has no extra keys beyond the known TransportType values', () => {
    const keys = new Set(Object.keys(transportInstructions));
    expect(keys.size).toBe(ALL_TRANSPORTS.length);
    for (const t of ALL_TRANSPORTS) expect(keys.has(t)).toBe(true);
  });
});
