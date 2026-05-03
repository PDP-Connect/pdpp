## 1. OpenSpec And Scope Guard

- [x] 1.1 Validate this change with `openspec validate introduce-local-collector-runner --strict`.
- [x] 1.2 Mark Collection Profile collector lifecycle questions as requiring human-owner collaboration in `design.md` § "Optimistic Collection Profile Posture".
- [x] 1.3 Keep collector enrollment, heartbeat, ingest, and diagnostics labeled as reference/control-plane behavior in the spec delta and operator copy (no PDPP Core claims).

## 2. Kill Host-Browser Bridge Remnants

- [x] 2.1 Remove host-browser bridge env/config references from Docker Compose and `README.md`; replace operator copy with collector-runner guidance.
- [x] 2.2 Delete the host-browser bridge config module, daemon, and test files (`packages/polyfill-connectors/src/host-browser-bridge-config.ts`, `bin/host-browser-bridge.ts`, related tests). Delete bridge-unavailable web error UI and test.
- [x] 2.3 Replace dashboard `host_browser_bridge` posture surface with a `runtime_capabilities` posture summarizing provider/control-plane bindings and collector-paired status.
- [x] 2.4 Drop the `host_browser_required` interaction kind and bridge-aware messaging in the connector runtime; rewrite manual-action recovery copy to point at the local collector runner.

## 3. Runtime Capability Advertisement And Gating

- [x] 3.1 Add `runtime-capabilities.ts` exporting `RuntimeCapabilityProfile`, default provider/collector profiles, and `evaluatePlacement`/`assertPlacementOrThrow` helpers.
- [x] 3.2 Derive eligible placement from connector `runtime_requirements.bindings` against runtime-advertised bindings.
- [x] 3.3 Add a typed `RuntimeCapabilityMismatchError` with stable `runtime_capability_mismatch` code; throw before spawn.
- [x] 3.4 Add positive and negative tests proving (a) API connectors run on provider, (b) browser/local-device connectors fail before spawn on provider with a named missing binding.

## 4. Local Collector Runner MVP

- [x] 4.1 Generalize the device-exporter runtime into a `collector-runner.ts` module (`runCollectorConnector`, `enrollCollector`) without changing connector emit contracts.
- [x] 4.2 Add `bin/collector-runner.ts` with `enroll`/`run`/`advertise` subcommands.
- [x] 4.3 Reuse device-scoped enrollment/token verification — collector tokens cannot read records, mint owner tokens, or mutate unrelated devices (existing device-exporter routes/store).
- [x] 4.4 Add a fixture-backed collector run path that emits records, run events, and diagnostics through existing ingest endpoints. Capability gate fires before any heartbeat or child spawn.
- [x] 4.5 Provider/control-plane API connectors remain eligible without collector enrollment (default provider profile advertises `network`+`filesystem`).

## 5. Dashboard And Diagnostics

- [x] 5.1 Surface collector pairing on the deployment-diagnostics page via the new `runtime_capabilities` section (in_container, collector_paired, bindings).
- [x] 5.2 Surface runtime capability mismatch as an actionable warning (`browser_connectors_need_collector`) when a containerized provider has no collector paired.
- [x] 5.3 Preserve redaction and bounded diagnostic tails — `runtime_capabilities` carries no token surface.

## 6. Validation

- [x] 6.1 Run `pnpm --dir packages/polyfill-connectors run test` — 768 pass, 5 skipped.
- [x] 6.2 Run `pnpm --dir packages/polyfill-connectors run verify` — typecheck + ultracite both clean.
- [x] 6.3 Run `pnpm --filter @pdpp/cli run verify` — 13 pass.
- [x] 6.4 Run `pnpm --dir reference-implementation test` — 1642 pass, 0 fail.
- [x] 6.5 Run `pnpm --dir reference-implementation run typecheck` — clean.
- [x] 6.6 Run `pnpm spec:check` — passed (9 canonical pairs, 2 web-only extensions, 1 reference-only root spec).
- [x] 6.7 Bonus: `pnpm --filter pdpp-web run types:check` and `pnpm --filter pdpp-web run check` — both clean.
