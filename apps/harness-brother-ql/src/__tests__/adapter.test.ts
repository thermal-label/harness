/**
 * Smoke + integration tests for the brother-ql `DriverAdapter`.
 *
 * Covers the three behaviours called out in the brief:
 *
 *  1. Single-engine: `multiEngine` is omitted entirely. The shell
 *     reads `multiEngine?.isMultiEngine(device)` and only renders the
 *     engine-tabs strip when both that callback exists AND it returns
 *     true. Brother-QL ships single-engine devices today, so the
 *     adapter omits the field — engine tabs never render.
 *
 *  2. Mock "media loaded": connecting via the mock target queues a
 *     32-byte status frame parsing to DK-22205 (62 mm continuous).
 *     `mediaPicker.detectionCapability` returns `'auto-locked'` for
 *     the active engine (QL_810W declares `mediaDetection: true`),
 *     and `mediaPicker.detected` resolves the status payload back to
 *     the catalogue entry. The shared `<MediaPicker>` then disables
 *     every entry button + renders the "Locked to detected media"
 *     banner — verified by mounting the component directly.
 *
 *  3. Mock "no media": when the identity carries no `detectedMedia`
 *     payload, `mediaPicker.detected` returns `null`. The picker's
 *     pending banner ("No media detected — pick manually below.")
 *     surfaces for any engine in `auto-locked` mode without a
 *     resolved entry.
 *
 * No real WebUSB; no encoder writes; the encoder pair isn't
 * exercised here. The diagnostic-print path is covered by the
 * verify-cli sibling, which runs the same brother-ql-core encoder.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { findDevice } from '@thermal-label/brother-ql-core';
import MediaPicker from '@thermal-label/harness-components/media-picker';
import type { BrotherQLDevice, BrotherQLMedia } from '@thermal-label/brother-ql-core';
import type { IdentitySnapshot } from '@thermal-label/harness-core/shared';
import { adapter } from '../adapter';

function deviceForKey(key: string): BrotherQLDevice {
  const found = adapter.devices.find(d => d.key === key);
  if (!found) throw new Error(`adapter.devices missing entry for ${key}`);
  return found;
}

describe('brother-ql adapter — single-engine', () => {
  it('does not declare a multiEngine field, so the shell suppresses engine tabs', () => {
    expect(adapter.multiEngine).toBeUndefined();
  });

  it('every device in the catalogue declares exactly one engine', () => {
    for (const device of adapter.devices) {
      expect(device.engines).toHaveLength(1);
    }
  });
});

describe('brother-ql adapter — mock connect populates detected media', () => {
  it('resolves QL_810W via VID/PID lookup', () => {
    const ql810 = adapter.findDeviceByVidPid?.(0x04f9, 0x209c);
    expect(ql810?.key).toBe('QL_810W');
  });

  it('connects via mock target and stashes detectedMedia on identity.extra', async () => {
    const result = await adapter.connect({ mock: true, mockTarget: 'ql_810w' });
    expect(result.mocked).toBe(true);
    expect(result.device.key).toBe('QL_810W');
    const extra = result.identity.extra as
      | { detectedMedia?: { id?: number }; mediaLoaded?: boolean; ready?: boolean }
      | undefined;
    expect(extra?.mediaLoaded).toBe(true);
    expect(extra?.ready).toBe(true);
    // DK-22205 is id 259 in the brother-ql-core registry.
    expect(extra?.detectedMedia?.id).toBe(259);
    await result.transports.primary?.close();
  });
});

describe('brother-ql adapter — auto-locked MediaPicker mode', () => {
  it('reports detectionCapability=auto-locked for QL_810W (mediaDetection capable)', () => {
    const ql810 = deviceForKey('QL_810W');
    const engine = ql810.engines[0];
    if (!engine) throw new Error('QL_810W has no engine');
    expect(adapter.mediaPicker.detectionCapability(ql810, engine)).toBe('auto-locked');
  });

  it('detected() resolves the status-stashed media id back to a catalogue entry', () => {
    const ql810 = deviceForKey('QL_810W');
    const engine = ql810.engines[0];
    if (!engine) throw new Error('QL_810W has no engine');
    const compatible = adapter.mediaPicker.filterByDeviceEngine(adapter.media, ql810, engine);
    const identity: IdentitySnapshot = {
      advertisedName: 'QL-810W (mock)',
      vid: 0x04f9,
      pid: 0x209c,
      extra: {
        detectedMedia: {
          id: 259,
          name: '62mm continuous (DK-22205)',
          skus: ['DK-22205'],
          widthMm: 62,
          heightMm: 0,
        },
      },
    };
    const detected = adapter.mediaPicker.detected?.(identity, compatible, engine, null);
    expect(detected).toBeTruthy();
    expect(detected?.id).toBe(259);
    // The detected entry is the SAME reference as the catalogue
    // entry — the shell binds the picker by id, but matching by
    // reference also confirms we didn't accidentally synthesise a
    // detached descriptor.
    expect(compatible).toContain(detected);
  });

  it('detected() returns null when identity carries no detectedMedia hint', () => {
    const ql810 = deviceForKey('QL_810W');
    const engine = ql810.engines[0];
    if (!engine) throw new Error('QL_810W has no engine');
    const compatible = adapter.mediaPicker.filterByDeviceEngine(adapter.media, ql810, engine);
    const identity: IdentitySnapshot = {
      advertisedName: 'QL-810W (mock)',
      vid: 0x04f9,
      pid: 0x209c,
      extra: { mediaLoaded: false, ready: true },
    };
    const detected = adapter.mediaPicker.detected?.(identity, compatible, engine, null);
    expect(detected).toBeNull();
  });

  it('mounting MediaPicker with the adapter wiring locks the catalogue and shows the banner', () => {
    const ql810 = deviceForKey('QL_810W');
    const engine = ql810.engines[0];
    if (!engine) throw new Error('QL_810W has no engine');
    const compatible = adapter.mediaPicker.filterByDeviceEngine(adapter.media, ql810, engine);
    const identity: IdentitySnapshot = {
      advertisedName: 'QL-810W (mock)',
      vid: 0x04f9,
      pid: 0x209c,
      extra: { detectedMedia: { id: 259 } },
    };
    const detected = adapter.mediaPicker.detected!(identity, compatible, engine, null);
    const detectionCapability = adapter.mediaPicker.detectionCapability(ql810, engine);
    const wrapper = mount(MediaPicker<BrotherQLMedia>, {
      props: {
        modelValue: null,
        available: compatible,
        defaultMediaId: adapter.mediaPicker.defaultMediaId(ql810, engine),
        groupBy: adapter.mediaPicker.groupBy,
        ...(adapter.mediaPicker.swatch !== undefined ? { swatch: adapter.mediaPicker.swatch } : {}),
        detectionCapability,
        detected,
      },
    });
    // Locked banner copy.
    expect(wrapper.text()).toMatch(/Locked to detected media/i);
    // Every entry button is disabled.
    const entries = wrapper.findAll('button.entry');
    expect(entries.length).toBeGreaterThan(0);
    for (const btn of entries) {
      expect((btn.element as HTMLButtonElement).disabled).toBe(true);
    }
    // Auto-locked pre-selects the detected entry on mount.
    const events = wrapper.emitted('update:modelValue');
    expect(events).toBeDefined();
    expect((events?.[0]?.[0] as BrotherQLMedia).id).toBe(259);
  });

  it('mounting MediaPicker with no detected media surfaces the pending banner', () => {
    const ql810 = deviceForKey('QL_810W');
    const engine = ql810.engines[0];
    if (!engine) throw new Error('QL_810W has no engine');
    const compatible = adapter.mediaPicker.filterByDeviceEngine(adapter.media, ql810, engine);
    const wrapper = mount(MediaPicker<BrotherQLMedia>, {
      props: {
        modelValue: null,
        available: compatible,
        defaultMediaId: adapter.mediaPicker.defaultMediaId(ql810, engine),
        groupBy: adapter.mediaPicker.groupBy,
        ...(adapter.mediaPicker.swatch !== undefined ? { swatch: adapter.mediaPicker.swatch } : {}),
        detectionCapability: 'auto-locked',
        detected: null,
      },
    });
    expect(wrapper.text()).toMatch(/No media detected/i);
  });
});

describe('brother-ql adapter — registry sanity', () => {
  it('every mock target maps to a real DEVICES entry', () => {
    for (const [key, spec] of Object.entries(adapter.mockTargets)) {
      const found = findDevice(spec.vid, spec.pid);
      expect(found, `mock target ${key}`).toBeDefined();
    }
  });

  it('targets the brother-ql repo for issue submission', () => {
    expect(adapter.targetRepo).toBe('thermal-label/brother-ql');
  });
});
