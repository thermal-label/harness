---
name: unrecognized-media-panel
description: When a detection-capable driver reports media that maps to no catalogue entry, replace the silent raw passthrough (which hard-locks the picker to a non-catalogue object) with a generic "detected — unrecognized" panel — prefilled, editable dimension fields plus a free-text media identifier, both flowing into the hardware report. Stretch goal — per-protocol status-bit visualisation.
type: project
---

# @thermal-label/harness — "detected, unrecognized" media panel

> **Why this plan exists.** A detection-capable driver (brother-ql via
> its status frame, LW 5xx via the NFC SKU dump) can report `detectedMedia`
> that does **not** map to any entry in the harness media catalogue —
> an unknown DK roll, an unlisted SKU. Today `MediaSection.vue`'s
> `detected` computed handles that by `return fromStatus` — it passes the
> raw, unmatched driver object straight through. That object is truthy,
> so `detectionCapability` resolves to `auto-locked`, and `MediaPicker`
> **hard-locks** the operator to a media that isn't in the catalogue:
> nothing is selectable, `buildReport` and `print()` consume the raw
> object verbatim, and if the driver emitted a partial object the report
> records junk and the print may throw.
>
> That is a **wall** — it contradicts the project's "rails not walls"
> principle (the operator must always be able to proceed with a sensible
> choice). It is also a missed opportunity: an unrecognized roll is
> exactly the signal the harness exists to collect.
>
> **The fix.** Detection always yields *geometry* (width, length,
> continuous/die-cut); the catalogue lookup only yields a *name*.
> Printing needs the geometry, not the name. So an unmapped detection is
> never a dead end — it is "geometry known, name unknown". This plan adds
> a generic **`detected-unrecognized`** state: `MediaPicker` shows a
> "not in catalogue" panel with **dimension fields prefilled from the
> detected geometry** (editable — rails not walls) and a generic
> free-text **media identifier** field. The confirmed dimensions become
> a printable media via a small per-driver hook; the dimensions and the
> identifier ride into the `HardwareReport`, so an unknown roll becomes a
> registry contribution instead of a stuck screen.
>
> **This unblocks the LW 550 retest.** The 550 identifies media from an
> NFC SKU tag; an SKU not yet in the registry would otherwise wall the
> external retester on the media step before they ever reach a print —
> exactly the friction we want to spare them. LW 5xx is therefore
> first-class in this plan, and a mock URL (Step 5) lets the flow be
> exercised and demonstrated without a 550 on the bench.
>
> A stretch goal — per-protocol status-bit visualisation — is sketched
> at the end; it is separable and lower priority.

The agent runs **Implementation** autonomously. **Verification** is
partly interactive (the maintainer has brother-ql hardware — LW 5xx is
not on the bench).

---

## Background the agent needs

- The harness apps (`apps/harness-<driver>/`) are thin: each provides a
  `DriverAdapter` to `createHarness()`; the shared `harness-shell`
  renders the whole UI. The media UI is `harness-shell`'s
  `MediaSection.vue`, which renders the one shared `MediaPicker.vue` from
  `harness-components`. There is exactly one `MediaPicker` — every
  driver routes through it.
- `MediaDescriptor` (`contracts/src/media.ts`) is the base media shape:
  `id`, `name`, `widthMm`, `heightMm?` (undefined ⇒ continuous), `type`,
  `palette?`, `skus?` (vendor SKUs — *the natural home for the operator
  identifier*), `targetModels?`, etc. Drivers extend it — e.g.
  `BrotherQLMedia` adds `printAreaDots`, `leftMarginPins`,
  `rightMarginPins`, `tapeSystem`. **A printable media therefore needs
  driver-specific fields the harness cannot synthesise generically** —
  hence the per-driver `build` hook below.
- "rails not walls": partial / non-ideal operator input must always be
  submittable; no hard blocks beyond "≥1 unit of useful work done".
- A recent change (commit `e87a0f4`, `MediaPicker.vue`) made the
  collapsed single-line summary apply in `auto-locked` mode too. The new
  `detected-unrecognized` state renders **its own panel** — neither the
  collapsed summary nor the catalogue list.

