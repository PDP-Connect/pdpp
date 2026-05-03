## Context

The audit found that execution locality does not require a new manifest taxonomy. Existing connector semantics already carry most of the load:

- `runtime_requirements.bindings` describes required capabilities such as network, browser, and local filesystem/device-like access.
- `capabilities.refresh_policy.background_safe` separates unattended refresh from owner-assisted runs.
- `capabilities.human_interaction` and runtime `INTERACTION` events describe when a run needs human input.
- Device exporter enrollment already provides a scoped local agent credential, heartbeat, batch ingest, diagnostics, and dashboard visibility.

The weak spot is not PDPP Core. The open question is Collection Profile scope: which AS/control-plane ingest and collector lifecycle surfaces should become standard versus remain reference-only. This implementation proceeds optimistically inside the reference implementation and keeps that posture explicit.

## Goals

- Kill host-browser bridge as a strategic path.
- Preserve existing connector contracts and emitted artifacts.
- Introduce a local collector runner as execution placement, not connector redesign.
- Keep the Resource Server read/query-only over already-collected data.
- Let control-plane-runnable connectors continue to run server-side when their requirements are satisfied.
- Add runtime capability advertisement and spawn-time gating.
- Produce verifiable tests without live credentials.

## Non-Goals

- Do not define PDPP Core collection semantics.
- Do not freeze the full Collection Profile.
- Do not add a broad `runtime_modes` manifest enum unless implementation proves existing primitives cannot express placement.
- Do not rewrite all connectors.
- Do not couple browser streaming to collector pairing; streaming is a separate companion track.

## Design

### Boundary

The provider/control plane owns connector config, owner policy, schedules, run ledger, diagnostics, device enrollment, ingest authorization, revocation, and accepted storage writes.

The Resource Server serves authorized reads from storage and enforces grants. It does not run connectors, hold source API keys for collection, launch browsers, or accept collector lifecycle commands.

The local collector runner executes connectors whose requirements cannot be safely or honestly met by the provider runtime. It claims or runs authorized work, satisfies local/browser/filesystem needs, and uploads records, blobs, run events, and diagnostics through scoped ingest routes.

### Runtime Placement

Runtime placement is derived, not hand-authored as a new top-level taxonomy:

1. A provider/control-plane runtime advertises available bindings and restrictions.
2. A collector runtime advertises its available bindings and restrictions.
3. The orchestrator compares connector `runtime_requirements` with runtime capabilities before spawn.
4. If a required binding is missing, the run fails before spawn with a typed diagnostic.
5. If a connector is eligible in multiple runtimes, policy can prefer the control plane for clean API/token connectors and collector for browser/local/device connectors.

This preserves the meaning of existing manifest fields and adds only the missing runtime-side half of the contract.

### Collector MVP

The MVP should generalize the existing local-device-exporter lane:

- A `collector` command or binary pairs with a reference provider using the existing device enrollment pattern.
- The server issues a device-scoped credential. It cannot read records, approve grants, mint owner/client tokens, or mutate unrelated devices.
- The collector heartbeats and advertises capabilities.
- The collector executes one fixture-backed connector or local-device-style connector through existing connector runtime code.
- The collector uploads the same record/blob/run-event shape the server already accepts.
- The dashboard shows collector/device health and run diagnostics.

### Host-Browser Bridge Retirement

The host-browser bridge is not a fallback. Remaining bridge env vars, shims, tests, and docs should be deleted or converted to explicit retired references. Connector code should either use isolated browser launches in a collector-capable runtime or fail with an actionable runtime capability diagnostic.

### Optimistic Collection Profile Posture

This change deliberately implements reference-only collection lifecycle behavior before the Collection Profile is fully aligned with the human owner. The implementation must label these surfaces as reference/control-plane behavior and keep them out of PDPP Core claims.

Open questions requiring human-owner collaboration:

- Which collector enrollment and ingest surfaces belong in Collection Profile versus reference-only control plane?
- Whether third-party providers should implement compatible collector runners or only provider-local collectors.
- Whether runtime capability advertisement becomes Collection Profile vocabulary or remains reference manifest/runtime metadata.
- Whether schedules and request-refresh semantics should standardize around collector availability.

## Alternatives Considered

- **Host-browser bridge:** rejected. It creates Docker GUI, XAUTHORITY, browser profile, and security surface complexity without solving remote-provider cases.
- **New `runtime_modes` manifest enum:** rejected for MVP. It duplicates semantics already present in requirements and risks hiding why a connector needs a runtime.
- **One app per connector:** rejected. A single collector runner with connector adapters better matches existing connector packages and prior art from collector/agent systems.

## Owner Self-Review

- Standards posture: safe. It does not claim PDPP Core semantics and explicitly marks Collection Profile assumptions.
- Scope control: safe. It preserves connector contracts and moves execution placement only.
- User value: high. It removes Docker/browser dead ends and supports remote provider deployments.
- Main risk: implementation may discover one missing low-level manifest primitive. If so, add the primitive with evidence rather than a broad taxonomy.

Confidence: high enough to implement the MVP in parallel with streaming. The remaining uncertainty is Collection Profile normativity, not reference implementation feasibility.

## Acceptance Checks

- `openspec validate introduce-local-collector-runner --strict`
- `pnpm --dir packages/polyfill-connectors run test`
- `pnpm --dir packages/polyfill-connectors run verify`
- `pnpm --filter @pdpp/cli run verify`
- `pnpm --dir reference-implementation test`
- `pnpm --dir reference-implementation run typecheck`
- A fixture-backed collector flow proves: enroll collector, advertise capabilities, run connector, ingest records, inspect diagnostics.
- A negative test proves: provider/control-plane runtime refuses a browser/local-filesystem-required connector before spawn when capability is absent.
- Grep proves host-browser bridge user-facing strategy remnants are gone.

