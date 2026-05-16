<script setup lang="ts" generic="T extends MediaDescriptor">
/**
 * Driver-agnostic media picker.
 *
 * Shared across the harness apps: today's only consumer is the
 * labelmanager harness (lifted in commit 2b6f93a); future LW 5xx /
 * brother-ql / niimbot consumers wire their own `groupBy` + `swatch`
 * callbacks on top of the same component.
 *
 * The catalogue lives per-driver — the picker doesn't know what
 * `Rhino` is, what `tapeWidthMm` is, or what `material` is. The
 * consumer narrows `MediaDescriptor` with its driver-specific fields
 * and decides which entries are `priority: 'secondary'` (rendered
 * under a `Less common (N)` disclosure, collapsed by default).
 *
 * Detection capability is a prop the driver supplies. Today only
 * `'none'` is wired end-to-end (LM has no detection). `'auto-suggest'`
 * and `'auto-locked'` are scaffolded so future drivers (LW 5xx NFC,
 * brother-ql media-detect) can plug straight in.
 *
 * Default selection fires once on mount (and once when the
 * compatible-set / detected hint changes), never on every prop
 * change — that would clobber the operator's choice.
 */
import { computed, ref, watch } from 'vue';
import type { MediaDescriptor } from '@thermal-label/contracts';
import type { DetectionCapability, MediaGroupKey, MediaSwatch } from './types';

/**
 * Operator-confirmed dimensions handed to `buildCustomMedia` for the
 * `detected-unrecognized` flow. Structurally identical to
 * `CustomMediaInput` in `harness-shell` — duplicated here so
 * `harness-components` carries no dependency on `harness-shell`.
 */
export interface CustomMediaInput {
  widthMm: number;
  heightMm?: number;
  type: 'continuous' | 'die-cut';
  identifier: string;
}

const props = defineProps<{
  /** v-model — currently selected media (or null when nothing picked). */
  modelValue: T | null;
  /** Compatible-with-this-device set — the picker iterates this. */
  available: readonly T[];
  /** Pre-select this id on mount when `modelValue` is null. */
  defaultMediaId: string | number;
  /** Per-item group descriptor. Drives section heading + secondary disclosure. */
  groupBy: (m: T) => MediaGroupKey;
  /** Optional colour-swatch extractor. Returns `null` to suppress the swatch. */
  swatch?: (m: T) => MediaSwatch | null;
  /**
   * Detection capability. Treated as `'none'` when omitted — the
   * picker reads the prop directly with a `?? 'none'` fallback so
   * `withDefaults` isn't needed (which fights `exactOptionalPropertyTypes`
   * and the generic `T` parameter under vue-tsc).
   */
  detectionCapability?: DetectionCapability;
  /** Detected media — meaningful only when `detectionCapability !== 'none'`. */
  detected?: T | null;
  /** One-line label override; defaults to `m.name`. */
  describe?: (m: T) => string;
  /**
   * Builds a printable media from operator-confirmed dimensions, for
   * the `detected-unrecognized` panel. Supplied by the driver when it
   * can drive an uncatalogued media. When omitted the shell never
   * routes the picker into `detected-unrecognized` mode (it degrades
   * to `auto-suggest`), so this branch only renders when the prop is
   * present.
   */
  buildCustomMedia?: ((input: CustomMediaInput) => T) | null;
}>();

const detectionMode = computed<DetectionCapability>(() => props.detectionCapability ?? 'none');

const emit = defineEmits<{
  'update:modelValue': [media: T | null];
}>();

// ─── detected-unrecognized panel ─────────────────────────────────

/**
 * `detected-unrecognized`: the driver detected media that maps to no
 * catalogue entry — geometry known, name unknown. The picker renders
 * its own panel (neither the collapsed summary nor the catalogue):
 * editable dimension fields prefilled from the detected geometry plus
 * a free-text identifier. The confirmed values flow through
 * `buildCustomMedia` into `modelValue` so a printable media exists
 * with zero operator action and tracks every edit.
 */
