# harness-letratag

Browser-hosted hardware-reporting harness for the [letratag](../../../letratag/) driver.

One page, one diagnostic print, one short report. The operator clicks Connect, pairs the
LT-200B over Bluetooth, prints the diagnostic onto a 12 mm cassette, eyeballs what came
out, picks a verdict, and submits a prefilled GitHub issue. Total wall-clock time: ~3
minutes per device — slightly longer than the USB harnesses because the BLE pairing
flow adds a step.

This app is a workspace member of the harness monorepo. It's never published to npm —
the only output is a zipped static bundle attached to GitHub Releases (per plan 06's
hosting decision). The docs site pulls the `latest`-tagged artifact and serves it under
`thermal-label.github.io/harness/letratag/`.

Replaces the role previously played by `letratag/packages/debug`. That app stays in
place during rollout; deletion is a follow-up commit in the letratag repo after this
harness has been walked end-to-end on real hardware.

---

## What's on screen

The page is a single scroll, not a stepper. Each section progressively reveals as the
operator makes progress, but completed sections stay visible and editable.

1. **Connect to your printer** — one "Connect via Bluetooth" button (LT-200B is BLE-only).
   Click pops the browser's Web Bluetooth picker, filtered to the LT-200B's service UUID
   and `Letratag ` device-name prefix. Mock mode (`?mock=1` or `?mock=lt200b`) bypasses
   the picker and pretends the LT-200B is connected.

2. **Pick the cassette** — every LT cassette is 12 mm; pick the substrate / colour
   combination loaded (paper white, plastic black, iron-on, etc.). Ten entries in the
   catalogue.

3. **Print the diagnostic** — 30-dot-wide strip with header, edge probes, sample text,
   diagonal fill, and a `B` trailing marker so a flipped photo is obvious. ~4 mm × 50 mm
   on the cassette — photograph close-up.

4. **Eyeball + verdict** — operator picks one of four rungs: works, partial, rough,
   broken. Optional one-line note. Single-engine — no per-engine tabs.

5. **Submit** — prefilled `thermal-label/letratag` GitHub issue. JSON `HardwareReport`
   block embedded in the body for the triage parser; prose summary above for human
   eyes.

---

## Mock mode

Dev-only (`import.meta.env.DEV` gate). URL flag `?mock=1` or `?mock=lt200b`.

Mock connect bypasses the picker; the harness wires a `MockTransport` to
`LetraTagPrinter` and seeds an `AdvertisingStatus` so the status pill reads
"12 mm cassette · battery full" the moment you click Connect. Writes are silently
accepted; the mock queues a `[1B 52 00]` (success) reply after each payload's `MAGIC`
trailer so the post-print path resolves like a real session.

Submit in mock mode tags the report `extra.mocked: true` so a stray submit doesn't
land as a real verification.

---

## Bluetooth requirements

- HTTPS (or `localhost`) — Web Bluetooth refuses HTTP.
- User gesture — every browser blocks `requestDevice()` without a click.
- Chrome / Edge on desktop or Android. Safari ships no Web Bluetooth.
- Linux: `bluetoothd` running, the user in the `bluetooth` group, and Chrome's
  experimental flag if `watchAdvertisements` is needed for the continuous status
  loop (the harness feature-checks and falls back to post-print-only status when
  unavailable).

---

## Local development

```sh
# from harness/ root
pnpm install
pnpm --filter @thermal-label/harness-letratag dev
```

Vite dev server defaults to `http://localhost:5173`. HTTPS isn't required on
`localhost`; Chrome treats it as a secure context for Web Bluetooth.
