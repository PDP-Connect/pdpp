# Reference Implementation Substrate Audit

Date: 2026-04-16  
Status: Working memo  
Scope: inherited `reference-implementation/` implementation as extracted from the pre-PDPP Vana/OpenDataLabs MVP stack

## Executive Summary

The inherited `reference-implementation/` stack is stronger than its demo-first surfaces suggest. The durable protocol substrate is the SQLite-backed grant/token/record engine plus the grant-enforced query path: it already proves owner vs client token separation, introspection-driven enforcement, projection-aware `changes_since`, tombstones, revocation, and self-export. That is the part to preserve.

The main drift is concentrated at the edges:

- the authorization/request front door is much cleaner than the inherited MVP path, but the provider-connect surface still stops short of a full generic client-connect profile
- the collection runtime still speaks an older START/state/interaction dialect in parts of the harness and tests
- several helper/demo surfaces are Vana/OpenDataLabs-specific or explicitly demo-only
- some experimental runtime tools are now stale against the current ingest/runtime contract

The deepest inherited assumption is that the whole world is connector-centric. That is acceptable for the personal-server and Collection Profile realization, but it should not be treated as the only valid shape of PDPP. A production-credible reference needs to preserve the engine while isolating the connector/personal-server worldview behind reference/profile layers so a native PDPP provider can coexist cleanly.

## Preserve

### 1. The RS storage and disclosure engine

Preserve the SQLite-backed record/change-history substrate in `reference-implementation/server/db.js` and `reference-implementation/server/records.js`.

Why:

- It already expresses the hard part of PDPP: durable records, version history, tombstones, projection-aware disclosure, cursor expiry, and owner vs client behavior.
- The `queryRecords()` path is materially aligned with the current core spec, especially around projection-aware incremental sync and distinct `cursor` vs `changes_since` token spaces.
- This is the part most worth forking by a third-party implementer.

Specific durable pieces:

- `records`, `record_changes`, and `version_counter` tables
- canonical key encoding
- field projection and request narrowing
- `changes_since` session anchoring and cursor expiry
- tombstone semantics
- self-export via owner token using the same query endpoints

### 2. The token/grant enforcement split

Preserve the token model in `reference-implementation/server/auth.js` and `reference-implementation/server/index.js`:

- owner token vs client token distinction
- RFC 7662-style introspection with PDPP extensions
- grant revocation and token invalidation behavior
- `single_use` issuance semantics

Why:

- This is a good reference substrate even if the auth/profile entrypoint changes.
- It cleanly separates identity mechanism from RS enforcement.
- It already maps well onto the current `spec-auth-design.md` boundary.

### 3. Manifest-aware enforcement logic

Preserve the parts of the implementation that use manifest metadata to make selection and disclosure concrete:

- views resolving to fields
- `consent_time_field` behavior
- required-field preservation during projection
- stream metadata exposure

Why:

- This is real PDPP value, not Vana-specific residue.
- It keeps the reference implementation grounded in actual stream semantics rather than toy objects.

### 4. The black-box reference implementation test harness shape

Preserve the existence and role of `reference-implementation/test/pdpp.test.js` and `reference-implementation/test/collection-profile.test.js` as black-box protocol oracles.

Why:

- The current harness already tests real wire behavior across AS, RS, and runtime.
- It is the right place to accumulate reference-level conformance depth.
- Even where the tests are stale, the harness model itself is good.

## Isolate

### 1. The combined personal-server topology

Isolate the current “combined AS + RS personal server” shape in `reference-implementation/server/index.js` as a reference realization, not the ontology of PDPP.

Why:

- It is a useful deployment for the personal-server/polyfill path.
- It is not the only valid deployment shape, especially if the reference also wants a native HR platform realization.
- Heavy coupling to this topology would make the reference less forkable.

Recommended treatment:

- keep it as one reference deployment
- avoid baking its topology into core semantics or docs language

### 2. Connector-centric registration and storage assumptions

Isolate the `connector_id`-centric worldview behind the Collection Profile and personal-server realization.

Where it appears:

- grants bound directly to `connector_id`
- owner query endpoints requiring `connector_id`
- record storage keyed by `connector_id + stream + record_key`
- `/connectors` registration as an AS concern

Why isolate rather than immediately delete:

- It is still a coherent model for polyfill collection.
- It is useful for manifests and runtime orchestration.
- It becomes problematic only when treated as the universal PDPP topology.

Design implication:

- the reference should make clear that this is the collection/personal-server seam
- native-provider reference surfaces should not be forced to pretend they are connectors

### 3. The legacy demo auth flow

Isolate any remaining legacy demo/bootstrap auth assumptions around the newer request-URI-driven consent seam.

Where it shows up:

- the primary `/oauth/par` + `request_uri` flow in `reference-implementation/server/auth.js` and `reference-implementation/server/index.js`
- legacy/demo bridge code in `apps/web/src/app/api/*`
- narrative/bootstrap helpers in demo scripts and older notes

Why:

- The obvious helper routes are now gone from the live reference surface.
- The remaining risk is subtler: demo/bootstrap assumptions can still linger in bridge code, scripts, or stale documentation.
- Those assumptions still reflect the inherited MVP path more than the current PDPP request/auth direction.

Recommended treatment:

- label them explicitly as legacy/demo surfaces when they remain
- keep them out of the “pure reference” contract as the companion auth/discovery profile hardens

### 4. Runtime orchestration experiments

Isolate `reference-implementation/runtime/scheduler.js`, `reference-implementation/runtime/webhook-adapter.js`, and `reference-implementation/runtime/file-import.js` as orchestration/reference experiments.

Why:

