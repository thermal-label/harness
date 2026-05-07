# verify-cli

Node-side hardware-reporting harness for the thermal-label drivers.

Plan 05 lives [here](../../../plans/backlog/05-harness-cli.md). This app
covers the maintainer's bench self-validation flow against owned hardware
(starting with labelmanager) and the slice of report submission the
browser harness can't reach (TCP-9100, Node BLE, or anything that would
need WebUSB platform-setup walked first).

This app is **private** (`"private": true`). It is not published to npm
and is not intended for end users.

## Drivers covered today

| Driver       | Transports          | Notes                                                                                                                      |
| ------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| labelmanager | `usb`               | First MVP per plan 05 §sequencing.                                                                                         |
| labelwriter  | `usb`, `tcp` (9100) | Multi-transport: USB on every model, TCP-9100 on Wi-Fi-capable models (LW Wireless, LW 4xx Wi-Fi, 550 Turbo, 5XL).         |
| brother-ql   | `usb`, `tcp` (9100) | QL-820NWB / QL-820NWBc reference target. Bluetooth-SPP supported by the production node adapter; not wired in the CLI yet. |

Subsequent drivers (niimbot, marklife, ...) land as
separate PRs.

## Wizard flow

Default invocation walks the operator through the report:

```sh
pnpm --filter verify-cli verify labelmanager
```

Steps:

1. **Pick a model** — selected from the driver's `DEVICES` registry.
2. **Confirm transport** — `usb` for labelmanager (single transport, no
   prompt).
3. **Connect** — opens `UsbTransport`, runs the status probe, captures
   vid/pid + readiness flags into the `IdentitySnapshot`.
4. **Print diagnostic** — encodes the per-driver diagnostic bitmap
   (header / orientation markers / edge probes / sample text / fill
   region) and writes it to the printer.
5. **Pick a rung** — `verified` / `partial` / `unsupported` based on
   what came out. The harness does **not** synthesise this from
   booleans — the operator's eyes are the source of truth.
6. **Optional notes** — free-text one-liner, e.g. "left edge clipped
   on 12 mm tape".
7. **Submit?** — wizard asks "Submit this report now?" (defaults yes).
   Answer no to print the body to stdout without filing — useful when
   you want to re-print and look again. Re-running the command repeats
   the connect+print; pass the same flags to skip prompts second time.
8. **Submit** — `gh issue create` if available; otherwise the prefilled
   GitHub URL is printed AND auto-opened in your default browser
   (`xdg-open`/`open`/`start`); JSON-dump-to-stdout + email is the last
   resort. Photos go into the GitHub issue comment after submit using
   GitHub's native attachment UI; the harness has no photo path.

## Expert flags

For known-good hardware the maintainer skips prompts wholesale:

```sh
pnpm --filter verify-cli verify labelmanager LM_PNP \
  --transport usb \
  --rung verified \
  --notes "bench self-validation" \
  --no-prompt \
  --dry-run \
  --reporter "@mannes"
```

| Flag                     | Effect                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<driver>` (positional)  | Driver key. One of: `labelmanager`, `labelwriter`, `brother-ql`.                                                                                                                                                                                                                                                                                         |
| `[model]` (positional)   | Device key from the driver registry (e.g. `LM_PNP`). Prompted if omitted.                                                                                                                                                                                                                                                                                |
| `-t, --transport <type>` | One of `usb`, `tcp`, `serial`, `bluetooth-spp`, `bluetooth-gatt`. Skips auto-detect.                                                                                                                                                                                                                                                                     |
| `-r, --rung <rung>`      | One of `verified`, `partial`, `unsupported`. Skips the assessment prompt.                                                                                                                                                                                                                                                                                |
| `-n, --notes <notes>`    | Pre-fill the operator notes field.                                                                                                                                                                                                                                                                                                                       |
| `--no-prompt`            | Fail fast if any further prompt would be needed (useful in scripts/CI).                                                                                                                                                                                                                                                                                  |
| `--dry-run`              | Render the `IssueBody` to stdout instead of submitting. **No hardware required.**                                                                                                                                                                                                                                                                        |
| `--no-submit`            | Run the real print + assessment, but render the body to stdout instead of submitting. Use when iterating on the print before filing.                                                                                                                                                                                                                     |
| `--preview`              | Print the diagnostic bitmap as Braille to stdout before sending bytes. Combine with `--dry-run` for a hardware-free preview.                                                                                                                                                                                                                             |
| `--preview-png`          | Write the diagnostic bitmap as a PNG to a tmp file and auto-open in your default image viewer. Most accurate "what you're sending" view.                                                                                                                                                                                                                 |
| `--reporter <handle>`    | Optional reporter handle (e.g. `@mannes`); appears in the issue body.                                                                                                                                                                                                                                                                                    |
| `--tape-width <mm>`      | Labelmanager-only. One of `6`, `9`, `12`, `19`. Defaults to `12`.                                                                                                                                                                                                                                                                                        |
| `--media <key>`          | Loaded label / tape. Labelwriter accepts a media key (`ADDRESS_STANDARD`) or SKU (`30334`); brother-ql accepts a DK SKU (`DK-22205`). **Optional** when the printer auto-detects (LW 5xx via NFC, brother-ql via status query); **required** for LW 3xx/4xx. Wizard prompts when detection fails and no flag is passed. Flag always overrides detection. |
| `--host <host>`          | TCP-9100 host (IP or hostname). Required for labelwriter `--transport tcp` and brother-ql `--transport tcp`. Wizard prompts when omitted.                                                                                                                                                                                                                |
| `--port <port>`          | TCP-9100 port (default `9100`). Brother-ql `tcp` transport only.                                                                                                                                                                                                                                                                                         |

## Dry-run output

`--dry-run` is the test path: no transport open, no `gh` call, no
clipboard. The synthesised identity carries `extra: { synthesised:
true, source: 'dry-run-fallback' }` so the report is distinguishable
from a real one in triage. Sample run:

```sh
pnpm --filter verify-cli verify labelmanager LM_PNP \
  --transport usb --rung verified \
  --notes "bench self-validation" \
  --no-prompt --dry-run \
  --reporter "@mannes"
