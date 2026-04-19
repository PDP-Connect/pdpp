# Reference Implementation Owner Decisions

Date: 2026-04-16  
Status: Working owner calls to reduce implementation ambiguity

## Why this exists

The current reference-implementation plan is directionally strong, but several important seams were still soft enough to let implementation drift.

This memo makes the current owner-level calls explicit so the next coding passes can optimize for execution rather than re-litigating the architecture in every file.

## Decision 1: Day-one CLI scope

Day-one CLI scope is:

- owner self-export
- owner/query inspection
- grant/debug inspection
- trace inspection
- scenario/reset helpers where clearly labeled as reference-only

Day-one CLI scope is **not**:

- a full generic third-party client-connect experience
- a hidden admin shell over demo-only endpoints

Reason:

- owner self-export is already a real PDPP pattern
- debug/inspection commands help keep the engine and tests honest
- provider-connect support should come only after the companion profile is concrete enough to prove a reusable contract

## Decision 2: Discovery anchor for the first provider-connect profile

The first proved discovery path is:

- RFC 9728 protected-resource metadata as the primary discovery anchor
- RFC 8414 authorization-server metadata for the relevant AS
- PDPP-specific capability/linkage metadata only where those RFCs do not already carry enough information

We are **not** starting with a PDPP-specific `/.well-known/pdpp` requirement.

Reason:

- this keeps the profile thin
- it matches the current strongest standards-composition story
- it avoids inventing a PDPP copy of discovery before we have implementation pressure proving it is necessary

## Decision 3: Native provider path must be connector-free at the contract level

The native provider path may reuse the same server engine internally, but it must be connector-free in the way the contract reads and behaves.

That means:

- no connector lifecycle visible in the Longview ↔ Northstar HR path
- no connector-specific request shape in the native provider path
- no dependence on connector runtime for native query/disclosure behavior

It is acceptable if shared internal storage and enforcement code still exists behind that boundary.

Reason:

- “same engine, different deployment” is still the right implementation bet
- but the native path must not become “personal server with better naming”

## Decision 4: Event spine is a first-class derived truth, not the only system of record

Current state tables remain the source of truth for current durable object state.

The event/trace spine is:

- append-only
- durable
- canonical for history/replay/inspection
- emitted from authoritative state transitions and runtime events

So the reference keeps:

- state tables for current object state
- event spine for history and replay

We are **not** making the event spine the only source of truth in this phase.

Reason:

- the current substrate already has strong relational state
- forcing full event sourcing now would create a second architecture project
- a durable derived history is enough to unify CLI, tests, console, and illustrated replay

## Decision 5: Legacy demo auth routes become explicit compat/reference-only surfaces

The historical compat surfaces were:

- owner-token bootstrap helpers in tests/demo code
- compat `/grants/initiate`
- compat `/consent/:deviceCode/*`

Those routes have now been removed from the live reference surface. The remaining rule is that any future demo/bootstrap shortcuts must stay explicitly reference-only and must not become primary surfaces.

Rules:

- new CLI design must not depend on them as the final contract
- new tests should prefer the cleaner target surfaces whenever feasible
- the docs should label them as reference/development helpers

Reason:

- otherwise the project will keep teaching the old dialect because it is convenient

## Decision 6: Serverless-friendly means AS/RS-friendly, not runtime-friendly

The application contract should be serverless-friendly for:

- AS
- RS
- CLI-facing auth/query surfaces

The connector runtime, scheduler, webhook listener, and file-import paths are allowed to remain worker-shaped.

We are **not** trying to force the connector runtime itself into a request-driven serverless box.

Reason:

- the code and the prior-art both say this is the wrong target
- the correct architecture is stateless app surfaces over explicit backing stores, plus separate worker processes where needed

## Decision 7: Storage seams should stay narrow, not abstract for abstraction’s sake

Immediate seam work should focus on:

- durable relational state
- pending consent storage
- grant-scoped sync state
- event/trace persistence
- explicit public-base-URL configuration

We are **not** building a generic storage/repository framework.

SQLite remains the first storage adapter for:

- grants
- tokens
- manifests
- records
- record history
- sync state
- pending grant and owner-device authorization state

Reason:

- this preserves readability and forkability
- the real problem is hidden assumptions, not lack of abstraction

## Decision 8: Console stays optional until substrate and CLI are cleaner

The control plane is still the right eventual shape, but it is downstream from:

- request/auth cleanup
- provider-connect profile
- event/trace spine
- CLI owner/debug path

So the sequence is:

1. engine and contracts
2. event/trace spine
3. CLI parity
4. optional console

Reason:

- otherwise the console will drag engine design toward UI convenience too early

## Immediate implications for coding

The next coding passes should prioritize:

1. native-provider world with connector-free contract behavior
2. provider-connect profile cleanup around the new `request_uri` front door
3. CLI owner/debug surface
4. event/trace emission around the golden path
5. remaining compat-route demotion

The next coding passes should explicitly avoid:

- building the dashboard first
- broad database abstraction work
- productizing Northstar HR UI
- treating demo auth helpers as normative
