# harness-labelmanager

Browser-hosted hardware-reporting harness for the [labelmanager](../../../labelmanager/) driver.

One page, one diagnostic print, one short report. The operator clicks Connect, picks the
loaded tape width, prints the diagnostic, eyeballs what came out, picks a verdict, and submits
a prefilled GitHub issue. Total wall-clock time: ~2 minutes per device.

This app is a workspace member of the harness monorepo. It's never published to npm — the
only output is a zipped static bundle attached to GitHub Releases (per plan 06's hosting
decision). The docs site pulls the `latest`-tagged artifact and serves it under
`thermal-label.github.io/harness/labelmanager/`.

---

## What's on screen

The page is a single scroll, not a stepper. Each section progressively reveals as the
operator makes progress, but completed sections stay visible and editable.

1. **Connect to your printer** — clicks `Connect` to surface the browser's WebUSB
   picker, filtered to every Dymo LabelManager VID/PID in the registry. Mock mode
   (`?mock=1`) bypasses the picker entirely.
2. **Confirm what we see** — auto-detected model + raw status response. Operator can
   pick a different model from the full DEVICES list if the auto-guess is wrong (Dymo
   PIDs sometimes overlap across firmware revs; a documented mass-storage decoy
   collision exists between LM_280 and LP_350).