```

Expected stdout (timestamp varies):

````markdown
Driver: labelmanager (core 0.5.1, harness 0.0.0)
Model: LabelManager PnP [LM_PNP]
Transport: usb
Tape: 12 mm

Plug the printer in over USB and click "Connect" — ...

## LabelManager PnP on usb — verified

**usb** — verified

diagnostic [pass] — bench self-validation

> bench self-validation — @mannes

<details>
<summary>Machine-readable report</summary>

```json
{
  "schemaVersion": 1,
  "driver": "labelmanager",
  "driverVersion": "0.5.1",
  "harnessVersion": "0.0.0",
  "device": {
    "detected": {
      "advertisedName": "LabelManager PnP",
      "vid": 2338,
      "pid": 4098,
      "extra": { "synthesised": true, "source": "dry-run-fallback" }
    },
    "confirmed": {
      "model": "LabelManager PnP",
      "vid": 2338,
      "pid": 4098
    }
  },
  "transports": [
    {
      "name": "usb",
      "patterns": { "diagnostic": "pass" },
      "rung": "verified",
      "notes": "bench self-validation"
    }
  ],
  "submittedAt": "2026-05-07T12:55:00.090Z",
  "reporter": { "handle": "@mannes" }
}
``\`

</details>
```
````

## Diagnostic-print layout (labelmanager)

The labelmanager diagnostic print stitches several head-aligned sections
vertically:

1. **Header** — harness version (`v0.0.0`) and model key (e.g.
   `LM_PNP`), each on its own 1x line. Both fit the 64-dot 12 mm head;
   strings deliberately short to avoid right-edge clipping.
2. **Orientation marker (top)** — `TOP>`. Asymmetric vs the bottom
   marker so mirror / upside-down jumps out without measuring.
3. **Edge probes** — left and right. Bars step in 2-dot increments
   along the chosen edge; the first row whose bar didn't print marks
   the printable margin.
4. **Sample text** — `TXT 1X` (1x) and `2X` (2x) for legibility
   eyeball at both scales. Strings sized to fit the 64-dot 12 mm
   head at the requested scale.
5. **Fill region** — alternating 1-dot stripes for density uniformity.
6. **Orientation marker (bottom)** — `B`. Single-character, distinct
   from `TOP>`.

**Cutter-offset probe is omitted** for labelmanager: the family has no
auto-cut (manual lever), so there's no head-to-cutter dead zone worth
probing. ESC G is form-feed-only on this driver. The trailing-edge
probe analogue surfaces in the next driver section.

## Labelwriter

Multi-transport driver: USB on every model in the registry, TCP-9100
on the Wi-Fi-capable subset (LW Wireless, LW 4xx Wi-Fi, 550 Turbo,
5XL). The wizard reads the device's `transports` map from
`@thermal-label/labelwriter-core`'s `DEVICES` registry, so adding a
new transport to a model upstream is automatically picked up.

The maintainer's local hardware is **LW 330 Turbo** and **LW 400** —
both USB-only, lw-450 protocol, 672-dot heads.

### `--label <key>` is mandatory

Labelwriter labels span a wide range of dimensions
(`RETURN_ADDRESS` 19×51 mm at 602 feed-dots vs. `SHIPPING_LARGE`
102×59 mm at 1205 feed-dots). The diagnostic-print encoder needs the
chosen media to size sections correctly and not overshoot the
trailing edge. Pass either the registry key or any SKU on the label
roll:

