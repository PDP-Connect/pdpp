# Native Provider Contract Audit

**Date:** 2026-04-16  
**Purpose:** Identify the exact connector-centric assumptions in the current `reference-implementation/` stack that would make a native provider such as `Northstar HR` look like a disguised connector deployment, and define the minimum cutline needed to make the native path honestly connector-free at the contract level.

## Bottom line

The current `reference-implementation/` engine is not irredeemably connector-bound, but its **public contract surfaces** still assume a personal-server + connector world.

The good news:

- the RS enforcement core is mostly neutral
- owner/self-export and client grant enforcement are real
- versioned stream/query behavior is already strong enough to preserve

The problem:

- the AS request model, RS owner paths, and Collection Profile paths all expose `connector_id` directly
- the schema registry is publicly framed as `connectors`
- grant objects are connector-scoped
- the demo and tests reinforce connector-centric semantics as if they were the main ontology

The minimal cutline is **not** a storage rewrite.

It is:

1. keep the current storage substrate temporarily
2. introduce a thin provider/source resolution layer at the server boundary
3. split native-provider surfaces from personal-server/Collection-Profile surfaces
4. stop exposing `connector_id` on the native provider path

If we do that, `Northstar HR` can be honest at the contract level without rewriting the whole engine.

---

## What “honestly connector-free at the contract level” means

For a native provider path, a client or owner should not have to think in connector terms.

That means the native provider should **not** require or expose:

- connector registration
- `connector_id` in grant requests
- `connector_id` query parameters for self-export
- Collection Profile state endpoints
- connector manifests as the public schema story

Internally, the implementation may still use a source-scoping key for storage and indexing for now. The issue is not whether a scoping key exists. The issue is whether the **public contract** says “this is a connector deployment.”

---

## Preserve / neutralize / quarantine

### Preserve

These parts are already useful and can stay mostly intact:

- RS query behavior in [reference-implementation/server/records.js](/reference-implementation/server/records.js:279)
- `changes_since` / tombstone / projection logic in [reference-implementation/server/records.js](/reference-implementation/server/records.js:279)
- token issuance and introspection in [reference-implementation/server/auth.js](/reference-implementation/server/auth.js:172)
- owner token path in [reference-implementation/server/auth.js](/reference-implementation/server/auth.js:268)

### Neutralize

These are semantically reusable, but the connector language must be wrapped:

- schema/stream registry
- grant initiation
- owner self-export query paths
- grant serialization
- record storage scoping

### Quarantine

These are real but should be clearly personal-server / Collection-Profile-only:

- `/connectors`
- `/v1/ingest/:stream`
- `/v1/state/:connectorId`
- runtime `START/STATE` plumbing
- scheduler/import/webhook tooling

They are valid for the polyfill path, but they should not define the native-provider contract.

---

## Exact contract leaks today

## 1. Public schema registry is connector-framed

### File

- [reference-implementation/server/auth.js](/reference-implementation/server/auth.js:22)
- [reference-implementation/server/index.js](/reference-implementation/server/index.js:110)
- [reference-implementation/server/db.js](/reference-implementation/server/db.js:16)

### Current assumption

The system publicly registers schema/stream definitions as connector manifests:

- `registerConnector(manifest)`
- `getManifest(connectorId)`
- `POST /connectors`
- `GET /connectors/:connectorId`
- `connectors` table with `connector_id` primary key

### Why this is a leak

A native provider does have stream definitions and selection metadata, but its public contract should not say:

- “register my connector”
- “fetch connector manifest”

That makes `Northstar HR` look like a connector hosted inside a personal server.

### Minimal cutline

- Keep the existing table and manifest shape internally for now.
- Add a neutral server-side resolver layer such as `getSourceContract()` or `getProviderContract()`.
- Expose native-provider schema as provider-local stream metadata, not as connector registration.
- Do **not** expose `/connectors` on the native path.

### Table impacted

- `connectors`

This table can remain physically in place in the first cut if it is hidden behind a neutral provider/source resolver.

---

## 2. Grant initiation is connector-scoped