const isUnrecognized = computed<boolean>(
  () => detectionMode.value === 'detected-unrecognized' && props.buildCustomMedia != null,
);

/** Editable field state for the unrecognized panel. */
const customWidthMm = ref<number | null>(null);
const customHeightMm = ref<number | null>(null);
const customType = ref<'continuous' | 'die-cut'>('continuous');
const customIdentifier = ref<string>('');

/** Seed the panel fields from the detected geometry. */
function seedCustomFields(): void {
  const d = props.detected;
  if (!d) return;
  customWidthMm.value = typeof d.widthMm === 'number' ? d.widthMm : null;
  const h = d.heightMm;
  customHeightMm.value = typeof h === 'number' && h > 0 ? h : null;
  // A height ⇒ die-cut; no height ⇒ continuous. Honour an explicit
  // `type` on the detected object when present.
  const t = (d as { type?: unknown }).type;
  if (t === 'die-cut' || t === 'continuous') {
    customType.value = t;
  } else {
    customType.value = customHeightMm.value != null ? 'die-cut' : 'continuous';
  }
  customIdentifier.value = '';
}

/**
 * Build the synthetic media from the current field state and emit it
 * as `modelValue`. A blank / non-positive width is the only case that
 * cannot produce a printable media — there we emit `null` (rails not
 * walls: the operator can still type a width to proceed).
 */
function emitCustomMedia(): void {
  const build = props.buildCustomMedia;
  if (!build) return;
  const width = customWidthMm.value;
  if (typeof width !== 'number' || !(width > 0)) {
    emit('update:modelValue', null);
    return;
  }
  const height = customHeightMm.value;
  const input: CustomMediaInput = {
    widthMm: width,
    type: customType.value,
    identifier: customIdentifier.value.trim(),
    ...(customType.value === 'die-cut' && typeof height === 'number' && height > 0
      ? { heightMm: height }
      : {}),
  };
  emit('update:modelValue', build(input));
}

// Re-seed whenever the detected geometry changes (e.g. the operator
// swaps the loaded roll), then emit so a valid modelValue exists
// immediately — printable with zero operator action.
watch(
  () => [isUnrecognized.value, props.detected] as const,
  () => {
    if (!isUnrecognized.value) return;
    seedCustomFields();
    emitCustomMedia();
  },
  { immediate: true },
);

// ─── Group composition ───────────────────────────────────────────

interface ResolvedGroup {
  key: string;
  label: string;
  priority: 'primary' | 'secondary';
  sort: number;
  entries: T[];
}

const groups = computed<readonly ResolvedGroup[]>(() => {
  const byKey = new Map<string, ResolvedGroup>();
  let insertion = 0;
  for (const m of props.available) {
    const g = props.groupBy(m);
    const existing = byKey.get(g.key);
    if (existing) {
      existing.entries.push(m);
    } else {
      byKey.set(g.key, {
        key: g.key,
        label: g.label,
        priority: g.priority,
        sort: g.sort ?? insertion++,
        entries: [m],
      });
    }
  }
  const all = Array.from(byKey.values());
  // Stable sort within each priority bucket by `sort`.
  all.sort((a, b) => a.sort - b.sort);
  return all;
});

const primaryGroups = computed(() => groups.value.filter(g => g.priority === 'primary'));
const secondaryGroups = computed(() => groups.value.filter(g => g.priority === 'secondary'));
const secondaryCount = computed(() =>
  secondaryGroups.value.reduce((sum, g) => sum + g.entries.length, 0),
);

// ─── Default selection on mount + on compatible-set change ───────

/**
 * Pre-select the default on mount and whenever the available set or
 * `detected` hint changes.
 *
 * Selection rules:
 *  - `auto-locked`: the printer's truth ALWAYS wins. Re-emit on
 *    every `detected` change (including after the operator
 *    "selected" something — they couldn't really, the catalogue is
 *    disabled). Updates flow live as the polled status changes:
 *    swap a DK roll, picker reflects within one poll cycle.
 *  - `auto-suggest` / `none`: only auto-select when `modelValue`
 *    is null. Once the operator picks, leave their choice alone.
 *  - `detected` non-null: prefer it over `defaultMediaId`.
 */