- They are runtime-local concerns, not core protocol substrate.
- They can be useful as reference-world tooling.
- They should not define the forkable engine contract.

Important note:

- `scheduler.js` is conceptually in the right layer, but still local orchestration, not protocol.
- `webhook-adapter.js` and `file-import.js` currently embody experimental questions more than durable reference behavior.

### 5. The demo narrative client

Isolate `reference-implementation/client/demo.js` as a narrative/demo artifact.

Why:

- It is useful for storytelling and regression checks.
- It is not a reusable reference client.
- It still assumes the older connector-manifest demo world and should not anchor the future CLI or control plane.

## Replace

### 1. The request/auth front door

Replace the flat grant-initiation contract with the current standards-shaped request model.

Current stale shape:

- historical flat request helpers and demo-first call paths that used to preserve the older mental model even though the live front door now runs through `/oauth/par` + `authorization_details`

Desired direction:

- RFC 9396 `authorization_details`
- top-level `client_display`
- companion auth/discovery profile for provider connectivity
- resolved client identity/trust model consistent with the current core spec

Why:

- This is the largest core-spec drift in the inherited stack.
- It blocks the reference from looking like a standards-authored system.

### 2. Collection runtime START/state semantics

Replace the runtime contract pieces that are behind the current Collection Profile.

Current stale shape:

- some tests still under-prove `START.scope` despite the runtime now sending it
- the public state route is still connector-centered even though it now accepts optional `grant_id`
- interaction round-trip still tolerates older field names/statuses in tests

Desired direction:

- `START.scope` as the normalized collection target
- grant-scoped state for `continuous` runs
- `state: null` for `single_use`
- current `INTERACTION.kind`, `INTERACTION.message`, and `INTERACTION_RESPONSE.status`

Why:

- This is the largest Collection Profile drift.
- It matters directly for the polyfill story and for any control plane built on top.

### 3. Stale Collection Profile tests

Replace or update the stale assertions in `reference-implementation/test/collection-profile.test.js`.

Specific stale areas:

- test descriptions claim `START.scope` coverage that does not exist
- INTERACTION test still emits `interaction_type` and `prompt`
- response status still uses `completed` rather than current spec values
- “STATE is grant-scoped” test only proves connector isolation, not actual grant-scoped state

Why:

- The test harness is valuable, but stale tests create false confidence.

### 4. Broken or mismatched experimental tools

Replace or repair `webhook-adapter.js` and `file-import.js` before treating them as serious reference artifacts.

Reason:

- both currently post JSON bodies like `{ records: [...] }`
- the RS ingest endpoint in `reference-implementation/server/index.js` currently expects `application/x-ndjson`
- as written, these tools are stale against the current server contract

That makes them poor reference material in their current form.

### 5. Demo-only operator endpoints

Replace any remaining helper/bootstrap assumptions in demos and bridge code as first-class reference surfaces with profile-appropriate mechanisms.

Why:

- The most obvious helper routes are already removed, which is good.
- The remaining problem is any surface that still depends on bootstrap behavior or teaches it as if it were canonical.
- A production-credible reference should not make them look like canonical public API.

Recommended treatment:

- keep unavoidable bootstrap behavior clearly reference-only
- move any remaining shortcuts behind explicit legacy/demo labeling
- converge on CLI- and profile-driven flows

## Risks

### 1. Accidentally replacing the strongest part

The biggest risk is overreacting to the demo/auth drift and rewriting the record/query substrate that is already working well.

### 2. Treating connector-centric assumptions as core PDPP truth

If `connector_id` remains the implicit center of every surface, the reference will struggle to support a native-provider realization without architectural awkwardness.

### 3. Dual-dialect drift during transition

If legacy demo endpoints and new standards-shaped endpoints coexist without a crisp boundary, tests and docs will drift and implementers will not know which surfaces are real.

### 4. Control-plane or website contamination

If orchestration, dashboard, or website needs start driving engine design, the forkable reference will lose purity quickly.

### 5. Conformance theater

A stale test suite is worse than a smaller honest suite. The collection/runtime layer is especially exposed to this risk right now.

## Recommended Extraction Order

### 1. Freeze the durable core with characterization tests

Before major refactors, add or tighten tests around:

- grant/token lifecycle
- owner vs client query behavior
- projection-aware `changes_since`
- tombstones and cursor expiry

Goal: protect the strongest substrate from accidental regression.

### 2. Mark and contain the legacy dialect

Explicitly label any remaining demo/bootstrap auth behavior as legacy/reference-only surfaces.

Goal: stop implicit legacy behavior from masquerading as the pure reference contract.

### 3. Replace the auth/request front door

Introduce the standards-shaped request/auth layer:

- RFC 9396 request envelope
- resolved client identity metadata
- companion auth/discovery profile

Keep a transition shim only as long as needed for tests and local demos.

### 4. Replace collection runtime/state semantics

Bring `reference-implementation/runtime` and the RS state endpoints into alignment with the current Collection Profile:

- normalized `scope`
- grant-scoped state
- current interaction schema
- strict scope enforcement

### 5. Repair or retire stale experiments

Either update `file-import.js` and `webhook-adapter.js` to the real ingest contract or demote/remove them from the active reference path.

### 6. Introduce the native-provider realization on top of the preserved substrate

Build the HR/native-provider path using the preserved engine, while keeping connector-specific assumptions in the personal-server/polyfill path.

Goal: prove the substrate is truly reusable across both realizations.

### 7. Replace the old demo client with durable consumers

Move from `reference-implementation/client/demo.js` as the primary top-level consumer toward:

- a real CLI
- a control plane that consumes real APIs
- trace capture for the illustrated flow

At that point the inherited MVP demo can become optional rather than foundational.