### File

- [reference-implementation/server/auth.js](/reference-implementation/server/auth.js:48)
- [reference-implementation/server/auth.js](/reference-implementation/server/auth.js:87)
- [reference-implementation/server/index.js](/reference-implementation/server/index.js:128)

### Current request field

- `connector_id`

### Current behavior

`approveGrant()` resolves the requested stream set from `params.connector_id`, loads the connector manifest, and emits grant objects containing:

- `connector_id`
- `manifest_version`

### Why this is a leak

For a native provider, the contract should be:

- provider-local streams are simply part of the provider
- the request is about data selection, not about choosing a connector

If Longview asks `Northstar HR` for `pay_statements`, it should not need to say “connector_id = northstar_hr”.

### Minimal cutline

- Introduce a neutral input at the AS edge:
  - native path: provider-local streams, no source selector needed
  - polyfill path: source/provider selector resolves to a manifest-backed source
- Internally, map native `Northstar HR` requests to a fixed source key if needed.
- Keep `connector_id` out of the native public request and consent surface.
- Remove or hide `connector_id` from the externally visible native grant representation.

### File/table impacted

- [reference-implementation/server/auth.js](/reference-implementation/server/auth.js:87)
- `grants.connector_id` in [reference-implementation/server/db.js](/reference-implementation/server/db.js:25)

### Note on the minimal cut

The `grants` table can keep its physical `connector_id` column in the first cut if the native path writes an internal source key there and the public contract no longer exposes it. A table rename is not required for the first honest cutline.

---

## 3. Consent UI is connector-labeled

### File

- [reference-implementation/server/index.js](/reference-implementation/server/index.js:145)

### Current display field

- `<strong>Connector:</strong> ${params.connector_id}`

### Why this is a leak

Even if the native provider uses the same approval implementation, this line immediately tells the user they are authorizing a connector, not a provider-native request.

### Minimal cutline

- Native path should render provider/client/request semantics only.
- Personal-server path may still show source/connector realization details if desired, but that belongs to the polyfill flow.

This is a presentation leak, but it matters because it trains reviewers to see the native path as fake.

---

## 4. Owner self-export paths require connector_id

### File

- [reference-implementation/server/index.js](/reference-implementation/server/index.js:280)
- [reference-implementation/server/index.js](/reference-implementation/server/index.js:295)
- [reference-implementation/server/index.js](/reference-implementation/server/index.js:318)
- [reference-implementation/server/index.js](/reference-implementation/server/index.js:366)
- [reference-implementation/server/index.js](/reference-implementation/server/index.js:391)
- [reference-implementation/server/index.js](/reference-implementation/server/index.js:423)
- [reference-implementation/server/index.js](/reference-implementation/server/index.js:435)

### Current query paths / parameters

- `GET /v1/streams?connector_id=...`
- `GET /v1/streams/:stream?connector_id=...`
- `GET /v1/streams/:stream/records?connector_id=...`
- `GET /v1/streams/:stream/records/:id?connector_id=...`
- `DELETE /v1/streams/:stream/records?connector_id=...`
- `DELETE /v1/streams/:stream/records/:id?connector_id=...`

### Why this is a leak

These are the cleanest self-export paths we have today, but they expose the owner contract as “query by connector.”

For a native provider, owner self-export should be:

- provider-local by default
- stream-local by path
- not parameterized by `connector_id`

### Minimal cutline

For the native path:

- make provider context implicit
- do not require `connector_id` query params

For the polyfill path:

- keep connector/source scoping, but treat it as reference-architecture behavior

### Implementation guidance

The smallest way to do this is:

- add a provider-context resolver in the RS
- for the native provider app, bind that resolver to a single source key such as `northstar_hr`
- reuse the same underlying query functions with the resolved internal key

This avoids a storage rewrite while making the public native path connector-free.

---

## 5. Record storage is keyed by connector_id everywhere

### File

- [reference-implementation/server/db.js](/reference-implementation/server/db.js:51)
- [reference-implementation/server/records.js](/reference-implementation/server/records.js:24)

### Tables

