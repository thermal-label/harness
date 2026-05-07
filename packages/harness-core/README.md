# @thermal-label/harness-core

Workspace-internal package for the thermal-label harness monorepo. **Not
published.** Three subpath exports scoped by runtime environment:

- `@thermal-label/harness-core/shared` — env-agnostic schemas, types, the
  `IssueBody` markdown serializer, and the per-transport instruction registry.
  Consumed by both browser and node runtimes.
- `@thermal-label/harness-core/web` — browser-only helpers (Web Bluetooth /
  WebUSB shims, UI helpers). Consumed by `apps/harness-<driver>/` per plan 06.
- `@thermal-label/harness-core/cli` — node-only helpers (TUI prompts, node-usb
  wrappers). Consumed by `apps/verify-cli/` per plan 05.

Runtime helpers in `web` and `cli` land incrementally as the apps that consume
them are wired up. Plan 03 only ships the contract surface in `shared` plus the
two empty entry points.
