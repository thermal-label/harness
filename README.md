# thermal-label harness

Internal hardware-reporting harness for the thermal-label driver family. Drives
verification cells in each driver's compatibility matrix from real-hardware
runs.

This repo is **not published**. It's a multi-package pnpm workspace consumed by
the maintainer (and friendly testers) to file `HardwareReport`-shaped issues
against the relevant driver repo.

## Layout

```
packages/
  harness-core/          single package, env-scoped subpath exports
    src/shared/          schemas, types, IssueBody serializer, registries
    src/web/             browser-only helpers (consumed by apps/harness-<driver>)
    src/cli/             node-only helpers (consumed by apps/verify-cli)
apps/                    filled in per plans 05 (verify-cli) and 06 (harness-<driver>)
```

The `harness-core/{shared,web,cli}` subpath split keeps environment boundaries
enforceable without a separate package per environment — we never publish this,
so the per-package boilerplate isn't worth it.

## Driver-vs-harness boundary

Drivers stay completely unaware of the harness. Harness apps consume drivers'
existing public exports (encoders, device metadata); the dependency direction is
one-way (harness apps → driver `-core` packages). Test patterns and identity
probes are _harness concerns_ and live in the harness apps that exercise them
— never in the drivers, never in `@thermal-label/contracts`.

See [`plans/backlog/03-harness-shared.md`](../plans/backlog/03-harness-shared.md)
in the workspace for the full contract decisions.

## Local development

This repo uses the sibling-checkout convention every other thermal-label repo
follows: `pnpm.overrides` points `@thermal-label/contracts` at the local
`../contracts` checkout. Clone the workspace siblings (`contracts`, plus any
driver `-core` packages a harness app pulls in) under `~/thermal-label/`.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm lint
```

## Publishing

Nothing in this repo is published to npm. Apps build to static bundles or local
dev binaries — see plans 05 and 06 for distribution mechanics.
