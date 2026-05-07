# apps/

Harness apps land here as plans 05 and 06 land:

- `apps/harness-<driver>/` — one per driver, browser-hosted hardware harness.
  Imports `@thermal-label/harness-core/{shared,web}` plus the driver's
  published `-core` package. Sequenced per plan 06 (letratag first).
- `apps/verify-cli/` — single CLI entrypoint dispatching `verify <driver>
  <model>`. Imports `@thermal-label/harness-core/{shared,cli}` plus every
  driver-core. Sequenced per plan 05 (labelmanager first).

Test patterns and identity probes are authored *inside the app*, not in the
driver. Drivers stay completely unaware of the harness — see plan 03
§Driver-vs-harness boundary.
