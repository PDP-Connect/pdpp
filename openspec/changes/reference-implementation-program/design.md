# Reference Implementation Program Design

## Purpose

Provide one canonical OpenSpec artifact for the PDPP reference-implementation program that mirrors the original E2E/reference plan while using the current repo structure and authority boundaries.

This is a program/execution design, not a second PDPP protocol specification.

## Program goal

Build a forkable, production-credible PDPP reference implementation that proves:

- a strong AS/RS core
- an honest native-provider realization
- an honest personal-server/polyfill realization
- a real CLI
- a thin OAuth-composed provider-connect profile
- a durable event/trace spine

Without:

- coupling the engine to the website
- turning the reference into a dashboard product too early
- preserving demo/compat seams as if they were core contract
- duplicating PDPP protocol semantics inside OpenSpec

## Program shape

The original plan remains correct in current repo terms:

- one forkable implementation substrate in `reference-implementation/`
- one canonical reference world:
  - `Northstar HR` native provider
  - personal-server/polyfill path
  - `Longview` client
  - CLI
- one thin companion provider-connect profile built by composing existing OAuth standards
- one shared event/trace spine
- two disciplined downstream projections:
  - curated illustrated/docs surfaces in `apps/web`
  - optional future operator console/replay surfaces

## Authority order

This program artifact follows the existing governance boundary:

1. root `spec-*.md` files remain normative for PDPP protocol semantics
2. code and executable tests remain authoritative for current implementation behavior
3. OpenSpec governs project architecture, active changes, and program sequencing

If this program artifact conflicts with code/tests or the root PDPP specs, it must be updated.

## Durable boundaries

The execution program should continue to preserve these boundaries:

### 1. Engine first

The forkable reference is centered in:

- `reference-implementation/server`
- `reference-implementation/runtime`
- `reference-implementation/cli`
- `reference-implementation/test`

The website and any future console must remain downstream consumers.

### 2. Native/polyfill honesty

The same engine substrate may support both realizations, but the public contract must remain honest:

- native provider requests and artifacts are `provider_id` / `source` first
- polyfill requests and artifacts are `connector_id` first
- connector/runtime/storage semantics may remain internal where necessary, but should not leak into the native public contract

### 3. Standards composition over duplication

The provider-connect profile should continue to reuse OAuth directly by reference where possible:

- RFC 9728 protected-resource metadata
- RFC 8414 authorization-server metadata
- RFC 8628 device flow
- RFC 9396 `authorization_details`
- RFC 7591 client metadata model where relevant

PDPP-specific work should only define the missing glue.

### 4. Event spine before control plane

Control-plane or replay work should continue to depend on the shared event/trace spine, not invent a second architecture.

### 5. Collection boundary remains explicit

The reference should continue to separate three different things cleanly:

- core/shared semantics:
  - RECORD envelope
  - streams
  - scope
  - tombstones
  - state/checkpoint semantics shared across collection and disclosure
- Collection Profile semantics:
  - START / INTERACTION / RECORD / STATE / DONE
  - binding matching
  - bounded-run lifecycle for collected/polyfill sources
- runtime/orchestrator behavior:
  - scheduling
  - retry
  - credential storage
  - webhook adaptation
  - batch import
  - multi-connector coordination

The reference may make optimistic, disciplined Collection Profile choices before every spec question is frozen, but those choices must be labeled correctly:

- if another implementation must behave the same way for interoperability, the Collection Profile spec should eventually say so
- if the behavior is only a strong reference choice, the reference may implement and test it without claiming normative PDPP status

The current reference decisions are:

- the bounded-run Collection Profile remains the primary collection contract for the polyfill path
- native mode boots from `nativeManifest` only, with `provider_id` and structured `storage_binding` treated as manifest-owned configuration rather than as separate startup flags
- the runtime keeps sending normalized `START.scope` and treats that scope as the run target
- the runtime keeps enforcing declared scope before durable write
- the runtime currently accepts connector-declared `DONE.error` only as `{ message, retryable? }` on failed or cancelled terminals and rejects extra terminal-error fields as reference/runtime validation
- `continuous` runs keep grant-scoped state and `single_use` runs keep `state: null`
- scheduling, retry, credential storage, webhook adaptation, and batch import stay outside the current profile boundary

