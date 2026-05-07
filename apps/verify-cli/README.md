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

| Driver       | Transports | Notes                              |
| ------------ | ---------- | ---------------------------------- |
| labelmanager | `usb`      | First MVP per plan 05 §sequencing. |

Subsequent drivers (labelwriter 4xx, brother-ql, niimbot, marklife, ...)
land as separate PRs.

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

| Flag                     | Effect                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `<driver>` (positional)  | Driver key. Today: `labelmanager`.                                                                                                       |
| `[model]` (positional)   | Device key from the driver registry (e.g. `LM_PNP`). Prompted if omitted.                                                                |
| `-t, --transport <type>` | One of `usb`, `tcp`, `serial`, `bluetooth-spp`, `bluetooth-gatt`. Skips auto-detect.                                                     |
| `-r, --rung <rung>`      | One of `verified`, `partial`, `unsupported`. Skips the assessment prompt.                                                                |
| `-n, --notes <notes>`    | Pre-fill the operator notes field.                                                                                                       |
| `--no-prompt`            | Fail fast if any further prompt would be needed (useful in scripts/CI).                                                                  |
| `--dry-run`              | Render the `IssueBody` to stdout instead of submitting. **No hardware required.**                                                        |
| `--no-submit`            | Run the real print + assessment, but render the body to stdout instead of submitting. Use when iterating on the print before filing.     |
| `--preview`              | Print the diagnostic bitmap as Braille to stdout before sending bytes. Combine with `--dry-run` for a hardware-free preview.             |
| `--preview-png`          | Write the diagnostic bitmap as a PNG to a tmp file and auto-open in your default image viewer. Most accurate "what you're sending" view. |
| `--reporter <handle>`    | Optional reporter handle (e.g. `@mannes`); appears in the issue body.                                                                    |
| `--tape-width <mm>`      | Labelmanager-only. One of `6`, `9`, `12`, `19`. Defaults to `12`.                                                                        |

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
probing. ESC G is form-feed-only on this driver. The convention will
surface with the next driver (labelwriter 4xx) which does auto-cut.

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
pnpm --filter verify-cli verify labelmanager LM_PNP \
  --transport usb --rung verified --no-prompt
```

Drop `--dry-run` and the flow opens the USB device, runs the status
probe, sends the diagnostic-print bytes, then submits via `gh` or the
prefilled URL.
