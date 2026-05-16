/**
 * Smoke tests for the shared `<MediaPicker>` component.
 *
 * The picker is generic over `T extends MediaDescriptor`; these
 * tests use a tiny synthetic catalogue (no driver imports) to keep
 * the assertions independent of any real media schema.
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { MediaDescriptor } from '@thermal-label/contracts';
import MediaPicker from '../MediaPicker.vue';
import type { MediaGroupKey } from '../types';

interface FakeMedia extends MediaDescriptor {
  group: 'standard' | 'rhino';
  width: number;
}

const STANDARD_12: FakeMedia = {
  id: 'std-12',
  name: '12mm Standard',
  widthMm: 12,
  type: 'tape',
  group: 'standard',
  width: 12,
};

const STANDARD_9: FakeMedia = {
  id: 'std-9',
  name: '9mm Standard',
  widthMm: 9,
  type: 'tape',
  group: 'standard',
  width: 9,
};

const RHINO_12: FakeMedia = {
  id: 'rhino-12',
  name: '12mm Rhino Vinyl',
  widthMm: 12,
  type: 'tape',
  group: 'rhino',
  width: 12,
};

function groupBy(m: FakeMedia): MediaGroupKey {
  if (m.group === 'rhino') {
    return {
      key: `rhino-${String(m.width)}`,
      label: `Rhino ${String(m.width)}mm`,
      priority: 'secondary',
      sort: m.width,
    };
  }
  return {
    key: `${String(m.width)}mm`,
    label: `${String(m.width)} mm`,
    priority: 'primary',
    sort: m.width,
  };
}

describe('MediaPicker', () => {
  it('emits update:modelValue on mount when modelValue is null', () => {
    const wrapper = mount(MediaPicker<FakeMedia>, {
      props: {
        modelValue: null,
        available: [STANDARD_9, STANDARD_12],
        defaultMediaId: 'std-12',
        groupBy,
      },
    });
    const events = wrapper.emitted('update:modelValue');
    expect(events).toBeDefined();
    expect(events?.[0]?.[0]).toEqual(STANDARD_12);
  });

  it('falls back to first available when defaultMediaId is missing', () => {
    const wrapper = mount(MediaPicker<FakeMedia>, {
      props: {
        modelValue: null,
        available: [STANDARD_9, STANDARD_12],
        defaultMediaId: 'does-not-exist',
        groupBy,
      },
    });
    const events = wrapper.emitted('update:modelValue');
    expect(events?.[0]?.[0]).toEqual(STANDARD_9);
  });

  it('does not re-emit on subsequent renders when modelValue is set', async () => {
    const wrapper = mount(MediaPicker<FakeMedia>, {
      props: {
        modelValue: STANDARD_12,
        available: [STANDARD_9, STANDARD_12],
        defaultMediaId: 'std-12',
        groupBy,
      },
    });
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    // Mutate prop reference to trigger watcher; selection must hold.
    await wrapper.setProps({ available: [STANDARD_9, STANDARD_12] });
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('renders Rhino entries inside the secondary <details> disclosure', () => {
    const wrapper = mount(MediaPicker<FakeMedia>, {
      props: {
        modelValue: STANDARD_12,
        available: [STANDARD_12, RHINO_12],
        defaultMediaId: 'std-12',
        groupBy,
      },
    });
    const details = wrapper.find('details.secondary');
    expect(details.exists()).toBe(true);
    // Rhino entry id is inside the disclosure, not at the top level.
    expect(details.html()).toContain('rhino-12');
    // The disclosure starts closed when the selection is in a primary group.
    expect((details.element as HTMLDetailsElement).open).toBe(false);
    // The "Less common (1)" hint reflects the secondary count.
    expect(wrapper.text()).toContain('Less common');
    expect(wrapper.text()).toContain('(1)');
  });

  it('opens the secondary disclosure when the selected entry lives inside it', async () => {
    const wrapper = mount(MediaPicker<FakeMedia>, {
      props: {
        modelValue: RHINO_12,
        available: [STANDARD_12, RHINO_12],
        defaultMediaId: 'std-12',
        groupBy,
      },
    });
    await nextTick();
    const details = wrapper.find('details.secondary');
    expect(details.exists()).toBe(true);
    // Vue's `:open` binding should reflect the true value.
    expect(details.attributes('open')).toBeDefined();
  });

  it('collapses to a read-only summary when detectionCapability is auto-locked', () => {
    const wrapper = mount(MediaPicker<FakeMedia>, {
      props: {
        modelValue: STANDARD_12,
        available: [STANDARD_9, STANDARD_12],
        defaultMediaId: 'std-12',
        groupBy,
        detectionCapability: 'auto-locked',
        detected: STANDARD_12,
      },
    });
    // Locked mode collapses to the compact summary, same as the
    // pickable modes — but read-only.
    const summary = wrapper.find('button.selected-summary');
    expect(summary.exists()).toBe(true);
    expect(summary.text()).toContain('12mm Standard');
    // No "Change" affordance and the summary itself is not clickable.
    expect(summary.text()).not.toContain('Change');
    expect((summary.element as HTMLButtonElement).disabled).toBe(true);
    // The full catalogue stays hidden (v-show collapses it).
    expect((wrapper.find('.groups').element as HTMLElement).style.display).toBe('none');
    // Banner copy still names the locked detection.
    expect(wrapper.text()).toMatch(/Locked to detected media/i);
  });

  it('shows the auto-suggest banner when detectionCapability is auto-suggest', () => {
    const wrapper = mount(MediaPicker<FakeMedia>, {
      props: {
        modelValue: STANDARD_12,
        available: [STANDARD_9, STANDARD_12],
        defaultMediaId: 'std-9',
        groupBy,
        detectionCapability: 'auto-suggest',
        detected: STANDARD_12,
      },
    });
    expect(wrapper.text()).toMatch(/Detected:/i);
    // Buttons remain enabled in auto-suggest mode.
    const enabled = wrapper
      .findAll('button.entry')
      .every(b => !(b.element as HTMLButtonElement).disabled);
    expect(enabled).toBe(true);
  });

  describe('detected-unrecognized', () => {
    // Geometry the driver detected for a roll that maps to no
    // catalogue entry — 41 mm continuous.
    const UNKNOWN_GEOMETRY: FakeMedia = {
      id: 'sku-99999',
      name: 'Unknown SKU',
      widthMm: 41,
      type: 'continuous',
      group: 'standard',
      width: 41,
    };

    function buildCustomMedia(input: {
      widthMm: number;
      heightMm?: number;
      type: 'continuous' | 'die-cut';
      identifier: string;
    }): FakeMedia {
      return {
        id: 'custom',
        name: input.identifier || `Custom ${String(input.widthMm)} mm`,
        widthMm: input.widthMm,
        type: input.type === 'die-cut' ? 'tape' : 'tape',
        group: 'standard',
        width: input.widthMm,
        ...(input.heightMm !== undefined ? { heightMm: input.heightMm } : {}),
        ...(input.identifier ? { skus: [input.identifier] } : {}),
      };
    }

    // Props for a picker driven into the unrecognized state. Inlined
    // into `mount(...)` per test so the wrapper keeps its concrete
    // generic type (a shared helper would widen it).
    const unrecognizedProps = {
      modelValue: null,
      available: [STANDARD_9, STANDARD_12],
      defaultMediaId: 'std-12',
      groupBy,
      detectionCapability: 'detected-unrecognized' as const,
      detected: UNKNOWN_GEOMETRY,
      buildCustomMedia,
    };

    it('renders its own panel — neither the collapsed summary nor the catalogue', () => {
      const wrapper = mount(MediaPicker<FakeMedia>, { props: unrecognizedProps });
      expect(wrapper.find('.unrecognized-panel').exists()).toBe(true);
      // No collapsed single-line summary.
      expect(wrapper.find('button.selected-summary').exists()).toBe(false);
      // The catalogue groups are hidden (v-show collapses them).
      expect((wrapper.find('.groups').element as HTMLElement).style.display).toBe('none');
      // Banner names the detected geometry.
      expect(wrapper.text()).toMatch(/not in the harness catalogue/i);
      expect(wrapper.text()).toContain('41 mm');
    });

    it('prefills the dimension fields from the detected geometry', () => {
      const wrapper = mount(MediaPicker<FakeMedia>, { props: unrecognizedProps });
      const width = wrapper.find('input[type="number"]').element as HTMLInputElement;
      expect(width.value).toBe('41');
      const type = wrapper.find('select').element as HTMLSelectElement;
      expect(type.value).toBe('continuous');
    });

    it('has a free-text media identifier field', () => {
      const wrapper = mount(MediaPicker<FakeMedia>, { props: unrecognizedProps });
      const identifier = wrapper.find('input[type="text"]');
      expect(identifier.exists()).toBe(true);
    });

    it('emits a built media on mount so a printable modelValue exists immediately', () => {
      const wrapper = mount(MediaPicker<FakeMedia>, { props: unrecognizedProps });
      const events = wrapper.emitted('update:modelValue');
      expect(events).toBeDefined();
      const emitted = events?.[events.length - 1]?.[0] as FakeMedia | null;
      expect(emitted).not.toBeNull();
      expect(emitted?.id).toBe('custom');
      expect(emitted?.widthMm).toBe(41);
    });

    it('re-emits update:modelValue when a dimension field is edited', async () => {
      const wrapper = mount(MediaPicker<FakeMedia>, { props: unrecognizedProps });
      const before = wrapper.emitted('update:modelValue')?.length ?? 0;
      const width = wrapper.find('input[type="number"]');
      await width.setValue('57');
      const events = wrapper.emitted('update:modelValue');
      expect(events?.length ?? 0).toBeGreaterThan(before);
      const latest = events?.[events.length - 1]?.[0] as FakeMedia | null;
      expect(latest?.widthMm).toBe(57);
    });

    it('carries the identifier into the built media skus when named', async () => {
      const wrapper = mount(MediaPicker<FakeMedia>, { props: unrecognizedProps });
      const identifier = wrapper.find('input[type="text"]');
      await identifier.setValue('30999');
      const events = wrapper.emitted('update:modelValue');
      const latest = events?.[events.length - 1]?.[0] as FakeMedia | null;
      expect(latest?.skus).toEqual(['30999']);
    });
  });

  it('emits the picked entry on click in primary groups', async () => {
    const wrapper = mount(MediaPicker<FakeMedia>, {
      props: {
        modelValue: STANDARD_12,
        available: [STANDARD_9, STANDARD_12],
        defaultMediaId: 'std-12',
        groupBy,
      },
    });
    // The 9mm group starts collapsed; expand it first.
    const headers = wrapper.findAll('button.group-header');
    const ninemm = headers.find(h => h.text().includes('9 mm'));
    expect(ninemm).toBeDefined();
    await ninemm!.trigger('click');
    const entry = wrapper.findAll('button.entry').find(b => b.text().includes('9mm Standard'));
    expect(entry).toBeDefined();
    await entry!.trigger('click');
    const events = wrapper.emitted('update:modelValue');
    expect(events?.[events.length - 1]?.[0]).toEqual(STANDARD_9);
  });
});