- `records.connector_id`
- `record_changes.connector_id`
- `blobs.connector_id`
- `version_counter.connector_id`

### Why this matters

This is the deepest connector-centric storage assumption in the engine.

However, it is only a **contract leak** if it escapes the server boundary.

### Minimal cutline

Do **not** rewrite these tables in the first cut.

Instead:

- treat `connector_id` as an internal source-scope key
- wrap it behind a source/provider resolver
- stop naming it publicly on the native path

### Why this is acceptable

The audit target is “honestly connector-free at the contract level,” not “physically purge every connector-shaped column immediately.”

Changing the public contract first lets the native-provider path become honest without destabilizing the RS engine.

---

## 6. Grant enforcement path still derives scope from connector_id

### File

- [reference-implementation/server/index.js](/reference-implementation/server/index.js:296)
- [reference-implementation/server/index.js](/reference-implementation/server/index.js:347)
- [reference-implementation/server/records.js](/reference-implementation/server/records.js:279)
- [reference-implementation/server/records.js](/reference-implementation/server/records.js:526)
- [reference-implementation/server/records.js](/reference-implementation/server/records.js:671)

### Current behavior

Client tokens resolve to a grant with:

- `grant.connector_id`

And then all record listing, record lookup, and stream listing are scoped with that connector key.

### Why this is a leak

For a native provider, client-grant enforcement should feel like:

- this provider issued a grant over these streams

not:

- this connector issued a grant over these streams

### Minimal cutline

- Leave the underlying query functions mostly intact.
- Introduce a neutral `sourceScope` or provider-context resolution step before calling them.
- For native-provider detail pages, consent UI, and grant JSON shown to users, omit `connector_id`.

This is a serialization/wrapper fix more than a query-engine rewrite.

---

## 7. Collection Profile endpoints are mixed into the same RS surface

### File

- [reference-implementation/server/index.js](/reference-implementation/server/index.js:444)
- [reference-implementation/server/index.js](/reference-implementation/server/index.js:471)
- [reference-implementation/server/index.js](/reference-implementation/server/index.js:482)
- [reference-implementation/runtime/index.js](/reference-implementation/runtime/index.js:69)
- [reference-implementation/runtime/index.js](/reference-implementation/runtime/index.js:101)

### Current paths

- `POST /v1/ingest/:stream?connector_id=...`
- `GET /v1/state/:connectorId`
- `PUT /v1/state/:connectorId`

### Why this matters

These endpoints are valid for the polyfill/runtime path, but if the native provider exposes them as part of its main surface, it reads like a connector-based system wearing provider clothing.

### Minimal cutline

- Keep these endpoints only on the personal-server / Collection-Profile reference surface.
- Do not expose them as part of the native provider path.
- If both native and polyfill live in the same codebase, gate them by deployment mode or app composition, not by convention alone.

### Table impacted

- `connector_state`

This table is runtime-specific and does not need to be renamed for the first cut. It simply should not be part of the native provider contract.

---

## 8. Experimental push/import helpers are still conceptually connector-adjacent

### File

- [reference-implementation/runtime/webhook-adapter.js](/reference-implementation/runtime/webhook-adapter.js:1)
- [reference-implementation/runtime/file-import.js](/reference-implementation/runtime/file-import.js:1)

### Why this matters

These are not the main leak, but they reinforce the mental model that all data reaches the RS through a connector-flavored ingest path.

### Minimal cutline

- Keep them clearly under runtime/reference-architecture scope.
- Do not let them define the native provider story.
- Do not use them to justify exposing Collection Profile routes from the native provider app.

---

## 9. Demo and tests reinforce connector ontology

### File

- [reference-implementation/client/demo.js](/reference-implementation/client/demo.js:1)
- [reference-implementation/test/collection-profile.test.js](/reference-implementation/test/collection-profile.test.js:1)

### Current framing

The demo literally begins with:

- register connector manifests
- run connectors to populate the RS
- issue grants scoped by connector

### Why this matters

Even after contract cleanup, reviewers will still infer the wrong ontology if the first runnable reference remains connector-first.

