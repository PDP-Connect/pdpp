## 1. OpenSpec And Scope Guard

- [ ] 1.1 Validate this change with `openspec validate introduce-local-collector-runner --strict`.
- [ ] 1.2 Add or update a design note marking Collection Profile collector lifecycle questions as requiring human-owner collaboration.
- [ ] 1.3 Keep all new collector surfaces documented as reference/control-plane behavior unless the Collection Profile is explicitly updated.

## 2. Kill Host-Browser Bridge Remnants

- [ ] 2.1 Remove host-browser bridge env/config references from Docker and docs.
- [ ] 2.2 Remove the host-browser bridge shim and obsolete tests if no longer load-bearing.
- [ ] 2.3 Replace any remaining host-browser bridge operator copy with local collector/runtime capability guidance.

## 3. Runtime Capability Advertisement And Gating

- [ ] 3.1 Add runtime capability advertisement for provider/control-plane and collector runtimes.
- [ ] 3.2 Derive eligible placement from existing `runtime_requirements` and runtime capabilities.
- [ ] 3.3 Add pre-spawn validation that returns a typed diagnostic when a required capability is absent.
- [ ] 3.4 Add tests proving browser/local-filesystem-required connectors do not spawn in an incompatible provider runtime.

## 4. Local Collector Runner MVP

- [ ] 4.1 Generalize local device exporter client/runtime code into a collector runner path without changing connector output contracts.
- [ ] 4.2 Add a CLI entrypoint for pairing and running the collector.
- [ ] 4.3 Reuse device-scoped enrollment/token verification for collector upload and heartbeat.
- [ ] 4.4 Add a fixture-backed collector run that emits records, blobs if present, run events, and diagnostics through existing ingest paths.
- [ ] 4.5 Keep provider/control-plane-runnable API connectors eligible without collector enrollment.

## 5. Dashboard And Diagnostics

- [ ] 5.1 Show collector/device health using existing device exporter dashboard concepts where possible.
- [ ] 5.2 Show runtime capability mismatch failures as actionable run diagnostics.
- [ ] 5.3 Preserve redaction and bounded diagnostic tails.

## 6. Validation

- [ ] 6.1 Run `pnpm --dir packages/polyfill-connectors run test`.
- [ ] 6.2 Run `pnpm --dir packages/polyfill-connectors run verify`.
- [ ] 6.3 Run `pnpm --filter @pdpp/cli run verify`.
- [ ] 6.4 Run `pnpm --dir reference-implementation test`.
- [ ] 6.5 Run `pnpm --dir reference-implementation run typecheck`.
- [ ] 6.6 Run `pnpm spec:check`.

