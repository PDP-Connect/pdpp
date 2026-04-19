# E2E Owner Status

Status note: historical owner snapshot. The active canonical program tracker now lives in `openspec/changes/reference-implementation-program/`.

Date: 2026-04-17  
Status: Working owner checklist for the PDPP E2E/reference program

## Goal

Build a forkable, production-credible PDPP reference implementation that proves:

- a clean AS/RS core
- an honest native-provider realization
- an honest personal-server/polyfill realization
- a real CLI
- a thin OAuth-composed provider-connect profile
- a durable event/trace spine

Without:

- coupling the engine to the website
- turning the reference into a dashboard product
- preserving demo/compat seams as if they were core protocol

## Current owner read

- `forkable engine substrate`: `75-80%`
- `full E2E/reference vision`: `55-65%`

Workstream confidence/completeness:

- `AS/RS core`: `85-90%`
- `owner auth + self-export`: `80-90%`
- `CLI`: `75-85%`
- `native-provider path`: `65-75%`
- `provider-connect profile`: `55-65%`
- `event spine`: `60-70%`
- `Collection Profile alignment`: `60-70%`
- `console / replay / control plane`: `10-20%`

## Done

These are no longer plan-only items.

- `AS/RS enforcement core` is real and well-tested.
- `owner device flow` exists and is standards-shaped enough to matter.
- `RFC 9728` protected-resource metadata exists.
- `RFC 8414` authorization-server metadata exists.
- `request` entry now supports the envelope form as the real primary shape.
- `PAR-backed request staging` exists via `POST /oauth/par`.
- `request_uri`-based consent start is primary.
- legacy `compat /grants/initiate` and `compat /consent/:deviceCode/*` wrappers are gone.
- `native-provider mode` no longer requires public `connector_id` for native owner access.
- `provider_id` is now the native request identity, not implicit connector absence.
- `Northstar HR` has a provider-first manifest shape.
- `grant-scoped runtime state` exists.
- `event spine` exists as a durable derived substrate with read surfaces.
- `CLI` supports:
  - auth login
  - introspect
  - provider show
  - owner streams/query/get/export
  - query streams/records/get
  - grant revoke
  - grant timeline
  - trace show
  - inspect
  - grant start
- `grant token helper route` is gone.
- `collection-profile` harness no longer hangs the aggregate test run.
- active `docs/inbox` memos are materially more aligned with the live engine.

## In progress

These are partly solved, but still not clean enough to treat as finished.

- `native-provider honesty`
  - public contract is much better
  - internal/storage language is still partly connector-shaped
  - native and polyfill are still implemented on one shared server substrate

- `provider-connect profile`
  - metadata, owner device flow, and request staging exist
  - the boundary between `owner self-export`, `reference client-connect`, and `generic third-party connect` is still not fully crisp

- `CLI as provider-connect consumer`
  - now stages PDPP request artifacts through `/oauth/par`
  - still does not prove a full generic third-party connect path

- `Collection Profile convergence`
  - grant-scoped state is real
  - some tests and runtime semantics still under-prove the current contract

- `compat seam demotion`
  - old grant-initiation and device-code consent wrappers are removed
  - some tests/demo/reference bridges still depend on bootstrap shortcuts

## Next

These are the best next moves, in order.

### 1. Keep retiring compat/demo seams

Confidence: `97%`

Focus:

- remove or quarantine remaining compat use in tests/reference bridges
- stop teaching compat wrappers anywhere as if they were portable surfaces
- keep owner-token bootstrap logic confined to tests/demo helpers, not public/reference contract

Why next:

- high confidence
- low architectural risk
- improves truthfulness immediately

### 2. Tighten native-provider honesty further

Confidence: `95%`

Focus:

- keep `provider_id` and `source` primary in native paths
- keep connector semantics adapter-only
- reduce any remaining “native provider implemented as connector-first world” leakage

Why next:

- this is still the biggest architectural impurity
- the reference goal depends on two honest realizations, not one engine pretending both are the same thing

### 3. Refine the thin provider-connect profile without overclaiming

Confidence: `90%`

Focus:

- keep OAuth composition explicit
- document and test what the current provider actually proves
- avoid implying full generic third-party connect where only request staging and owner flows exist

Why next:

- the profile is now real enough that overstatement is the bigger risk than absence

### 4. Use the CLI and tests as truth-serum

Confidence: `95%`

Focus:

- every meaningful public/reference seam should have either:
  - a CLI command
  - a black-box test
  - ideally both

Why next:

- this is the fastest way to keep the reference honest
- it also guards against future drift as the profile and native/polyfill split get cleaner

### 5. Finish Collection Profile convergence

Confidence: `88%`

Focus:

- sharpen `START.scope` proof
- tighten interaction/status assertions
- keep grant-scoped state explicit in tests and docs

Why later than the items above:

- this is important, but it is no longer the largest source of architectural confusion

## Deferred on purpose

These are real future tasks, but should not drive the engine now.

### 1. Control plane / live console

Confidence in deferral: `98%`

Reason:

- we now have enough event spine to make it plausible later
- building it now would still risk pulling the engine toward UI convenience

### 2. Replay / illustrated-flow integration

Confidence in deferral: `95%`

Reason:

- should sit on top of the event/trace spine
- should not shape the engine contract prematurely

### 3. Full generic third-party client-connect

Confidence in deferral: `92%`

Reason:

- current profile work is not quite crisp enough yet
- it is easy to accidentally fake completeness here

### 4. Storage abstraction beyond the current narrow seams

Confidence in deferral: `97%`

Reason:

- SQLite-first is still correct
- the real problem is hidden assumptions, not lack of abstraction

## Things I am not >95% sure about

These are the remaining decisions that still deserve caution.

- the exact cut line between `reference provider-connect support` and `generic third-party connect`
- the best next CLI expansion after `grant start`
- the final long-term operator/control-plane IA
- whether and when to advertise more authorization-start capability in AS metadata

These are not blockers, but they are why the immediate sequence should stay conservative.

## Owner standard for the next tranche

Keep doing the moves that are `95%+` first.

That means:

1. truthfulness over feature count
2. engine purity over dashboard convenience
3. native/polyfill honesty over architectural hand-waving
4. CLI/tests over memo confidence

## Exit criteria for the next phase

We should consider the next phase complete when:

- remaining compat/demo seams are clearly quarantined or gone
- the native provider reads like a true provider, not a connector-shaped system in disguise
- the provider-connect profile is thin, explicit, and not overstated
- the CLI and tests cover the real public/reference seams well enough that new drift becomes obvious quickly