function pickInitial(): void {
  // detected-unrecognized: the unrecognized panel owns `modelValue`
  // (it emits the synthetic custom media). Never run the catalogue
  // auto-select here — it would clobber the panel's media.
  if (isUnrecognized.value) return;
  if (props.available.length === 0) return;
  // auto-locked: detected ALWAYS wins. Re-emit if detected differs
  // from the current modelValue.
  if (detectionMode.value === 'auto-locked' && props.detected) {
    if (props.modelValue?.id !== props.detected.id) {
      emit('update:modelValue', props.detected);
    }
    return;
  }
  // none / auto-suggest: don't clobber an existing operator pick.
  if (props.modelValue !== null) return;
  if (detectionMode.value !== 'none' && props.detected) {
    emit('update:modelValue', props.detected);
    return;
  }
  const byId = props.available.find(m => m.id === props.defaultMediaId);
  emit('update:modelValue', byId ?? props.available[0] ?? null);
}

watch(
  () => [props.available, props.detected, props.defaultMediaId] as const,
  () => {
    pickInitial();
  },
  { immediate: true },
);

// ─── Per-group expand state ──────────────────────────────────────

/**
 * Primary groups: every group starts expanded if it contains the
 * currently-selected entry; otherwise collapsed. Operators usually
 * stay within a single group (a 12mm chassis + 12mm tape), so this
 * keeps the list compact without hiding the active selection.
 *
 * Secondary groups: the disclosure starts closed; we auto-open it if
 * the selected entry lives inside it (so the picker doesn't appear
 * to forget what was picked).
 */
const expandedPrimary = ref<Set<string>>(new Set());
const secondaryOpen = ref<boolean>(false);

function recomputeExpanded(): void {
  const sel = props.modelValue;
  const next = new Set<string>();
  let openSecondary = false;
  for (const g of groups.value) {
    const hasSelected = sel !== null && g.entries.some(e => e.id === sel.id);
    if (g.priority === 'primary') {
      if (hasSelected) next.add(g.key);
    } else if (hasSelected) {
      openSecondary = true;
    }
  }
  // Default: if no primary group expanded and no selection inside
  // one, expand the first primary group so the picker isn't
  // entirely collapsed on first paint.
  if (next.size === 0 && primaryGroups.value.length > 0 && primaryGroups.value[0]) {
    next.add(primaryGroups.value[0].key);
  }
  expandedPrimary.value = next;
  if (openSecondary) secondaryOpen.value = true;
}

watch(
  () => [props.available, props.modelValue] as const,
  () => recomputeExpanded(),
  { immediate: true },
);