3. **Pick the tape width** — D1 cartridges come in 6 / 9 / 12 / 19 mm. Default 12 mm
   (the maintainer's bench tape and the most common width). Each option shows its
   head dot count for triage context.
4. **Printable area (optional)** — five mm inputs (leading / trailing / left / right /
   forcedTrailingFeed). Engine defaults are populated for every labelmanager device
   (8 mm leading + 8 mm forced trailing feed); adjust if your specific chassis behaves
   differently. Per-session overrides flow into the encoder via the option-(b)
   "effective engine" plumbing in `harness-core/labelmanager`.
5. **Print the diagnostic** — sends one comprehensive print: header, asymmetric
   orientation markers, edge probes, sample text at two scales, and a fill region.
   Operator can request a second copy before assessing.
6. **What does it look like?** — three radios (`verified` / `partial` / `failing`)
   with one-line guidance per option, plus an optional notes textarea.
7. **Submit the report** — opens a prefilled GitHub issue in a new tab. If the URL
   exceeds GitHub's limit (~8 kB) or the pop-up blocker fires, the body lands on the
   clipboard and an inline read-only textarea + mailto link become the fallback.

After submit, the success view reminds the operator to drop a photo into the GitHub issue
comment thread — GitHub's native attachment UI handles the upload. The harness
intentionally doesn't host or upload photos.

---

## Local dev

```sh
# from the harness repo root:
pnpm install
pnpm --filter @thermal-label/harness-labelmanager dev
```

Vite serves the app on `http://localhost:5173/` (or the next free port). Real WebUSB
requires Chrome/Edge — Firefox doesn't ship WebUSB.

### Mock mode (no hardware required)

```
http://localhost:5173/?mock=1                # default mock target: LabelManager PnP
http://localhost:5173/?mock=lm280            # pretend to be a LabelManager 280
http://localhost:5173/?mock=lm400            # pretend to be a LabelManager 400
http://localhost:5173/?mock=lm420p           # pretend to be a LabelManager 420P
http://localhost:5173/?mock=lm_pc            # pretend to be a LabelManager PC
http://localhost:5173/?mock=wireless         # pretend to be a Wireless PnP
http://localhost:5173/?mock=lp350            # pretend to be a LabelPoint 350
http://localhost:5173/?mock=mobile           # pretend to be a Mobile Labeler
```

Mock mode synthesises a plausible identity and silently consumes print writes. The
maintainer **must self-walk the mock flow before sending the live URL to a friend or
community reporter** — the mock surfaces every UX rough edge that doesn't depend on actual
hardware response.

---

## First-run on Linux

WebUSB on Linux requires a udev rule that grants the user permission to claim the USB
device. Without it, the browser picker shows the device but `claimInterface()` fails with
`SecurityError`.

Drop this into `/etc/udev/rules.d/99-thermal-label-labelmanager.rules`:

```
# Dymo LabelManager family — VID 0x0922
SUBSYSTEM=="usb", ATTR{idVendor}=="0922", MODE="0666"
```

Then reload udev:

```sh
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Unplug + replug the printer. The browser picker should now connect cleanly.

(macOS and Windows don't need anything similar; the OS USB stack hands the interface to
the browser without a per-device permission rule.)

Some labelmanager models — notably the LM_280, LM_420P, and LP_350 — present as USB Mass
Storage on first connect and need `usb_modeswitch` on Linux to flip them to the printer
interface. The harness can't drive that; the browser picker won't even surface those
devices until they've been mode-switched manually.

---

## Build (production bundle)

```sh
pnpm --filter @thermal-label/harness-labelmanager build
```

Output lands in `apps/harness-labelmanager/dist/` as a fully static HTML+JS+CSS bundle.
Vite's `base: './'` makes the asset paths relative, so the bundle works under any
sub-path (the docs site mounts it at `/harness/labelmanager/`).

---

## Release

Releases are cut by tag. There is no auto-release; the maintainer tags by hand:

```sh
# from the harness repo root:
git tag harness-labelmanager-v0.1.0
git push origin harness-labelmanager-v0.1.0
```

The CI workflow (`.github/workflows/release-harness-labelmanager.yml`) builds the app,
zips `dist/` as `harness-labelmanager-<tag>.zip`, and attaches it to a GitHub Release on
the same tag. The docs site CI then pulls the `latest`-tagged artifact and serves it.

---

## What gets reported

Each submit produces a `HardwareReport` (per
[plan 03](../../../plans/backlog/03-harness-shared.md)) embedded as a fenced JSON block in
the issue body, alongside a human-readable prose summary. The triage runbook
(plan 04) parses the JSON directly; the prose is for the maintainer's eyes.

The tape width rides under `device.confirmed.overrides.tapeWidthMm` so the maintainer's
triage flow knows which head dot count was emitted.

PII discipline: the harness carries no reporter-identity field — attribution is the
GitHub issue author. No auto-fill from the browser identity, no email harvest. USB
serial numbers and other potentially-identifying USB descriptors are kept out of
`detected.extra` (the WebUSB `productName` is included as `advertisedName`, but Dymo
hardware doesn't advertise per-unit serials there).

---

## What's NOT in this app (deliberately)

- **Playground mode** — image dropzone / dither / scale. Post-MVP per plan 06; the
  diagnostic-print flow is the launch surface.
- **NFC SKU probe** — labelmanager doesn't have one. The tape-width picker is operator-
  driven regardless of model.
- **Photo upload** — explicit non-feature. GitHub's issue-comment attachment UI handles
  photo hosting.
- **TCP / Bluetooth / Wi-Fi transports** — labelmanager is USB-only today. The shape
  stays in the report schema for future drivers.

---

## Override plumbing (option (b))

Per-session printable-area overrides flow into `buildPrinterStream` via an "effective
engine" view: the harness spreads the device's primary engine and replaces the
`printableArea` + `forcedTrailingFeedMm` fields with the operator's values, then hands
that synthetic engine to the driver-core encoder. The driver-core encoder reads
`engine.printableArea` / `engine.forcedTrailingFeedMm` exactly as it would with a
registry value — no labelmanager-core change needed.

Trade-off vs. option (a) (threading override fields through `LabelManagerPrintOptions`):
option (b) keeps the driver-core API surface untouched but pays for it with a one-off
engine view at the harness boundary. Option (a) would add a second source of truth on
the options bag; option (b) keeps `engine.printableArea` as the single read site.

---

## Walkthrough — what the friend or community reporter will see

1. Friend opens `https://thermal-label.github.io/harness/labelmanager/` (or the docs-
   site equivalent the maintainer publishes).
2. Plugs in their LabelManager, clicks **Connect**, picks the printer in the browser
   prompt.
3. The page shows "Detected model: LabelManager X" — they confirm or pick a different
   one.
4. They pick the tape width currently in the cartridge (default 12 mm).
5. Click **Print diagnostic**. The printer prints. They eyeball the output.
6. Click one of three radios — `Looks right`, `Works but with caveats`, `Not usable` —
   optionally add a one-line note.
7. Click **Open prefilled issue**. A new tab opens at the labelmanager repo's issue-new
   page with title and body filled in. They review, optionally drag a photo into the
   comment area, and click Submit.

That's it. The maintainer reads the issue, applies the matrix update, optionally
follows up if the photo / notes raise questions.
