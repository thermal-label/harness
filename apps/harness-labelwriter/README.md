# harness-labelwriter

Browser-hosted hardware-reporting harness for the [labelwriter](../../../labelwriter/) driver.

One page, one diagnostic print, one short report. The operator clicks Connect, picks the
loaded label, prints the diagnostic, eyeballs what came out, picks a verdict, and submits a
prefilled GitHub issue. Total wall-clock time: ~2 minutes per device.

This app is a workspace member of the harness monorepo. It's never published to npm — the
only output is a zipped static bundle attached to GitHub Releases (per plan 06's hosting
decision). The docs site pulls the `latest`-tagged artifact and serves it under
`thermal-label.github.io/harness/labelwriter/`.

---

## What's on screen

The page is a single scroll, not a stepper. Each section progressively reveals as the
operator makes progress, but completed sections stay visible and editable.

1. **Connect to your printer** — clicks `Connect` to surface the browser's WebUSB
   picker, filtered to every Dymo LabelWriter VID/PID in the registry. Mock mode
   (`?mock=1`) bypasses the picker entirely.
2. **Confirm what we see** — auto-detected model + raw status response. Operator can
   pick a different model from the full DEVICES list if the auto-guess is wrong (Dymo
   PIDs sometimes overlap across firmware revisions).
3. **Pick the loaded label** — filtered MEDIA list scoped to the device's
   `mediaCompatibility`. LW 5xx prefills from the NFC SKU probe; LW 3xx/4xx requires a
   manual pick.
4. **Print the diagnostic** — sends one comprehensive print: header, asymmetric
   orientation markers, edge probes, sample text at two scales, fill region, and a
   trailing-edge probe. Operator can request a second copy before assessing.
5. **What does it look like?** — three radios (`verified` / `partial` / `failing`)
   with one-line guidance per option, plus an optional notes textarea.
6. **Submit the report** — opens a prefilled GitHub issue in a new tab. If the URL
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
pnpm --filter @thermal-label/harness-labelwriter dev
```

Vite serves the app on `http://localhost:5173/` (or the next free port). Real WebUSB
requires Chrome/Edge — Firefox doesn't ship WebUSB.

### Mock mode (no hardware required)

```
http://localhost:5173/?mock=1                # default mock target: LW 330 Turbo
http://localhost:5173/?mock=lw550            # pretend to be a LW 550 (exercises SKU prefill)
http://localhost:5173/?mock=lw5xl            # pretend to be a LW 5XL
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

Drop this into `/etc/udev/rules.d/99-thermal-label-labelwriter.rules`:

```
# Dymo LabelWriter family — VID 0x0922
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

---

## Build (production bundle)

```sh
pnpm --filter @thermal-label/harness-labelwriter build
```

Output lands in `apps/harness-labelwriter/dist/` as a fully static HTML+JS+CSS bundle.
Vite's `base: './'` makes the asset paths relative, so the bundle works under any
sub-path (the docs site mounts it at `/harness/labelwriter/`).

---

## Release

Releases are cut by tag. There is no auto-release; the maintainer tags by hand:

```sh
# from the harness repo root:
git tag harness-labelwriter-v0.1.0
git push origin harness-labelwriter-v0.1.0
```

The CI workflow (`.github/workflows/release-harness-labelwriter.yml`) builds the app,
zips `dist/` as `harness-labelwriter-<tag>.zip`, and attaches it to a GitHub Release on
the same tag. The docs site CI then pulls the `latest`-tagged artifact and serves it.

---

## What gets reported

Each submit produces a `HardwareReport` (per
[plan 03](../../../plans/backlog/03-harness-shared.md)) embedded as a fenced JSON block in
the issue body, alongside a human-readable prose summary. The triage runbook
(plan 04) parses the JSON directly; the prose is for the maintainer's eyes.

PII discipline: the harness carries no reporter-identity field — attribution is the
GitHub issue author. No auto-fill from the browser identity, no email harvest. USB
serial numbers and other potentially-identifying USB descriptors are kept out of
`detected.extra` (the WebUSB `productName` is included as `advertisedName`, but Dymo
hardware doesn't advertise per-unit serials there).

---

## What's NOT in this app (deliberately)

- **Playground mode** — image dropzone / dither / scale. Post-MVP per plan 06; the
  diagnostic-print flow is the launch surface.
- **TCP-9100 transport** — browsers cannot open raw TCP sockets. LW Wi-Fi-only models
  surface a "use verify-cli or USB" warning rather than failing silently.
- **Photo upload** — explicit non-feature. GitHub's issue-comment attachment UI handles
  photo hosting.
- **Multi-transport flow** — labelwriter only has USB (in browser). The shape stays in
  the report schema for future drivers.

---

## Walkthrough — what the friend or community reporter will see

1. Friend opens `https://thermal-label.github.io/harness/labelwriter/` (or the docs-
   site equivalent the maintainer publishes).
2. Plugs in their LabelWriter, clicks **Connect**, picks the printer in the browser
   prompt.
3. The page shows "Detected model: LabelWriter X" — they confirm or pick a different
   one.
4. They pick the label they have loaded. (LW 5xx auto-prefills from the NFC tag.)
5. Click **Print diagnostic**. The printer prints. They eyeball the output.
6. Click one of three radios — `Looks right`, `Works but with caveats`, `Not usable` —
   optionally add a one-line note.
7. Click **Open prefilled issue**. A new tab opens at the labelwriter repo's issue-new
   page with title and body filled in. They review, optionally drag a photo into the
   comment area, and click Submit.

That's it. The maintainer reads the issue, applies the matrix update, optionally
follows up if the photo / notes raise questions.