---

## Current state (verified)

`harness/packages/harness-shell/src/sections/MediaSection.vue`
- `compatibleMedia` — lines 50-55. `adapter.mediaPicker.filterByDeviceEngine(...)`.
- `detected` — lines 65-77. Reads `activeStatus.detectedMedia`; tries an
  `id` match against `compatibleMedia`; **on a miss, `return fromStatus`
  (line 76) — the raw unmatched object.** This is the line to change.
- `detectionCapability` — lines 79-88. Returns
  `'none' | 'auto-suggest' | 'auto-locked'`; `auto-locked` whenever
  `detected.value` is truthy (line 87) — *including* the unmatched case.
- Renders `<MediaPicker … :detection-capability="detectionCapability">`
  ~line 165-172. Also passes `defaultMediaId`, `swatchFn`, `describeFn`,
  `compatibleMedia` (as `available`), and `@update:modelValue` →
  `onUpdate` (~line 119) which writes `session.activeSession.value.media`.

`harness/packages/harness-components/src/MediaPicker.vue`
- Props (lines 29-51): `modelValue`, `available`, `defaultMediaId`,
  `groupBy`, `swatch?`, `detectionCapability?`, `detected?`, `describe?`.
- `detectionMode` — line 53 (`props.detectionCapability ?? 'none'`).
- `pickInitial` — lines 115-133; the `auto-locked` branch emits
  `detected` as `modelValue`.
- `catalogueDisabled` — line 254 (`detectionMode === 'auto-locked'`).
- `showCollapsedSummary` — lines 230-232 (post-`e87a0f4`).
- Template: detection banners ~287-303; collapsed summary ~309-330;
  `<div v-show="!showCollapsedSummary" class="groups">` ~332.

`harness/packages/harness-components/src/types.ts`
- `DetectionCapability` — currently `'none' | 'auto-suggest' | 'auto-locked'`.
  Also `MediaGroupKey`, `MediaSwatch`.

`harness/packages/harness-shell/src/types.ts`
- `MediaPickerConfig<TDevice, TMedia>` — lines 180-189:
  `filterByDeviceEngine`, `groupBy`, `swatch?`, `describe?`.
- `DriverAdapter` — line 245+; carries `mediaPicker`, `media`,
  `buildDiagnosticImage`, `buildReport`.
- `EngineSession<TMedia>` — lines 208-219: `media: TMedia | null`,
  `printed`, `rung`, `notes: string`.
- `BuildReportInput` — lines 221-234.
- The file-overview comment (~lines 24-32) already names
  `customDimensions` as a deliberately-not-yet-wired concept — this plan
  wires it.

