---
name: diagnostics-json-copy
description: Add a "copy diagnostics as JSON" control with an inline preview to the harness submit block, available as soon as a device is connected — before the print/verdict gate. For triaging existing GitHub tickets — the reporter connects, copies a comment-ready JSON snapshot (identity, transport, live status, detected media, versions), and pastes it into a reply.
type: project
---

# @thermal-label/harness — copy diagnostics as JSON

> **Why this plan exists.** The harness submit flow has exactly one
> output: a print-verified `HardwareReport` → a prefilled *new* GitHub
> issue. `SubmitSection.vue` is gated on `session.canSubmit` — until the
> operator has printed and picked a verdict it shows only *"Pick a
> verdict in the section above first."*
>
> That leaves a gap for **triage on existing tickets**. When a reporter
> already has an open issue and the maintainer needs "what does your
> device/connection actually look like?", there is no way to get a
> structured diagnostic out of the harness without running a full print
> and opening a *second* issue. The reporter should be able to connect,
> grab a JSON snapshot, and **paste it into a reply on the existing
> ticket** — no print, no new issue.
>
> **The fix.** Add a "Copy diagnostics (JSON)" control with an inline
> preview to the submit block, available the moment a device is
> connected — ungated by the verdict. It emits a small, always-available
> `DiagnosticsSnapshot` (identity, transport, live status incl. raw
> bytes, detected media, versions, mock flag), copied as a GitHub-comment
> -ready fenced ```json block.

Small, self-contained, single-repo (`harness`). One new shared type +
builder, one UI block in `SubmitSection.vue`.

---

## Current state (verified)

`harness/packages/harness-shell/src/sections/SubmitSection.vue`
- `SectionCard :step="5"`, body branches on `sectionState`
  (`pending | active | done`). `pending` is everything before
  `session.canSubmit` — currently renders only a one-line "pick a
  verdict" message (template lines ~190-192). **The diagnostics block
  goes here — visible in `pending`, i.e. from connect onward.**
- Already imports `copyToClipboard` from `../submit/submit` and uses the
  `copyState: 'idle' | 'copied'` pattern (lines 53, 132-143) — reuse both.

`harness/packages/harness-shell/src/submit/submit.ts`
- `copyToClipboard(text)` — lines 86-91, `navigator.clipboard.writeText`.
  Reuse as-is.

`harness/packages/harness-shell/src/state/session.ts`
- Connected-state available **without a print**: `connection.identity`
  (`IdentitySnapshot | null`), `device`, `isConnected`, `connection.mocked`,
  `activeStatus` (`PrinterStatus | null`), and per-engine `printerStatus`.

`harness-shell` `adapter` context — `driverKey`, `harnessVersion`,
`driverVersion`.

`harness/packages/harness-core/src/shared/` — `hardware-report.ts`
(`HardwareReport`, `IdentitySnapshot`), `issue-body.ts`, `index.ts`.
`PrinterStatus` (from contracts) carries `rawBytes: Uint8Array`.

Everything the snapshot needs exists at connect time — no print, no
adapter `buildReport`, no `canSubmit`.

---

## Step 1 — `DiagnosticsSnapshot` type + builder (`harness-core/shared`)

New `harness/packages/harness-core/src/shared/diagnostics-snapshot.ts`,
exported from `shared/index.ts`:

```ts
export interface DiagnosticsSnapshot {
  capturedAt: string;               // ISO-8601
  harness: { driverKey: string; harnessVersion: string; driverVersion: string };
  mocked: boolean;
  device: IdentitySnapshot;
  engines: {
    role: string;
    /** JSON-safe projection of PrinterStatus — `rawBytes` as a hex string. */
    status: Record<string, unknown> | null;
    detectedMedia: { id: string | number; name: string; widthMm: number;
                     heightMm?: number; type: string } | null;
  }[];
}
```

- A **generic** builder — `buildDiagnosticsSnapshot(input)` — assembled
  from the session + adapter version fields. No per-driver hook: identity,
  `PrinterStatus`, and `MediaDescriptor` are all standard shapes, so the
  snapshot is driver-agnostic. (This is deliberately *not* the
  `HardwareReport` — no rung, no verdict, no print.)
- **`rawBytes` must be serialised as a hex string**, not a `Uint8Array`
  (`JSON.stringify` of a typed array is unreadable). Project the rest of
  `PrinterStatus` through as-is.
- A renderer — `renderDiagnosticsBlock(snapshot): string` — that returns
  the snapshot wrapped in a ```` ```json … ``` ```` fence so it pastes
  straight into a GitHub comment and renders.

---

## Step 2 — Diagnostics block in `SubmitSection.vue`

Render a "Diagnostics" block inside `SubmitSection`, shown whenever
`session.isConnected` is true — **independent of `canSubmit`**, so it is
present in the `pending` state (before any print) as well as later.

- A short blurb: *"Triaging an existing issue? Copy this and paste it
  into the ticket — no need to submit a new report."*
- An inline **preview**: a `<details>` disclosure ("Preview diagnostics
  JSON") containing a read-only `<pre>`/`<textarea>` of the pretty-printed
  snapshot (mirror the existing `.fallback textarea` styling).
- A **Copy** button → `copyToClipboard(renderDiagnosticsBlock(snapshot))`,
  with the existing `'idle' | 'copied'` → "Copied ✓" feedback.
- Recompute the snapshot live (computed) so it reflects the latest polled
  status when the operator copies.
- When `connection.mocked`, the snapshot's `mocked: true` already flags
  it; no extra UI needed.

Leave the verdict-gated submit flow (the `active` / `done` branches,
`buildReport`, `submitReport`) **completely untouched**.

---

## Out of scope — do NOT do these

- **Do not** gate the diagnostics block on `canSubmit`, a print, or a
  picked media — the entire point is pre-print availability.
- **Do not** fold the snapshot into `HardwareReport` or touch
  `schemaVersion` — it is a separate, lighter artifact.
- **Do not** add per-driver hooks — the snapshot is generic. (Per-protocol
  status-bit *decoding* is the stretch goal of the separate
  `unrecognized-media-panel` plan; keep them apart.)
- **Do not** add issue-creation or submit to this control — it is
  copy-only. The copied JSON is for the operator to paste wherever it
  helps: a reply on an existing ticket, or a new issue they open
  themselves when they could not reach a print. Submit stays
  print-gated — that gate is intentional and unchanged by this plan.

---

## Verification

- Unit: `buildDiagnosticsSnapshot` produces the expected shape from a
  fixture session; `rawBytes` comes out as a hex string; `renderDiagnosticsBlock`
  wraps in a valid ```` ```json ```` fence.
- `harness-core` + `harness-shell` test suites green; `pnpm lint` on
  changed files.
- Mock walk-through: with any `?mock=…` URL, connect, and **before
  printing** confirm the Diagnostics block appears, the preview shows the
  JSON, and Copy puts a fenced block on the clipboard. Re-check after a
  status poll that the snapshot reflects the latest status.

---

## Follow-ups (not for this agent)

- If triage demand grows, consider surfacing the same control earlier in
  the page (near the status section) — deferred; the submit block is the
  agreed home for now.
