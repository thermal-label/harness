# `@thermal-label/harness-shell`

Shared Vue shell + `DriverAdapter` abstraction for the thermal-label harness apps.

Per-driver apps (`apps/harness-<driver>/`) become thin wrappers — a 5-line `main.ts` plus a focused `adapter.ts` that wires driver-core into a `DriverAdapter`. The shell handles UI, state, polling, the engine-tabs strip, the multi-engine submit-coverage list, the URL-too-long fallback, the clipboard textarea, and the "Test the [other-role] engine →" CTA.

Workspace-internal — never published. Ships `.vue` and `.ts` source; consuming Vite app handles compilation.

## How to add a new driver app (worked walkthrough)

Goal: a new `apps/harness-<driver>/` builds, runs, and submits reports against `thermal-label/<driver>` issues. Concrete sequence below uses `brother-ql` as the example. The same shape works for niimbot, cat-printer, letratag, labelife, marklife.

### 1. Scaffold the app directory

Mirror the existing `apps/harness-labelmanager/` shape:

```
apps/harness-brother-ql/
  package.json
  vite.config.ts
  index.html
  env.d.ts
  tsconfig.json
  src/
    main.ts
    adapter.ts
    version.ts
    transport/
      mock.ts
      webusb-filters.ts
```

### 2. `package.json`

Copy from `apps/harness-labelmanager/package.json`. Swap the `name`, the driver-core dep (`@thermal-label/brother-ql-core` instead of `@thermal-label/labelmanager-core`), and the description. Keep `@thermal-label/harness-shell: "workspace:*"` in `dependencies`.

### 3. `vite.config.ts`

Copy verbatim from a sibling app. Update the sibling-checkout aliases for any driver-core packages your driver needs (most drivers need `@thermal-label/contracts` aliased to `../../../contracts/dist/index.js`; brother-ql also needs its own core aliased; cat-printer needs the cat-printer-core alias).

### 4. `index.html` + `env.d.ts`

Copy verbatim. Update the `<title>` to `thermal-label · brother-ql harness`.

### 5. `src/main.ts`

Five lines:

```ts
import { createHarness } from '@thermal-label/harness-shell';
import '@thermal-label/harness-shell/styles';
import { adapter } from './adapter';

createHarness('#app', adapter);
```

### 6. `src/version.ts`

```ts
export const HARNESS_VERSION = '0.0.0-dev';
export const DRIVER_VERSION = '0.0.1';
```

CI injects the real strings via Vite's `define` at build time.

### 7. `src/transport/mock.ts` + `src/transport/webusb-filters.ts`

Copy from `harness-labelmanager` and adapt:

- `webusb-filters.ts` reads `DEVICES` from your driver-core and emits `USBDeviceFilter[]` for the WebUSB picker.
- `mock.ts` declares a `MockTarget` enum (one entry per dev-target you want `?mock=…` to accept), supplies a `MockTransport` class with the right canned status response for your driver's status protocol.

### 8. `src/adapter.ts`

The meat. Implements `DriverAdapter<TDevice, TMedia, TStatus>` from `@thermal-label/harness-shell`. Refer to:

- `apps/harness-labelmanager/src/adapter.ts` — single-engine USB driver, no media detection, simplest template.
- `apps/harness-labelwriter/src/adapter.ts` — multi-engine + per-engine encoder dispatch + NFC SKU detection. Use this template if your driver has Twin/Duo-style engine variants.

Required fields:

- `driverKey`, `driverDisplayName`, `targetRepo`, `harnessVersion`, `driverVersion`
- `devices`, `deviceKey`, `deviceName`, `findDeviceByVidPid`
- `connect(opts)` — returns `{ transports: { [role]: Transport }, device, identity, mocked }`
- `mockTargets`, `defaultMockTarget`
- `media`, `mediaPicker.{filterByDeviceEngine, groupBy, defaultMediaId, detectionCapability}`
- `encoder.{buildBitmap, encodeBytes}`
- `buildReport({device, identity, primarySession, allSessions, multiEngine, mocked, reporter})` — returns a `HardwareReport`

Optional:

- `status` (poll vs subscribe — BLE drivers use `subscribe`)
- `multiEngine.{isMultiEngine, engineEncoder?}` — needed only for multi-engine devices
- `mediaPicker.{swatch, describe, detected, sectionTitle, warning, customDimensions}`
- `disconnectExtras`

### 9. Register in `pnpm-workspace.yaml`

Already covered by `apps/*` glob — nothing to edit.

### 10. Build, run, gate

```sh
pnpm install
pnpm --filter @thermal-label/harness-brother-ql dev
# In another tab:
pnpm typecheck && pnpm lint && pnpm prettier --check . && pnpm test
```

Submit a report against your mock target end-to-end. Check the prefilled-issue URL it would open against `https://github.com/thermal-label/brother-ql/issues/new?…`.

## Hard rules the shell enforces (don't fight these)

- **Tabs only on multi-engine devices.** `multiEngine.isMultiEngine(device)` controls visibility — single-engine devices never see the strip.
- **Submit gates on ≥1 engine assessed.** Partial reports are valid; the submit-button copy adapts. No "are you sure?" modals.
- **Mock mode is dev-only.** `import.meta.env.DEV` gate on `?mock=…`. Production builds ignore it.
- **Identity-probe extras are opaque.** Stuff whatever bytes you want into `identity.extra`; the Advanced drawer renders the `raw` field as hex. The shell never enforces a schema there.
- **Status pills come from `adapter.status.toPills`.** §1 (Connect) reads `printer`; §3 (Media) reads `media`. Engine-aware pills receive `ctx.engine`.

## Risk areas / known limitations

- **Per-engine status polling not implemented.** Today the shell polls the FIRST engine's transport on multi-engine devices (LW Duo: polls label engine; tape-engine status is unchecked). Documented placeholder; per-engine polling is a follow-on.
- **BLE subscribe path scaffolded, not exercised.** No driver uses `status.kind: 'subscribe'` yet. The contract holds; expect minor wrinkles when the first niimbot/letratag adapter lands.
- **Mock-target shape is a small struct.** If your driver's mock needs more than `{ vid, pid, displayName, device, aliases? }`, extend `MockSpec<TDevice>` rather than working around it in the adapter.
- **`vite.config.ts` per-app duplication.** Sibling-checkout aliases (`@thermal-label/contracts` → `../../../contracts/dist/index.js`) duplicate per app. A `createHarnessViteConfig(driverDir)` helper would consolidate but isn't shipped — duplication is mechanical and rare-edit.