function togglePrimary(key: string): void {
  const next = new Set(expandedPrimary.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedPrimary.value = next;
}

function pick(m: T): void {
  if (detectionMode.value === 'auto-locked') {
    // Locked mode: the operator can't override. Catalogue renders
    // disabled but readable; clicks are a no-op.
    return;
  }
  emit('update:modelValue', m);
  // Make sure the group containing the pick is expanded — relevant
  // if the user re-expands the catalogue later.
  const g = props.groupBy(m);
  if (g.priority === 'primary') {
    const next = new Set(expandedPrimary.value);
    next.add(g.key);
    expandedPrimary.value = next;
  } else {
    secondaryOpen.value = true;
  }
  // Collapse the catalogue down to the compact summary so the next
  // section is one short scroll away. The user can re-expand via the
  // summary's "Change" affordance.
  catalogueExpanded.value = false;
}

// ─── Collapsed-when-selected state ───────────────────────────────

/**
 * The catalogue starts collapsed when there's already a selection
 * (the default-on-mount path always lands here). The summary shows
 * the swatch + name; in the pickable modes a "Change" affordance
 * expands the full catalogue, and after the user picks we auto-collapse
 * back so the rest of the page is a short scroll.
 *
 * `auto-locked` mode collapses too — the operator can't change the
 * pick, so the summary renders read-only (no "Change" affordance, not
 * clickable) and the catalogue stays hidden.
 */
const catalogueExpanded = ref<boolean>(false);

const showCollapsedSummary = computed<boolean>(
  () => !isUnrecognized.value && props.modelValue !== null && !catalogueExpanded.value,
);

function expandCatalogue(): void {
  catalogueExpanded.value = true;
}

// ─── Display helpers ─────────────────────────────────────────────

function describeMedia(m: T | null | undefined): string {
  if (!m) return '';
  if (props.describe) return props.describe(m);
  return m.name;
}

const isSelected = (m: T): boolean => props.modelValue !== null && props.modelValue.id === m.id;

/**
 * `auto-locked`: catalogue is rendered but every entry is disabled.
 * The pill at the top shows the detected media; the operator's role
 * is read-only.
 */
const catalogueDisabled = computed(() => detectionMode.value === 'auto-locked');

const NAMED_COLOUR_FALLBACK: Record<string, string> = {
  clear: '#e7e7e7',
  silver: '#c0c0c0',
  gold: '#d4af37',
  'fluorescent-green': '#39ff14',
  'fluorescent-red': '#ff355e',
};

function cssColour(name: string | undefined): string {
  if (!name) return 'transparent';
  if (NAMED_COLOUR_FALLBACK[name]) return NAMED_COLOUR_FALLBACK[name];
  return name;
}

function swatchFor(m: T): MediaSwatch | null {
  return props.swatch ? props.swatch(m) : null;
}

function swatchTitle(m: T): string {
  const s = swatchFor(m);
  if (!s) return '';
  const fg = s.fg ?? '?';
  const bg = s.bg ?? '?';
  return `${fg} on ${bg}`;
}
</script>

<template>
  <div class="media-picker" :data-detection="detectionMode">
    <!-- Detection-capability banner. Driver supplies `detected`; the
         picker doesn't probe anything itself. -->
    <p
      v-if="detectionMode === 'auto-suggest' && detected"
      class="detection-banner detection-suggest"
    >
      Detected: <strong>{{ describeMedia(detected) }}</strong> — confirm or pick a different entry
      below.
    </p>
    <p
      v-else-if="detectionMode === 'auto-locked' && detected"
      class="detection-banner detection-locked"
    >
      Locked to detected media: <strong>{{ describeMedia(detected) }}</strong
      >. The printer refuses to print on anything else.
    </p>
    <p
      v-else-if="detectionMode !== 'none' && !detected && !isUnrecognized"
      class="detection-banner detection-pending"
    >
      No media detected — pick manually below.
    </p>

    <!-- detected-unrecognized panel: the printer detected media that
         maps to no catalogue entry. Geometry is known (prefilled,
         editable); the name is not. Renders instead of the collapsed
         summary AND the catalogue list. -->
    <div v-if="isUnrecognized" class="unrecognized-panel">
      <p class="detection-banner detection-unrecognized">
        Printer reports
        <strong
          >{{ customWidthMm ?? '?' }} mm
          {{ customType === 'die-cut' ? 'die-cut' : 'continuous' }}</strong
        >
        — not in the harness catalogue. Confirm the dimensions and, if you can, name the media.
      </p>

      <div class="unrecognized-fields">
        <label class="field">
          <span class="field-label">Width (mm)</span>
          <input
            v-model.number="customWidthMm"
            type="number"
            min="0"
            step="0.1"
            class="field-input"
            @input="emitCustomMedia"
          />
        </label>

        <label class="field">
          <span class="field-label">Media type</span>
          <select v-model="customType" class="field-input" @change="emitCustomMedia">
            <option value="continuous">Continuous</option>
            <option value="die-cut">Die-cut</option>
          </select>
        </label>

        <label class="field" :class="{ disabled: customType !== 'die-cut' }">
          <span class="field-label">Length (mm)</span>
          <input
            v-model.number="customHeightMm"
            type="number"
            min="0"
            step="0.1"
            class="field-input"
            :disabled="customType !== 'die-cut'"
            placeholder="continuous"
            @input="emitCustomMedia"
          />
        </label>
      </div>

      <label class="field field-identifier">
        <span class="field-label">Media identifier (optional)</span>
        <input
          v-model="customIdentifier"
          type="text"
          class="field-input"
          placeholder="e.g. DK-22205, 30252, or a short description"
          @input="emitCustomMedia"
        />
        <span class="field-hint">a Brother DK-code, a Dymo SKU, or a short description</span>
      </label>
    </div>

    <!-- Collapsed summary: shown when something is selected and the
         catalogue isn't explicitly expanded. Single-row chip with
         swatch + name + "Change" affordance, keeping the next
         section close. -->
    <button
      v-if="showCollapsedSummary && modelValue"
      type="button"
      class="selected-summary"
      :disabled="catalogueDisabled"
      @click="expandCatalogue"
    >
      <span
        v-if="swatchFor(modelValue)"
        class="swatch"
        :title="swatchTitle(modelValue)"
        :style="{
          background: cssColour(swatchFor(modelValue)?.bg),
          color: cssColour(swatchFor(modelValue)?.fg),
          borderColor:
            cssColour(swatchFor(modelValue)?.bg) === 'transparent' ? '#888' : 'transparent',
        }"
        >Aa</span
      >
      <span class="summary-name">{{ describeMedia(modelValue) }}</span>
      <code class="summary-id">{{ modelValue.id }}</code>
      <span v-if="!catalogueDisabled" class="summary-change">Change ▾</span>
    </button>

    <div v-show="!showCollapsedSummary && !isUnrecognized" class="groups">
      <section
        v-for="g in primaryGroups"
        :key="g.key"
        class="group"
        :class="{ disabled: catalogueDisabled }"
      >
        <button
          type="button"
          class="group-header"
          :aria-expanded="expandedPrimary.has(g.key)"
          @click="togglePrimary(g.key)"
        >
          <span class="group-title">{{ g.label }}</span>
          <span class="group-hint"
            >{{ g.entries.length }} item{{ g.entries.length === 1 ? '' : 's' }}</span
          >
          <span class="group-caret">{{ expandedPrimary.has(g.key) ? '−' : '+' }}</span>
        </button>

        <ul v-if="expandedPrimary.has(g.key)" class="entries">
          <li v-for="m in g.entries" :key="String(m.id)">
            <button
              type="button"
              class="entry"
              :class="{ selected: isSelected(m), disabled: catalogueDisabled }"
              :disabled="catalogueDisabled"
              :aria-disabled="catalogueDisabled || undefined"
              @click="pick(m)"
            >
              <span
                v-if="swatchFor(m)"
                class="swatch"
                :title="swatchTitle(m)"
                :style="{
                  background: cssColour(swatchFor(m)?.bg),
                  color: cssColour(swatchFor(m)?.fg),
                  borderColor:
                    cssColour(swatchFor(m)?.bg) === 'transparent' ? '#888' : 'transparent',
                }"
                >Aa</span
              >
              <span class="entry-name">{{ describeMedia(m) }}</span>
              <code class="entry-id">{{ m.id }}</code>
            </button>
          </li>
        </ul>
      </section>

      <details
        v-if="secondaryGroups.length > 0"
        class="secondary"
        :class="{ disabled: catalogueDisabled }"
        :open="secondaryOpen"
        @toggle="secondaryOpen = ($event.target as HTMLDetailsElement).open"
      >
        <summary class="secondary-summary">
          <span class="secondary-title">Less common</span>
          <span class="secondary-hint">({{ secondaryCount }})</span>
        </summary>
        <div class="secondary-body">
          <section v-for="g in secondaryGroups" :key="g.key" class="group secondary-group">
            <header class="secondary-group-header">{{ g.label }}</header>
            <ul class="entries">
              <li v-for="m in g.entries" :key="String(m.id)">
                <button
                  type="button"
                  class="entry"
                  :class="{ selected: isSelected(m), disabled: catalogueDisabled }"
                  :disabled="catalogueDisabled"
                  :aria-disabled="catalogueDisabled || undefined"
                  @click="pick(m)"
                >
                  <span
                    v-if="swatchFor(m)"
                    class="swatch"
                    :title="swatchTitle(m)"
                    :style="{
                      background: cssColour(swatchFor(m)?.bg),
                      color: cssColour(swatchFor(m)?.fg),
                      borderColor:
                        cssColour(swatchFor(m)?.bg) === 'transparent' ? '#888' : 'transparent',
                    }"
                    >Aa</span
                  >
                  <span class="entry-name">{{ describeMedia(m) }}</span>
                  <code class="entry-id">{{ m.id }}</code>
                </button>
              </li>
            </ul>
          </section>
        </div>
      </details>
    </div>
  </div>
