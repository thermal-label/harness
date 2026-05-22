# harness-marklife

Browser-hosted hardware-reporting harness for the [marklife](../../../marklife/) driver.

One page, one diagnostic print, one short report. The operator clicks Connect, pairs the
Marklife P12 over Bluetooth, prints the diagnostic onto a 15 mm continuous roll, eyeballs
what came out, picks a verdict, and submits a prefilled GitHub issue. Total wall-clock
time: ~3 minutes per device — slightly longer than the USB harnesses because the BLE
pairing flow adds a step.

This app is a workspace member of the harness monorepo. It's never published to npm —
the only output is a zipped static bundle attached to GitHub Releases (per plan 06's
hosting decision). The docs site pulls the `latest`-tagged artifact and serves it under
`thermal-label.github.io/harness/marklife/`.

The harness consumes the unpublished `@thermal-label/marklife-core` and
`@thermal-label/marklife-web` packages via `link:` overrides in the harness root's
`package.json` — both must have a fresh `dist/` (run `pnpm --filter ./packages/core build`
and `pnpm --filter ./packages/web build` in the marklife repo) before this app builds.

---

## What's on screen

The page is a single scroll, not a stepper. Each section progressively reveals as the
operator makes progress, but completed sections stay visible and editable.

1. **Connect to your printer** — one "Connect via Bluetooth" button (the P12 is BLE-only).
   Click pops the browser's Web Bluetooth picker, filtered to the P12's service UUID
   (`0000ff00-…`) and `P12` device-name prefix. Mock mode (`?mock=1` or `?mock=p12`)
   bypasses the picker and pretends a P12 is connected.

2. **Pick the roll** — the P12 takes narrow continuous stock; pick the loaded media (the
   15 mm continuous sticker roll is the catalogue entry today).

3. **Print the diagnostic** — head-width strip (~100 dots @ 203 dpi) with header,
   orientation markers, edge probes, sample text, and a diagonal fill — photograph
   close-up.

4. **Eyeball + verdict** — operator picks one of four rungs: works, partial, rough,
   broken. Optional one-line note. Single-engine — no per-engine tabs.

5. **Submit** — prefilled `thermal-label/marklife` GitHub issue. JSON `HardwareReport`
   block embedded in the body for the triage parser; prose summary above for human
   eyes.

---

## Mock mode

Dev-only (`import.meta.env.DEV` gate). URL flag `?mock=1` or `?mock=p12`.

Mock connect bypasses the picker; the harness wires a `MockTransport` to
`WebMarklifePrinter`. The marklife driver exposes no out-of-job telemetry —
`getStatus()` synthesises an idle `MarklifeStatus` from the transport's `connected`
flag — so the status pill reads ready the moment you click Connect. Writes are silently
accepted: the L11 print path is fire-and-forget (the driver never reads a reply), so the
mock has nothing to queue.

Submit in mock mode tags the report `extra.mocked: true` so a stray submit doesn't land
as a real verification.

---

## Bluetooth requirements

- HTTPS (or `localhost`) — Web Bluetooth refuses HTTP.
- User gesture — every browser blocks `requestDevice()` without a click.
- Chrome / Edge on desktop or Android. Safari ships no Web Bluetooth.
- Linux: `bluetoothd` running and the user in the `bluetooth` group.

---

## Local development

```sh
# from harness/ root
pnpm install
pnpm --filter @thermal-label/harness-marklife dev
```

Vite dev server defaults to `http://localhost:5173`. HTTPS isn't required on
`localhost`; Chrome treats it as a secure context for Web Bluetooth.
