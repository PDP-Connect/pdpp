# Native vs Polyfill Surface Sketch

Date: 2026-04-16
Status: working memo
Scope: public HTTP/API surface and object model for a native PDPP provider (`Northstar HR`) versus a personal-server polyfill path. This is not a product-UI memo.

## Executive summary

The right reference shape is:

- both realizations share the same **core PDPP authorization and resource-server surface**
- the personal-server path additionally exposes **Collection Profile operational surfaces**
- the native provider path must **hide connector/runtime semantics entirely**

In other words, a Longview-like client should see the same grant, token, stream, record, and self-export model whether data comes from `Northstar HR` directly or from a personal server. The native path should not leak `connector_id`, manifest registration, runtime state, `START/RECORD/STATE/DONE`, or browser-automation/import concepts into its public contract.

## 1. Shared public PDPP surface

These are the surfaces and concepts that should be shared across both realizations.

### Authorization and grant concepts

Both paths should expose the same conceptual front door:

- requester identity via `client_id` plus display metadata
- a canonical selection request object with PDPP `authorization_details`
- user approval / denial
- durable grant issuance
- token minting and introspection
- revocation

The current `reference-implementation/server` routes that already point in this direction are:

- `POST /oauth/par`
- `GET /consent?request_uri=...`
- `POST /consent/approve`
- `POST /consent/deny`
- `POST /grants/:grantId/revoke`
- `POST /introspect`

The old compatibility wrappers for `/grants/initiate` and `/consent/:deviceCode/*` are gone; the reference now teaches the request-URI-driven surface directly. The request body shape should converge toward the canonical internal selection-request object already described in the cutover plan, and that convergence applies equally to both native and polyfill realizations.

### Resource-server query surface

Both paths should expose the same core RS model:

- `GET /v1/streams`
- `GET /v1/streams/:stream`
- `GET /v1/streams/:stream/records`
- `GET /v1/streams/:stream/records/:id`

And, for owner-authenticated self-export / owner management:

- `DELETE /v1/streams/:stream/records`
- `DELETE /v1/streams/:stream/records/:id`
- owner-token or equivalent owner-authenticated access to the same RS endpoints

This is the most important shared surface. A PDPP client or CLI should not need to care whether the provider is native or polyfill once it has a valid token and is reading records.

### Shared external object model

Both paths should share these external objects:

- `selection request`
- `client display metadata`
- `grant`
- `token introspection result`
- `stream descriptor`
- `record`
- `record-list / pagination / cursor response`
- `error envelope`

The point of the reference is that these objects remain stable across realizations.

## 2. Native provider public surface

The native provider path should look like a clean core PDPP AS/RS implementation.

### What it should expose

- the shared authorization/grant surface
- the shared query / self-export RS surface
- native provider-specific stream inventory and record semantics
- provider-controlled freshness/update behavior

### What it should not expose

The native provider path should not publicly expose:

- `POST /connectors`
- `GET /connectors/:connectorId`
- `POST /v1/ingest/:stream`
- `GET /v1/state/:connectorId`
- `PUT /v1/state/:connectorId`
- connector manifests as a public object
- runtime `scope`, `bindings`, or run lifecycle concepts
- `START`, `RECORD`, `STATE`, `DONE`, or `INTERACTION` vocabulary
- browser automation, import, scraping, or polyfill language in the API contract

Even if the provider internally uses ingestion or background sync, those are implementation details, not native-path public semantics.

## 3. Personal-server polyfill public and operational surface

The personal-server path should expose two layers:

- the same shared PDPP AS/RS public surface described above
- an additional operational Collection Profile surface for the runtime

### Public client-facing layer

For Longview, the CLI, and any third-party client, the polyfill path should still present:

- the same selection-request / grant / token model
- the same `/v1/streams` and record-query surface
- the same self-export model

This is the interoperability surface.

### Polyfill operational layer

For the runtime and operator plane, the personal server may additionally expose:

- `POST /connectors`
- `GET /connectors/:connectorId`
- `POST /v1/ingest/:stream`
- `GET /v1/state/:connectorId`
- `PUT /v1/state/:connectorId`

And it may internally traffic in:

- connector manifests
- connector bindings
- runtime `scope`
- run-local and grant-scoped state
- `INTERACTION` prompts/responses

These are valid in the polyfill realization, but they are not part of the universal PDPP core surface.

## 4. Where connector/runtime semantics must be hidden from the native path

This is the key boundary.

### Must remain hidden

- `connector_id` as a first-class public object
- manifest registration as part of normal client/provider integration
- per-connector state reads/writes
- runtime lifecycle events
- binding descriptors
- interaction choreography
- import / automation / scraping provenance

### Why

If the native path leaks these concepts, the reference will accidentally teach:

- `PDPP = personal server`
- `PDPP = connector runtime`
- `PDPP = collection protocol`

That is the wrong ontology. PDPP core is the authorization/disclosure model. Collection/runtime is one realization path.

## 5. Shared concepts that may differ in source, but not in contract

Some things can differ internally while remaining externally identical.

### Stream freshness and update source

- native provider: updated from the provider’s own systems of record
- personal server: updated via connector runs, imports, or other collection means

Externally, both still present a stream with records and cursors.

### Self-export

- native provider: direct owner access to the provider’s own records
- personal server: owner access to the aggregated/polyfilled records it stores

Externally, both should support owner-authenticated reads using the same RS conventions.

### Grant enforcement

- native provider: enforced against native records
- personal server: enforced against collected/normalized records

Externally, both should return the same grant-shaped projection behavior.

## 6. Concrete reference split for the repo

For the reference implementation, the clean split is:

- `Northstar HR`
  - expose only the shared AS/RS surface
  - no public connector/runtime API

- `Personal server`
  - expose the shared AS/RS surface
  - additionally expose Collection Profile operational endpoints for its runtime

- `Longview` and CLI
  - consume the shared AS/RS surface
  - should not depend on connector/runtime endpoints for normal data access

- `Control plane / operator tooling`
  - may consume polyfill operational endpoints
  - may inspect connector and runtime state
  - should not redefine the client-facing PDPP contract

## 7. Practical route guidance for the current `e2e` substrate

Given the current `reference-implementation/server` routes, the clean near-term move is:

- keep the existing AS/RS routes as the shared core reference surface
- treat `/connectors` and `/v1/state` as polyfill-only operational routes
- treat `/v1/ingest/:stream` as Collection Profile operational surface, not native RS surface
- avoid introducing `connector_id` into the canonical external request, grant, or query model
- keep the request-shape cutover and pending-consent persistence work shared across both realizations

## Bottom line

The native and polyfill paths should share:

- requester identity model
- selection-request model
- grant lifecycle
- token model
- stream and record query model
- self-export semantics

They should differ in exactly one major way:

- only the polyfill path exposes collection/runtime operational seams

That keeps the reference implementation honest:

- native path proves PDPP can exist without connectors
- polyfill path proves PDPP can be realized before universal native adoption
- Longview and the CLI still see one coherent PDPP contract