The current open spec questions are:

- whether the runtime itself must reject every out-of-scope RECORD or whether write-path rejection is sufficient
- which interrupted-run behaviors need normative treatment beyond START / STATE / DONE
- whether `DONE(status="failed")` should normatively imply no checkpoint commit even when one or more streams have already staged `STATE`
- whether runtimes are expected to verify connector-reported terminal counters such as `DONE.records_emitted` or may treat them as informational only
- whether `INTERACTION` terminal-status behavior such as `timeout` and `cancelled` belongs in Collection Profile normativity or should remain a runtime/reference-only behavior
- whether connector `PROGRESS` and `SKIP_RESULT` messages should remain reference/runtime observability artifacts only or eventually become part of a stronger Collection Profile or sibling-profile contract
- whether connector-declared terminal error details in `DONE.error` should become part of Collection Profile normativity or remain reference/runtime-only observability fields, including whether they are valid only for failed or cancelled terminal states
- how much of `START.scope` needs explicit black-box conformance language versus reference-only coverage
- when push delivery or batch import should graduate from runtime experiments into sibling profiles

The current documented open design questions are:

- whether the Collection Profile should ultimately describe runs as atomic transactions or as checkpointed streaming runs where writes may land before checkpoint commit
- whether `STATE` should be understood as a per-stream checkpoint boundary only for the named stream or whether broader cross-stream flush/commit semantics should ever be normative
- whether a successful terminal run should still allow partial cross-stream checkpoint commit if a later state-persistence write fails after an earlier stream checkpoint has already committed
- whether a post-`DONE` protocol violation should preserve writes already flushed under the checkpointed-streaming model or whether the terminal boundary should imply stronger rollback guarantees
- what minimal `DONE.error` structure, if any, should be treated as durable contract rather than reference-only artifact
- whether the launch reference should prove only protected DCR plus pre-registered/manual client onboarding, or also a fuller generic third-party registration/authorization surface
- whether provider-connect request staging should normatively pin pending-consent requests to the manifest version resolved at `/oauth/par`, or whether staged requests may be reinterpreted against whatever manifest is current at consent time
- whether provider-connect request staging should also normatively re-resolve client registration metadata at consent time, or whether staged pending-consent client snapshots should remain authoritative once `/oauth/par` succeeds
- which DCR trust-model details should be durable parts of the launch contract:
  - protected initial-access-token registration only
  - whether registration management is also required
  - which client metadata fields the reference should treat as durable contract versus advisory metadata
- whether connector-shaped internal seams remain an acceptable long-term implementation detail for native providers or whether the internal model should move further toward `provider_id` / `source`
- which `_ref` event-spine surfaces are durable reference-only boundaries versus temporary stepping stones toward a future control plane
- how much future control-plane scope belongs in the first operator surface:
  - inspection only
  - scenario control
  - replay
  - website integration

The root PDPP specs now settle `GET /v1/streams/{stream}` as full source stream metadata rather than a grant-projected contract. The reference follows that rule directly: grants gate stream access, queries, and record disclosure, but they do not rewrite the stream metadata document itself. If the project later wants a grant-relative metadata view, it should be added as a separate surface rather than by changing `stream_metadata`.

The current reference treats explicit structured grant storage binding as the only durable persistence model for token-bound disclosure and no longer carries a second scalar compatibility column for grants.

The current reference also treats persisted pending-consent requests and grants as structured-binding-only state: malformed `source_binding`, `storage_binding`, or `grant.source` data is rejected as invalid reference state rather than reconstructed from ambient native configuration.

The published reference also expects the current database schema directly. It no longer carries in-process migration shims for older grant or owner-device table layouts.

The current durable reference-only event-spine substrate includes:

- `GET /_ref/traces/:traceId`
- `GET /_ref/grants/:grantId/timeline`
- `GET /_ref/runs/:runId/timeline`
- `GET /_ref/traces` (list, filter, paginate)
- `GET /_ref/grants` (list, filter, paginate)
- `GET /_ref/runs` (list, filter, paginate)
- `GET /_ref/search?q=…` (id-aware jump helper for the operator console)

The listing and search helpers were added to let the first operator console (phase 1–5 of the deferred control-plane work) remain practical without inventing a second, hidden control-only architecture. They are read-only, reference-designated, usable from the CLI as well as the console, and not part of the public PDPP contract.

The reference still does not expose mutation or control-plane `_ref` endpoints.

Within that stable run timeline, the runtime now distinguishes checkpoint staging from checkpoint commit explicitly:

- `run.state_staged` means the connector emitted `STATE` and the runtime accepted it as staged checkpoint input
- `run.state_advanced` means the runtime durably committed checkpoint state on a successful run
- `run.failed` / `run.completed` summarize flushed records, dropped buffered tail, and checkpoint commit status so the reference’s checkpointed-streaming behavior is visible at the artifact level
- runtime-side validation failures now also record explicit `run.failed` reasons such as `interaction_handler_invalid_response` instead of disappearing into local thrown errors with no durable reference artifact

## Execution model

This OpenSpec change is the canonical program tracker for the remaining implementation work. It should explicitly track:

- `done`: work that is complete and verified
- `in progress`: active areas that are partly solved but not clean enough to close
- `next`: the ordered backlog of the best immediate tranches
- `deferred`: real work intentionally kept out of the current phase

That structure should replace the earlier role played by inbox status memos.

## Current program phases

### Done foundations

The following original-plan foundations are now materially complete:

- strong AS/RS enforcement core
- owner device flow
- RFC 9728 protected-resource metadata
- RFC 8414 authorization-server metadata
- PAR-backed request staging
- `request_uri`-based consent start
- removal of older compat `/grants/initiate` and `/consent/:deviceCode/*` wrappers
- native requests identified with `provider_id`
- grant-scoped runtime state
- durable event spine with read surfaces
- real CLI surface
- reference implementation rename and publishable package identity

### Remaining core program

The next program focus should stay aligned with the original plan:

1. keep unresolved provider-connect and Collection Profile design questions explicit in OpenSpec while the reference continues to operate against the current intended contract
2. begin the next deferred phase intentionally: console/replay/control-plane work on top of the event spine, without reopening closed launch-reference hardening buckets

The current shaping brief for that deferred operator-console phase lives at:

- `openspec/changes/reference-implementation-program/design-notes/control-plane-discovery-brief.md`
- `openspec/changes/reference-implementation-program/design-notes/control-plane-implementation-plan.md`
- `openspec/changes/reference-implementation-program/design-notes/control-plane-v1-follow-up.md`

That brief is intentionally user-and-workflow-first. It treats the future control plane as:

- local-first by default
- inspection-first before broad mutation/control
- built on top of the existing public and `_ref` substrate rather than a hidden second architecture

The implementation plan then translates that shape into:

- phased delivery
- route and page composition
- allowed read-only helper surfaces
- migration of the current local proto-dashboard into a broader operator IA
- verification and rollout order

The follow-up note then captures the remaining implementation-hardening work that surfaced during the first post-delivery review, without reopening the control-plane product shape.

## Exit criteria for the current phase

The current program phase should be considered complete when:

- remaining compat/demo seams are clearly quarantined or gone
- the native provider reads like a true provider, not a connector-shaped system in disguise
- the provider-connect profile is thin, explicit, and not overstated while still expressing the complete launch target
- the launch-complete reference proves both pre-registered/manual client operation and protected DCR support
- the CLI and tests cover the real public/reference seams tightly enough that drift is caught quickly
- the current intended Collection Profile contract is black-box proved, the native/provider honesty hardening tranche is complete, and the remaining reference-vs-spec questions are explicitly separated