### Minimal cutline

- keep this demo as the personal-server/polyfill scenario
- create a separate native-provider scenario whose happy path never mentions connectors

This is not a core-engine rewrite, but it is necessary to keep the reference honest.

---

## Exact tables that need neutralization or wrapping

### Must be wrapped at the contract boundary

- `connectors`
- `grants.connector_id`
- `records.connector_id`
- `record_changes.connector_id`
- `blobs.connector_id`
- `version_counter.connector_id`
- `connector_state`

### Do not require immediate physical rename

For the first native-provider cut, all of the above can remain physically as-is if:

- native contract never exposes connector language
- native app composition never exposes connector-only endpoints
- server logic resolves provider context to an internal storage key

---

## Exact request fields that need neutralization

### Must not appear on the native-provider public contract

- `connector_id` in grant initiation
- `connector_id` in grant JSON returned to clients/users
- `connector_id` in owner self-export query parameters

### Can remain internally for now

- internal source-scope key passed into record/query helpers

---

## Exact query paths that need wrapping or separation

### Native path should not expose these connector-shaped contracts

- `POST /connectors`
- `GET /connectors/:connectorId`
- `GET /v1/streams?connector_id=...`
- `GET /v1/streams/:stream?connector_id=...`
- `GET /v1/streams/:stream/records?connector_id=...`
- `GET /v1/streams/:stream/records/:id?connector_id=...`
- `DELETE /v1/streams/:stream/records?connector_id=...`
- `DELETE /v1/streams/:stream/records/:id?connector_id=...`
- `POST /v1/ingest/:stream?connector_id=...`
- `GET /v1/state/:connectorId`
- `PUT /v1/state/:connectorId`

### Native path should expose instead

At the minimum:

- provider-local stream metadata
- provider-local owner self-export
- provider-local grant issuance and client query enforcement

The cutline does **not** require inventing a whole new route family immediately. It only requires that the native app composition stop exposing connector-shaped parameters and endpoints.

---

## Recommended minimal cutline

## Phase 1: Honest app composition

Build two app compositions over the same substrate:

- `native provider app`
- `personal server app`

The native provider app should not mount:

- `/connectors`
- `/v1/ingest/:stream`
- `/v1/state/:connectorId`

The personal server app can keep them.

## Phase 2: Provider/source resolver

Introduce a thin resolver layer:

- native provider -> fixed internal source key, e.g. `northstar_hr`
- personal server -> manifest/connector-backed source key

Use that resolver before calling:

- `getManifest()`
- `queryRecords()`
- `getRecord()`
- `listStreams()`
- `listAllStreams()`

This is the key move that avoids a DB rewrite.

## Phase 3: Native-safe request and grant serialization

On the native path:

- remove `connector_id` from public request examples
- remove `connector_id` from consent rendering
- remove `connector_id` from externally visible grant objects

Internally, continue to store the resolved source key until a later cleanup pass.

## Phase 4: Separate native scenario from polyfill scenario

Do not let `reference-implementation/client/demo.js` remain the only canonical runnable story.

Add:

- native-provider scenario
- polyfill scenario

The first should be connector-free in its language and contract.

---

## What does **not** need to happen yet

To make `Northstar HR` honest at the contract level, we do **not** need to:

- rename every `connector_id` column immediately
- rewrite the `records` query engine
- rewrite `changes_since`
- remove the Collection Profile runtime from the repo
- redesign the personal-server/polyfill path

Those can come later.

The immediate goal is narrower:

> stop making the native provider speak connector language at its public contract boundary.

---

## Recommendation

The minimum honest cut is:

1. split native-provider and personal-server app composition
2. hide connector endpoints from the native app
3. wrap `connector_id` behind a provider/source resolver
4. stop emitting connector semantics in native request, consent, owner-export, and grant surfaces

That gives PDPP a native provider path that is honestly provider-native to clients and owners, while preserving the existing connector/personal-server substrate for the polyfill path.

That is the right cutline because it fixes the ontology leak without forcing a large rewrite before the reference is ready.