```sh
# By media key:
pnpm --filter verify-cli verify labelwriter LW_330_TURBO --label ADDRESS_STANDARD --transport usb

# By SKU printed on the box:
pnpm --filter verify-cli verify labelwriter LW_330_TURBO --label 30334 --transport usb
```

Unknown values are rejected with a printed list of every valid key
and SKU. `--no-prompt` without `--label` fails fast with a
`NoPromptError`.

### Multi-transport flow

After the first transport's submit, the wizard asks "test another
transport on `<key>`? (remaining: `tcp`)". On a Wi-Fi model:

1. Run USB leg → submit.
2. Wizard prompts: another transport? → yes.
3. Pick `tcp` → wizard prompts for host (or `--host` skips it).
4. Connect over TCP-9100, print the diagnostic, assess, submit.
5. Both legs land in `transports[]` of the report (a single
   `HardwareReport` carries both rungs).

USB-only models (LW 330 Turbo, LW 400) skip the prompt because the
remaining-transports list is empty after the first iteration.

### Diagnostic-print layout (labelwriter)

Stitches head-aligned sections vertically across the active head dot
count (672 for the 300-series, 1248 for the 4XL / 5XL):

1. **Header** — `v<harness-version>`, the device key, and the media
   ID (e.g. `ADDRESS-STANDARD`). 1x scale; short strings sized to fit
   the narrowest stock in the registry (return-address 19 mm).
2. **Orientation marker (top)** — `TOP>` at 2x scale.
3. **Edge probes** — left and right, 32 steps × 2 dots each = 64
   dots of probe coverage from each head edge. The first row whose
   bar didn't print reveals the printable margin.
4. **Sample text** — `TXT 1X SAMPLE` and `TXT 2X` for legibility +
   dot-uniformity eyeball at both scales.
5. **Fill region** — 1-dot alternating stripes for density check.
6. **Trailing-edge probe** — `TRAIL+N` text label, then a centred
   24-dot × 4-row bar placed `N` dots above the trailing-edge
   dead-zone. `N` is derived from the engine's
   `capabilities.trailingEdgeOffsetMm` when present (LW 330 Turbo
   declares 4.2 mm = 50 dots), or a 20-dot fallback otherwise. The
   operator reads the bar's position in the photo to confirm the
   dead-zone matches what the registry claims — the same probe
   captures the auto-cut boundary on a future cutter model (LW 450
   SE / Twin Turbo).
7. **Orientation marker (bottom)** — `B` at 2x scale.

Sections are stacked with a 6-px white gap and trimmed to the media's
`lengthDots` so we never overshoot the label.

### Hardware-required step

```sh
pnpm --filter verify-cli verify labelwriter LW_330_TURBO \
  --label 30334 --transport usb --rung verified --no-prompt
```

Drop `--dry-run` and the flow opens the USB device, runs the `ESC A`
status probe (1 byte for lw-450, 32 bytes for lw-550), sends the
diagnostic-print bytes, then submits via `gh` or the prefilled URL.
For Wi-Fi models, `--transport tcp --host <ip>` exercises the
TCP-9100 leg.

## Brother-QL — model + media + transport

Reference target: **QL-820NWB / QL-820NWBc** (`QL_820NWBc` registry
key — both share PID 0x209d and one entry covers both marketing
names). The model has the widest transport surface in the brother-ql
family and is the maintainer's bench unit.

| Aspect          | Coverage                                                                                                                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transports      | `usb`, `tcp` (port 9100 default; `--port` overrides). `bluetooth-spp` is **deferred** — see below.                                                                                                                               |
| Tape-system     | DK only (QL printers). PT-\* engines (TZe / HSe heat-shrink) are out of scope for this MVP.                                                                                                                                      |
| Media catalog   | `--media <SKU>` against `@thermal-label/brother-ql-core`'s `MEDIA` registry. Common: `DK-22205` (62 mm cont.), `DK-22251` (62 mm two-color), `DK-11201` (29×90 die-cut).                                                         |
| Two-color       | **Shipped.** When the chosen media has a `palette` (DK-22251 / DK-44205), the encoder emits both planes — header text + orientation markers in red, edge probes / sample text / fill stripes / cutter probe in black.            |
| Multi-transport | After submitting one transport's assessment, the wizard suggests the unused supported transports and lets you append another rung to the same report's `transports[]` array. `--no-prompt` mode runs only the flagged transport. |
| Cutter probe    | Bar ladder at every 8 dots up to ~17 mm. The QL-820NWB head-to-blade distance is ~13 mm (≈156 dots); the first ladder bar visible above the cut tells you the dead zone.                                                         |