`harness/packages/harness-core/src/shared/hardware-report.ts`
- `HardwareReport` — line 175+. `schemaVersion: 1` ("Bumped on any
  field-shape change"). `device: DeviceIdentity`, `transports`,
  `engines?`, `submittedAt`, `reporter?`.

`harness/apps/harness-brother-ql/src/adapter.ts`
- `mediaPicker` config (lines 226-231): `filterByDeviceEngine`,
  `groupBy`, `swatch`, `describe`.
- `buildReport` (lines 236-273) writes
  `device.confirmed.overrides.media` / `tapeWidthMm`.

`harness/packages/harness-components/src/__tests__/MediaPicker.test.ts`
- Existing detection tests: `auto-locked` (now "collapses to a read-only
  summary…"), `auto-suggest`. A new `detected-unrecognized` test is needed.

---

## Step 0 — Prerequisite research (do first; it may change later steps)

The prefill depends on drivers emitting **geometry** on an unmapped
detection. Verify, in the driver `-core` repos:

1. `brother-ql/packages/core` — `parseStatus`. When the 32-byte status
   frame reports a width/type with no matching `MEDIA` entry, does it
   return a `MediaDescriptor` carrying real `widthMm` / `heightMm` /
   `type`, or `undefined`, or a name-only stub? The QL status frame
   *does* encode media width, length and type — confirm `parseStatus`
   surfaces them even when it can't name the roll.
2. `labelwriter/packages/core` — `skuInfoToMedia` / `parseSkuInfo`. Same
   question for an LW 5xx NFC SKU not in the registry: does the SKU dump
   geometry survive into a `MediaDescriptor`?
3. The brother-ql encoder (`encodeJobForEngine`) — which `BrotherQLMedia`
   fields it requires (`printAreaDots`, `leftMarginPins`,
   `rightMarginPins`, …) and whether those are derivable from
   `widthMm` + `type` alone. This determines what `buildCustomMedia`
   (Step 3) must compute.

**If a driver returns `undefined` on an unmapped detection**, add a
small change in that driver-core so it returns a geometry-bearing
`MediaDescriptor` instead (placeholder `id`/`name`, real dimensions).
Record findings; if they contradict this plan's assumptions, stop and
flag before continuing. Driver-core changes are committed in their own
repos, separately.

---

## Step 1 — The `detected-unrecognized` state (harness-shell)

`harness-components/src/types.ts` — extend `DetectionCapability`:
`'none' | 'auto-suggest' | 'auto-locked' | 'detected-unrecognized'`.

`MediaSection.vue`:
- Split the `detected` computed into **`matchedMedia`** (the catalogue
  entry, or `null`) and **`rawDetected`** (the unmatched
  `detectedMedia`, or `null`). Stop returning the raw object from
  `detected`.
- `detectionCapability`:
  - no `engine.capabilities.mediaDetection` → `'none'`
  - capability, no `detectedMedia` → `'auto-suggest'`
  - capability, `detectedMedia` matches catalogue → `'auto-locked'`
  - capability, `detectedMedia` present, **no match, and the adapter
    supplies `mediaPicker.customMedia`** → `'detected-unrecognized'`
  - capability, no match, **no `customMedia` hook** → `'auto-suggest'`
    (graceful degrade — never hard-lock to a non-catalogue object)
- Pass `matchedMedia` as `:detected` for `auto-locked`; pass
  `rawDetected` as `:detected` for `detected-unrecognized`. Pass the new
  `:build-custom-media` prop (Step 3).

---

## Step 2 — The unrecognized panel (MediaPicker.vue)

Add a `detected-unrecognized` branch to `MediaPicker.vue`. It renders
**neither** the collapsed summary nor the `groups` catalogue — its own
panel:

- A banner: `Printer reports {width} mm {type} — not in the harness
  catalogue. Confirm the dimensions and, if you can, name the media.`
- **Dimension fields, prefilled** from the `detected` prop's geometry
  and **editable**: `widthMm` (number), `heightMm` (number; empty ⇒
  continuous), `type` (continuous / die-cut). Prefill is the printer's
  own measurement — usually the operator just confirms; editable
  satisfies rails-not-walls and covers partial detection / misreads.
- A generic free-text **media identifier** field — label it neutrally
  (e.g. *"Media identifier (optional)"* with a hint *"a Brother DK-
  code, a Dymo SKU, or a short description"*). Free-form, optional,
  works for every driver. **Not** brother-ql-specific.
- On mount and on any field change, build the media via the
  `buildCustomMedia` prop (Step 3) and `emit('update:modelValue', …)` —
  so a valid `modelValue` exists immediately (printable with zero
  operator action) and tracks edits.

`showCollapsedSummary` / `catalogueDisabled` must not fire for this
mode — guard them. Keep the `auto-locked` / `auto-suggest` / `none`
paths exactly as they are.

---

## Step 3 — The `buildCustomMedia` driver hook

The harness cannot synthesise a *printable* driver media generically
(brother-ql needs `printAreaDots` / margins — driver knowledge). Add a
per-driver hook.

`harness-shell/src/types.ts` — extend `MediaPickerConfig`:

```ts
export interface CustomMediaInput {
  widthMm: number;
  heightMm?: number;       // undefined ⇒ continuous
  type: string;            // 'continuous' | 'die-cut'
  identifier: string;      // operator free-text; '' when blank
}

export interface MediaPickerConfig<TDevice, TMedia extends MediaDescriptor> {
  filterByDeviceEngine: (...) => readonly TMedia[];
  groupBy: (m: TMedia) => MediaGroupKey;
  swatch?: (m: TMedia) => MediaSwatch | null;
  describe?: (m: TMedia) => string;
  /**
   * Build a printable media from operator-confirmed dimensions, for the
   * `detected-unrecognized` flow. Omit if the driver cannot drive an
   * uncatalogued media; the picker then degrades to `auto-suggest`.
   */
  customMedia?: {
    build: (input: CustomMediaInput) => TMedia;
  };
}
```

- `MediaPicker.vue` gets a `buildCustomMedia?: (input: CustomMediaInput) => T`
  prop; `MediaSection.vue` wires it from `adapter.mediaPicker.customMedia?.build`.
- The driver's `build` returns a full `TMedia`: sentinel `id` (e.g.
  `'custom'`), a derived `name` (e.g. `"Custom 62 mm continuous"` or the
  identifier), real `widthMm` / `heightMm` / `type`, **`skus: [identifier]`
  when the identifier is non-empty** (so it rides into the report via the
  media object), and every driver-specific field the encoder needs
  (margins/print-area computed from width per Step 0's findings).
- Implement `customMedia.build` for **both** `apps/harness-brother-ql`
  and `apps/harness-labelwriter` — LW 5xx is in scope, not deferred (see
  the Why: the 550 retester must not be walled by an uncatalogued roll).
  brother-ql is the simpler reference — do it first, then mirror the
  shape for labelwriter using Step 0's findings on the SKU geometry path.
  Only the *hardware* verification of LW 5xx is deferred (no 550 on the
  bench); the implementation and mock-based verification are this agent's
  job.

---

## Step 4 — Carry it into the report

The synthetic media already flows into `EngineSession.media`, so
`buildReport` receives it via `primarySession.media`. Make the report
**explicitly** carry the unrecognized-media facts — this is the point of
the feature.

- In each affected adapter's `buildReport`, when the chosen media is a
  custom one (sentinel `id === 'custom'`), record the operator
  identifier and the confirmed dimensions. Prefer the existing
  per-driver `confirmed.overrides`-style channel; the identifier is in
  `media.skus[0]`.
- If a clean home does not exist in `HardwareReport`, add an **optional**
  field (e.g. `device.confirmed.customMedia?: { identifier?: string;
  widthMm: number; heightMm?: number; type: string }`). **Keep
  `schemaVersion: 1` — do not bump it.** The type comment says any
  field-shape change bumps the version, but the maintainer has ruled
  otherwise while the harness is pre-release: there are no external
  schema consumers yet, and the field is optional + additive, so
  existing reports and parsers are unaffected.
- The operator's per-engine `notes` already flow into the report — the
  identifier is structured data, *not* a substitute for notes.

---

## Step 5 — Mock targets so the path has a URL

The `detected-unrecognized` flow must be reachable without exotic
physical media — for development, for the verification below, and above
all so the **LW 550 retester can be walked through it on a known-good
URL** before touching real hardware.

Each harness app declares mock targets in its `adapter.ts` (`MOCK_TARGETS`
→ `buildMockTargets()` → `MockSpec`s) backed by `src/transport/mock.ts`;
keys + `aliases[]` become `?mock=<key>` URL values. Add:

- **`harness-labelwriter`** — a mock target (suggested key
  `lw_550_unknown_media`, alias `550-unknown`) whose `MockTransport`
  answers the 550 status read and the `ESC U` SKU dump with a SKU
  **absent from the labelwriter media registry**, so the connect lands
  straight in `detected-unrecognized`. `?mock=lw_550_unknown_media` is
  the URL the 550 retester (and the maintainer, who has no 550) uses.
- **`harness-brother-ql`** — a parallel mock target whose status frame
  reports a width/type with no `MEDIA` match.

Each must reach the panel, prefill from the mocked geometry, accept an
identifier, print a diagnostic, and produce a `HardwareReport` carrying
the custom-media data.

---

## Stretch goal — per-protocol status-bit visualisation

Separable, lower priority. Sketch only:

- Drivers' `PrinterStatus` carries `rawBytes` (the raw status frame).
  Add an **optional, data-only** decoder to `DriverAdapter`:
  `statusBits?: (status: PrinterStatus) => StatusBitGroup[]`, where a
  `StatusBitGroup` is `{ label: string; bits: { label: string; set:
  boolean; severity?: 'info' | 'warn' | 'error' }[] }`. It is a pure
  function — **no Vue in driver/adapter code**; the adapter layer
  decodes, the shell renders.
- A new generic `harness-components` component (`StatusBits.vue`)
  renders the groups — a compact grid of bit chips, error bits
  highlighted. It slots into the existing status section of the generic
  page; show it only when the active adapter supplies `statusBits`.
- Put the decoded snapshot (or at least `rawBytes` as hex) into the
  `HardwareReport` — a raw status snapshot is high-value for debugging a
  protocol from a submitted report. Same optional/additive +
  `schemaVersion` consideration as Step 4.
- Implement one driver's decoder (brother-ql — its 32-byte frame is
  well-understood) as the reference; leave others as follow-ups.

---

## Out of scope — do NOT do these

- **Do not** change the `auto-locked` / `auto-suggest` / `none` paths
  beyond what Steps 1-2 require. The collapse behaviour from `e87a0f4`
  stays.
- **Do not** let `detected-unrecognized` fall back to a hard lock. If a
  driver lacks `customMedia`, degrade to `auto-suggest` — never re-create
  the wall this plan removes.
- LW 5xx `customMedia` **and its mock target are in scope** — the 550
  retester depends on them. Only LW 5xx *hardware* verification is out of
  scope (no 550 on the bench) — an external-tester follow-up.
- **Do not** put Vue components in driver-`core` / driver-`web` packages
  — the status-bit decoder is a plain data function.
- Treat the stretch goal as genuinely optional — ship Steps 1-4 first.

---

## Verification

### Unit (no hardware)

- `MediaPicker.test.ts` — new case: `detectionCapability:
  'detected-unrecognized'` with a `detected` geometry object + a
  `buildCustomMedia` stub → asserts the panel renders, fields are
  prefilled, editing a field re-emits `update:modelValue`, the identifier
  field is present, and neither the collapsed summary nor the `.groups`
  catalogue is shown.
- `MediaSection` — a test that an unmatched `detectedMedia` +
  an adapter with `customMedia` yields `detectionCapability ===
  'detected-unrecognized'`, and without `customMedia` yields
  `'auto-suggest'` (graceful degrade).
- `harness-components` + `harness-shell` + affected app test suites green;
  `pnpm lint` on changed files.

### Mock (both drivers — no hardware)

Drive the Step 5 mock URLs in Chrome:
- `harness-labelwriter` `?mock=lw_550_unknown_media` — on connect the 550
  `detected-unrecognized` panel must appear, prefilled from the mocked
  SKU geometry; entering an identifier and running the diagnostic print
  must succeed; the `HardwareReport` must carry the custom-media block.
  This is the exact path the 550 retester will hit.
- `harness-brother-ql` equivalent mock target — same checks.

### Hardware (brother-ql — interactive with the maintainer)

If the maintainer has an uncatalogued DK roll, repeat on real hardware
through `harness-brother-ql`. LW 5xx on real hardware is the external
tester's follow-up.

---

## Follow-ups (not for this agent)

- Hardware-verify LW 5xx `customMedia` on a real 550 — external tester.
  (The wiring + mock URL ship in this plan; only the on-hardware check
  is deferred.)
- Status-bit decoders for the remaining drivers (the stretch goal ships
  one reference decoder only).
- Feed submitted identifiers back into the media registries — the whole
  point: an unrecognized roll reported once becomes a catalogue entry.
