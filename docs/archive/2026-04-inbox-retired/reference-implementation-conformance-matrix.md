# Reference Implementation Conformance Matrix

**Date:** 2026-04-16  
**Purpose:** Provide a crisp execution matrix for bringing the PDPP `reference-implementation/` package closer to spec-shaped completeness without bloating it.

## Working rule

This matrix is about **protocol and reference conformance**, not product scope.

Interpret the columns as:

- `Current status`: what the repo actually does today after the latest implemented tranches
- `Target status`: what the reference should prove after the next focused implementation passes
- `Files / tests`: the concrete touchpoints
- `Execution order`: the recommended sequencing to reduce rework

---

## Matrix

| Surface / claim | Current status | Target status | Files / tests involved | Execution order |
|---|---|---|---|---|
| Core request semantics | **Meaningfully improved.** The AS front door now requires the envelope shape with `authorization_details`, normalizes it internally, and the pending-grant path now runs only through `/oauth/par` plus `request_uri`-based consent. The remaining issue is that the request model still carries some realization bias. | **Spec-shaped.** Request entry reflects current PDPP request semantics: RFC 9396-shaped request model, resolved requester identity, native-safe serialization, and a clean compat boundary for any demo-only approval path. | `reference-implementation/server/auth.js`, `reference-implementation/server/index.js`, `reference-implementation/test/pdpp.test.js`, `spec-core.md`, `spec-auth-design.md` | `4` |
| Owner self-export | **Strong on the native path, still polyfill-shaped elsewhere.** Self-export runs on the real RS query paths. Native-provider owner access no longer requires public `connector_id`, while the personal-server/polyfill path still uses explicit source scoping. | **Strong and honest.** Owner self-export remains on the same RS query model, but native-provider owner paths are provider-local and connector-free at the public contract level. Polyfill path may keep source-scoped behavior behind its own wrapper. | `reference-implementation/server/index.js`, `reference-implementation/server/records.js`, `reference-implementation/server/auth.js`, `reference-implementation/test/pdpp.test.js` | `3` |
| Native-provider path | **Meaningfully more honest.** Native mode hides connector registry and Collection Profile routes, native owner queries no longer require public `connector_id`, native client grants can omit public `connector_id`, and the public grant object is now unified around `source` instead of leaking a different top-level shape for polyfill vs native. The remaining impurity is that the same server composition still underlies both realizations and some internal connector-shaped storage semantics remain visible below the public contract. | **Honest native path.** Separate native app composition over the same substrate, no `/connectors`, no Collection Profile routes, no public `connector_id` dependency, provider-local stream/query/grant story. | `reference-implementation/server/index.js`, `reference-implementation/server/auth.js`, `reference-implementation/server/db.js`, `reference-implementation/server/records.js`, future native scenario/demo, `docs/archive/2026-04-inbox-retired/native-provider-contract-audit.md` | `2` |
| Collection runtime semantics | **Meaningfully improved.** START now carries normalized `scope`, the runtime enforces declared stream/resource/field/time-range boundaries before durable write, grant-scoped state is explicit and tested, and INTERACTION payload/status handling matches the current Collection Profile. The main remaining work is broader realization cleanup, not the connector wire contract itself. | **Collection Profile-aligned.** START carries normalized `scope`, state semantics match `single_use` vs `continuous`, grant-scoped or equivalently scoped state is explicit, interaction payloads/statuses match current profile. | `reference-implementation/runtime/index.js`, `reference-implementation/server/index.js`, `reference-implementation/server/records.js`, `reference-implementation/test/collection-profile.test.js`, `spec-collection-profile.md` | `5` |
| Provider-connect profile | **Meaningfully executable with the intended launch registration split.** The reference now exposes RFC 9728 protected-resource metadata, RFC 8414 authorization-server metadata, a real owner device flow, PAR-backed request staging, a protected DCR endpoint, and CLI flows that can discover the AS from the RS metadata. AS metadata truthfully declares the accepted PDPP `authorization_details` type, registration modes, registration endpoint, and current token-endpoint auth method constraints. The main remaining gaps are broader ecosystem/profile hardening choices, not the launch reference path itself. | **Launch-complete thin companion profile.** Reuses OAuth directly for auth/discovery/metadata and adds only the PDPP-specific glue needed for provider discovery and capability signaling, while the launch reference proves: owner self-export, third-party client connect, manual/pre-registered fallback, and protected DCR when advertised. | `docs/archive/2026-04-inbox-retired/pdpp-provider-connect-profile-draft.md`, `docs/archive/2026-04-inbox-retired/provider-connect-implementation-map.md`, `spec-auth-design.md`, `reference-implementation/server/metadata.js`, `reference-implementation/server/index.js`, `reference-implementation/cli/commands/auth.js`, `reference-implementation/cli/commands/provider.js`, `reference-implementation/test/provider-metadata.test.js`, `reference-implementation/test/pdpp.test.js`, `reference-implementation/test/cli.test.js` | `1` |
| CLI | **Solid first-class consumer.** The reference now has a real CLI for owner login, introspection, owner/self-export queries, client queries, grant revocation, grant timeline inspection, trace inspection, and RS-driven auth discovery. The helper-only `grant token` shortcut is gone, and the aggregate `reference-implementation` runner now exits cleanly with the CLI suite included. Generic provider-connect and richer run/control surfaces are still deferred. | **First-class reference client.** CLI can do owner self-export, inspect grants/queries/runs, and eventually exercise provider-connect flows without hidden admin APIs. | `reference-implementation/cli/`, `reference-implementation/server/index.js`, `reference-implementation/server/auth.js`, `reference-implementation/test/cli.test.js`, provider-connect profile docs | `6` |
| Event spine | **First golden-path tranche landed.** The engine now emits a durable append-only spine for grant, disclosure, revocation, and run lifecycle events, exposes reference-only timeline read routes, and uses those surfaces from tests and CLI inspection. Artifacts, scenarios, and richer projections are still deferred. | **Shared truth source.** Typed append-only event spine with stable ids and artifact pointers; used by control plane, tests, CLI inspection, and later illustrated-flow replay. | `reference-implementation/lib/spine.js`, `reference-implementation/server/db.js`, `reference-implementation/server/auth.js`, `reference-implementation/server/index.js`, `reference-implementation/runtime/index.js`, `reference-implementation/test/event-spine.test.js`, `reference-implementation/test/cli.test.js`, `docs/research/trace-surface-patterns.md`, `docs/archive/2026-04-inbox-retired/control-plane-surface-memo.md`, `docs/archive/2026-04-inbox-retired/control-plane-ia.md` | `7` |