</template>

<style scoped>
.media-picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.detection-banner {
  font-size: 0.92rem;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
}

.detection-suggest {
  background: var(--bg);
}

.detection-locked {
  background: var(--warn-bg, var(--bg));
  color: var(--warn, inherit);
  border-color: var(--warn, var(--border));
}

.detection-pending {
  color: var(--fg-muted, var(--muted));
}

.detection-unrecognized {
  background: var(--bg);
}

.unrecognized-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.unrecognized-fields {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  flex: 1 1 8rem;
  min-width: 7rem;
}

.field.disabled {
  opacity: 0.55;
}

.field-identifier {
  flex: 1 1 100%;
}

.field-label {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--fg-muted, var(--muted));
}

.field-input {
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  font: inherit;
}

.field-input:focus {
  border-color: var(--accent);
  outline: none;
}

.field-hint {
  font-size: 0.76rem;
  color: var(--fg-muted, var(--muted));
}

.selected-summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition:
    border-color 100ms,
    background-color 100ms;
}

.selected-summary:hover:not(:disabled) {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}

.selected-summary:disabled {
  cursor: default;
}

.summary-name {
  flex: 1;
  font-weight: 500;
}

.summary-id {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  opacity: 0.75;
}

.summary-change {
  font-size: 0.78rem;
  color: var(--fg-muted, var(--muted));
  white-space: nowrap;
}