The `--media <key>` flag is **mandatory** — DK-22205 (62 mm continuous)
and DK-11201 (29×90 die-cut) are wildly different dimensions, and the
diagnostic-print can't be properly dimensioned without it. Status
detection is best-effort (some QL printers don't report continuous-tape
SKUs unambiguously); the flag overrides detection in all cases.
Mismatch between `--media` and what the printer reports is logged but
not blocking — operator's choice wins.

### Maintainer one-liner (USB, mono)

```sh
pnpm --filter verify-cli verify brother-ql QL_820NWBc \
  --media DK-22205 \
  --transport usb \
  --rung verified \
  --notes "bench self-validation" \
  --no-prompt \
  --reporter "@mannes"
```

### Two-color self-validation (USB, DK-22251)

```sh
pnpm --filter verify-cli verify brother-ql QL_820NWBc \
  --media DK-22251 \
  --transport usb \
  --rung verified \
  --notes "two-colour ribbon, header reads red as expected" \
  --no-prompt \
  --reporter "@mannes"
```

The diagnostic print's header strings (harness version, model key) and
both orientation markers (`TOP>` / `B`) print in red; everything else
in black. If you see the header in black on DK-22251, two-color
emission silently dropped — file a bug against `brother-ql/packages/core`.

### TCP-9100 self-validation

```sh
pnpm --filter verify-cli verify brother-ql QL_820NWBc \
  --media DK-22205 \
  --transport tcp --host 192.168.1.42 \
  --rung verified \
  --no-prompt
```

Default wizard mode prompts for the host if absent.

### Bluetooth-SPP (deferred)

The production node adapter (`brother-ql/packages/node`) supports the
QL-820NWB's classic Bluetooth SPP via `SerialTransport` over OS-paired
RFCOMM. The verify-cli does **not** wire it yet — the platform-setup
story (`rfcomm bind` / `rfcomm-bind.service` on Linux, OS pairing on
Windows; macOS dropped classic BT SPP entirely) is its own PR.
`--transport bluetooth-spp` throws a useful error pointing at the gap.

### Diagnostic-print layout (brother-ql)

The bitmap stitches several head-aligned sections vertically. Width
matches the loaded media's `printAreaDots` (e.g. 696 dots for 62 mm
DK; 306 dots for 29 mm DK).

1. **Headers** — harness + driver-core version, then model key. Red
   on two-color media; black on mono.
2. **Top orientation marker** — `TOP>` at 2x. Red on two-color.
3. **Edge probes** — left then right. Bars step in 4-dot increments
   along the chosen edge; the first row whose bar didn't print marks
   the printable margin in dots. Always black.
4. **Sample text** — `TXT 1X SAMPLE` at 1x and `2X` at 2x. Always
   black.
5. **Fill stripes** — alternating 1-dot stripes for density
   uniformity. Always black.
6. **Cutter ladder** — bars at every 8th dot row up to ~17 mm.
   QL-820NWB head-to-blade is ~13 mm (~156 dots); the first bar
   visible above the cut tells the operator the dead zone.
7. **Bottom orientation marker** — `B` at 2x. Red on two-color.

`flipHorizontal` runs before encode so input x-axis matches the
printed x-axis (QL pin 0 sits on the right side of the printed face).
Same convention as the production node adapter.

## Local commands

```sh
pnpm --filter verify-cli typecheck
pnpm --filter verify-cli test
pnpm --filter verify-cli lint
pnpm --filter verify-cli verify labelmanager LM_PNP \
  --transport usb --rung verified --no-prompt --dry-run
```

## Hardware-required steps

The agent that scaffolded this app cannot exercise the live-printer
path. The maintainer runs the real-hardware leg with:

```sh
# labelmanager
pnpm --filter verify-cli verify labelmanager LM_PNP \
  --transport usb --rung verified --no-prompt

# brother-ql (QL-820NWB / NWBc) — USB, mono
pnpm --filter verify-cli verify brother-ql QL_820NWBc \
  --media DK-22205 --transport usb --rung verified --no-prompt

# brother-ql — TCP-9100
pnpm --filter verify-cli verify brother-ql QL_820NWBc \
  --media DK-22205 --transport tcp --host 192.168.1.42 \
  --rung verified --no-prompt

# brother-ql — two-color (DK-22251)
pnpm --filter verify-cli verify brother-ql QL_820NWBc \
  --media DK-22251 --transport usb --rung verified --no-prompt
```

Drop `--no-prompt` to walk the wizard. Drop `--dry-run` (when present)
and the flow opens the device, runs the status probe, sends the
diagnostic-print bytes, then submits via `gh` or the prefilled URL.