---

## Recommended execution order

### 1. Provider-connect profile

Why first:

- it defines the clean auth/discovery boundary
- it reduces the chance of baking another legacy demo path into the reference front door
- it clarifies what the CLI and native-provider path should assume

Primary artifacts:

- [pdpp-provider-connect-profile-outline.md](/docs/archive/2026-04-inbox-retired/pdpp-provider-connect-profile-outline.md:1)
- [spec-auth-design.md](/spec-auth-design.md:1)

### 2. Native-provider path

Why second:

- it forces the first honest separation between native and polyfill realizations
- it prevents all subsequent work from silently inheriting connector-centric public contracts

Primary artifacts:

- [native-provider-contract-audit.md](/docs/archive/2026-04-inbox-retired/native-provider-contract-audit.md:1)

### 3. Owner self-export

Why third:

- it is already substantively strong
- it becomes the cleanest first real consumer path for both CLI and native provider
- it is lower-risk than changing the full client-grant front door first

### 4. Core request semantics

Why fourth:

- once native-vs-polyfill boundaries are clear, the AS/request front door can be cleaned without mixing ontologies
- this is the highest-value core-spec convergence after the native path is unblocked

### 5. Collection runtime semantics

Why fifth:

- it is important, but it belongs to the polyfill path
- if done too early, it risks dragging the whole project back into connector-first thinking
- better to clean it after the native path and request front door are better defined

### 6. CLI

Why sixth:

- by this point, owner self-export and request/profile boundaries should be stable enough that the CLI can be a real consumer rather than a moving target

### 7. Event spine

Why seventh:

- the event spine should be built against cleaner object and route boundaries
- otherwise it will faithfully encode stale or mixed semantics
- once the earlier surfaces stabilize, the event model becomes a durable substrate for console + replay + conformance

---

## Minimal implementation claims to prove

The next implementation passes should aim to make these claims true:

- A native provider can run on the reference engine without exposing connector semantics publicly.
- Owner self-export is a first-class, provider-local PDPP path.
- Request/approval/grant semantics are legible and standards-shaped.
- The Collection Profile path remains strong, but clearly belongs to the polyfill realization.
- A generic provider-connect story exists as a thin companion profile, not an OAuth clone.
- The CLI is a real consumer of public/reference surfaces, not an admin backdoor.
- The event spine becomes the shared truth source for later console and replay work.

---

## Practical reading of the matrix

If time is tight, prioritize in this order:

1. profile and boundary-setting docs
2. native-provider honesty
3. owner self-export polish
4. request/front-door cleanup

That sequence gets the ontology right before investing in deeper runtime, CLI, or console work.