.groups {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
}

.group {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
}

.group.disabled {
  opacity: 0.55;
}

.group-header {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  width: 100%;
  background: transparent;
  color: inherit;
  border: none;
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  text-align: left;
  font: inherit;
}

.group-header:hover {
  background: var(--bg-hover);
}

.group-title {
  font-weight: 600;
  font-size: 1rem;
}

.group-hint {
  flex: 1;
  font-size: 0.78rem;
  color: var(--fg-muted, var(--muted));
}

.group-caret {
  font-family: var(--font-mono);
  font-size: 1rem;
  width: 1em;
  text-align: center;
}

.entries {
  list-style: none;
  padding: 0 var(--space-2) var(--space-2);
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.entry {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition:
    border-color 100ms,
    background-color 100ms;
}

.entry:hover:not(.disabled) {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}

.entry.selected {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-fg);
}

.entry.disabled {
  cursor: not-allowed;
}

.swatch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.6rem;
  height: 1.6rem;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  font-size: 0.7rem;
  font-weight: 700;
  flex: 0 0 auto;
}

.entry-name {
  flex: 1;
}

.entry-id {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  opacity: 0.75;
}

.entry.selected .entry-id {
  opacity: 0.9;
}

.secondary {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
}

.secondary.disabled {
  opacity: 0.55;
}

.secondary-summary {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  font: inherit;
  list-style: none;
}

.secondary-summary::-webkit-details-marker {
  display: none;
}

.secondary-title {
  font-weight: 600;
}

.secondary-hint {
  font-size: 0.78rem;
  color: var(--fg-muted, var(--muted));
}

.secondary-body {
  padding: 0 var(--space-2) var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.secondary-group {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.secondary-group-header {
  font-weight: 600;
  font-size: 0.92rem;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
}
</style>
