## Context

`define-reference-operation-environments` established that AS/RS behavior should live behind canonical operation capsules, and the `mount-rs-search-lexical-operation` slice extracted the lexical surface to one. Semantic retrieval is the next surface in the sequence and is explicitly named in the parent design (Decisions §1 lists `rs.search.semantic` as a canonical operation; Contract Corrections §6 says `SemanticIndex` must expose backend identity, index kind, distance metric, model identity, and recall determinism, and that approximate vector indexes must not masquerade as exact recall).

The current state of the route:

- Native Fastify `GET /v1/search/semantic` is already a thin route handler that delegates to `runSemanticSearch` in `server/search-semantic.js`. `runSemanticSearch` accepts most resolution behaviors as injected functions (`resolveOwnerVisibleConnectorIds`, `resolveOwnerScopeForConnector`, `resolveOwnerManifestFromScope`, `buildOwnerReadGrantForManifest`, `resolveGrantManifest`), but the public-contract slice (allowlist with explicit forbidden parameters, advertisement gate, mode planning, cursor format with the `sem1.` prefix, snapshot orchestration with stale-cursor backend-identity check, slice math, envelope, disclosure data, and result shaping including `retrieval_mode` and snippet hydration) is mixed with embedding-backend, vector-index, ranking, and records-table snippet hydration helpers in the same module. Hosts other than the Fastify route cannot mount the public-contract slice without dragging the SQLite/sqlite-vec helpers, the embedding pipeline, and the records-table reads along.
- There is no sandbox semantic route. The sandbox advertises lexical retrieval only.

This change does not rewrite `server/search-semantic.js` broadly. It extracts the public-contract slice from `runSemanticSearch` into an operation capsule and reduces `runSemanticSearch` to a thin native dependency-wiring shell around the existing embedding/vector-index/snippet-hydration helpers. The no-silent-fallback invariant (`server/search-semantic.js` does not import from `server/search.js`) is preserved and is additionally gated at the new operation module: the operation SHALL NOT import either `server/search.js` or `server/search-semantic.js`.

## Goals / Non-Goals

**Goals:**

- Define a canonical `rs.search.semantic` operation module whose semantics are independent of HTTP framework, sandbox UI, concrete database driver, embedding-backend implementation, vector-index implementation, the native `server/search-semantic.js` helper module, and `process.env`.
- Mount the operation from the native Fastify reference server.
- Preserve `GET /v1/search/semantic` response shape, error codes (including the explicit forbidden-parameter list), cursor semantics (including the `sem1.` prefix and stale-cursor backend-identity rejection), per-hit score shape (exactly `{ kind: "semantic_distance", value, order: "lower_is_better" }` and nothing more), `retrieval_mode: "semantic"` per hit, grant filtering, stream/filter query semantics, and disclosure-spine shape exactly. Backend/profile/model identity disclosure stays on the capability surface (`capabilities.semantic_retrieval.score` at `/.well-known/oauth-protected-resource` continues to advertise `value_semantics`, `comparable_with`, model, dimensions, distance_metric, and where applicable profile_id/dtype); the operation does not synthesize that advertisement and the per-hit `score` object SHALL NOT carry capability-level metadata fields.
- Preserve the no-silent-fallback invariant: the operation SHALL NOT import `server/search.js` or `server/search-semantic.js`. The existing source-level test that pins this invariant on `server/search-semantic.js` continues to apply unchanged.

**Non-Goals:**

- Do not extract a production `SemanticIndex` interface. The operation accepts capability-shaped dependencies that wrap the existing embedding-backend, vector-index, snapshot, and snippet-hydration helpers.
- Do not change cursor opacity, the `sem1.` prefix, score advertisement, score-direction semantics, snippet shape, snippet grant-safety, grant filtering, request allowlist, or `filter[...]` coupling to `streams[]`.
- Do not introduce Postgres, pgvector, Kysely, or a generic `SearchProvider`.
- Do not normalize semantic and lexical score semantics together. Each retrieval surface keeps its own score kind, direction, and value semantics.
- Do not touch hybrid retrieval, attachment blobs, runs, traces, or `_ref` routes.
- Do not refactor `server/search-semantic.js` outside the `runSemanticSearch` shell.
- Do not add a sandbox `/sandbox/v1/search/semantic` route. The sandbox's advertised capability set continues to declare lexical retrieval only. A truthful mock-backed semantic fixture with explicit capability metadata is a separate, future change.

## Decisions

### 1. The operation owns the host-independent public-contract slice

The operation owns:

- strict v1 query-param allowlist (`q`, `limit`, `cursor`, `streams`, `streams[]`, `filter`); rejects unknown keys with `invalid_request` and `param: <key>`;
- explicit forbidden-parameter list (`vector`, `embedding`, `embed`, `model`, `model_id`, `model_family`, `rank`, `boost`, `weights`, `blend`, `connector_id`, `fields`, `expand`, `expand[]`, `expand_limit`, `expand_limit[]`, `order`, `sort`, `mode`); each rejected with `invalid_request` and `param: <key>` (the contract-schema layer at the route may also reject some of these without `param`; this layer remains the source of `param` truth, mirroring the existing native behavior);
- `q` non-empty required → `invalid_request` with `param: 'q'`;
- `limit` clamp (default 25, min 1, max 100);
- `streams[]` normalization (string or array, trim, drop empty, return null when empty);
- `filter[...]` requires exactly one `streams[]` value → `invalid_request` with `param: 'streams'`;
- cross-stream advertisement gate: when capability metadata says `cross_stream: false`, `streams[]` is required;
- mode classification (`owner` vs `client`) from the actor;
- client-mode `streams[] ⊆ grant.streams` enforcement → `grant_stream_not_allowed` for any disallowed stream;
- owner-mode soft `streams[]` filter (no error on unknown stream);
- cursor encode/decode with the `sem1.` prefix (the body is base64url JSON `{snap, off}`); malformed prefix or body → `invalid_cursor`;
- snapshot orchestration: on a fresh request, build a snapshot via the dependency, persist it, slice the first page; on a cursor request, load the snapshot via the dependency, slice from the cursor offset; produce `next_cursor` when more results exist;
- backend-identity stale-cursor detection: the loaded snapshot's `backend_hash` is compared against the current backend identity returned by `getCurrentBackendIdentity()`; any divergence ⇒ `invalid_cursor` (the previous "cursor predates a backend identity change" rejection);
- score-advertisement gate: emit per-result `score` only when capability metadata advertises `score.supported: true`, `score.kind: "semantic_distance"`, and `score.order: "lower_is_better"`. The emitted per-hit `score` object carries exactly `{ kind, value, order }`; capability-level fields such as `value_semantics`, `comparable_with`, `model`, `dimensions`, `distance_metric`, `profile_id`, `dtype`, and `backend_identity` are advertised once at `capabilities.semantic_retrieval.score` and SHALL NOT be repeated on individual hits;
- `search_result` shape (`object: "search_result"`, `stream`, `record_key`, `connector_id`, `record_url`, `emitted_at`, `matched_fields`, `retrieval_mode: "semantic"`, optional `snippet`, optional `score`); `record_url` is delegated to the host through a `formatRecordUrl({stream, recordKey, connectorId, isOwner})` capability; `emitted_at` and `snippet` are delegated to a `hydrateResult({hit, isOwner})` capability so the records-table read stays in the native dependency and snippets remain grant-safe verbatim substrings of the matched field;
- list-envelope shape (`object: 'list'`, `has_more`, `next_cursor?`, `data: []`) — the host adds the host-shaped `url` field;
- `disclosure.served` data block (`query_shape: 'search_semantic'`, `record_count`, `has_more`, `mode`, `connector_count`).

Storage- and adapter-bound concerns stay behind dependencies:

- `getAdvertisement()` → capability metadata (controls cross-stream and score gates);
- `getCurrentBackendIdentity()` → opaque current backend identity hash, compared against the snapshot's stored hash for stale-cursor detection;
- `listOwnerVisibleConnectorIds()` → connector ids for owner fan-out;
- `resolveOwnerManifestForConnector(connectorId)` → manifest or null (null = skip this connector, e.g. broken polyfill manifests);
- `buildOwnerReadGrantForManifest(manifest)` → synthetic owner read grant;
- `resolveClientManifest({kind:'client', grant})` → manifest the client grant resolves against;
- `buildSearchPlanForGrant({manifest, grant, streamsFilter, filter, filteredStream, connectorId})` → plan entries for one connector (the `SemanticIndex`-shaped capability — backend-owned, owns field-grant intersection, candidate-record narrowing, scope-key derivation);
- `buildSnapshot({q, perConnectorPlans, isOwner})` → `{snapshot_id, backend_hash, results}` (embedding, KNN, ranking lives here);
- `persistSnapshot(snapshot)` / `loadSnapshot(snapshotId)` → snapshot store; `loadSnapshot` returns null on expired/missing;
- `hydrateResult({hit, isOwner})` → `{emittedAt, snippet?}` per hit; snippet is a grant-safe verbatim substring of the matched field's stored value (no paraphrase, summary, or model-generated text);
- `formatRecordUrl({stream, recordKey, connectorId, isOwner})` → string; native semantic hits use `/v1/streams/<stream>/records/<id>` with `?connector_id=` for owner mode, byte-equivalent to the previous behavior.

The native shell wires these against `server/search-semantic.js` helpers (existing embedding backends, sqlite-vec / blob-flat indexes, snapshot tables, records-table snippet hydration). No new sandbox host is wired in this slice.

### 2. Hosts still own auth, instrumentation, and response writing

The host adapter retains:

- token authentication (`requireToken`);
- request id / trace id assignment;
- `query.received` / `disclosure.served` event emission and `rejectQuery` error mapping;
- response writing (Fastify `res.json`);
- the host-shaped `url` envelope field (`/v1/search/semantic`);
- the schema-level allowlist (contract schema `additionalProperties: false`) which may reject some forbidden parameters before they reach the operation; the operation remains the source of truth for `err.param` on the handler-level path, mirroring the previous behavior.

Operation-thrown errors carry `code` (`invalid_request`, `invalid_cursor`, `grant_stream_not_allowed`) and may carry `param` so the host adapter can map them through the existing error envelopes (`rejectQuery`, `handleError`) without re-deriving the rules.

### 3. The operation module MUST NOT import host or storage concretes

Same boundary as the existing operations: no Fastify, Next, SQLite, Postgres, raw DB modules, sandbox UI, the native `server/search-semantic.js` helper module, the native `server/search.js` helper module, or `process` / `process.env`. The shared `operation-boundary.js` gate enumerates the operations directory and enforces the rule for every operation, including the new one. A per-operation boundary test additionally asserts that the operation does not statically import either `server/search.js` or `server/search-semantic.js` so the no-silent-fallback invariant is grep-visible at the operation boundary as well.

### 4. Public response shape is preserved

The change is structural, not behavioral. Native `GET /v1/search/semantic` JSON envelopes MUST remain byte-equivalent. The existing `semantic-retrieval.test.js` cases are the regression baseline — they continue to assert the advertisement shape, list envelope, `retrieval_mode: "semantic"`, score kind/order/value-semantics, snippet verbatim-substring property, grant-safe snippet, owner cross-connector fan-out, owner record_url round-trip, owner `connector_id=` rejection, `next_cursor` round-trip, the `sem1.` cursor prefix and the cross-surface lexical-cursor rejection, the no-fallback source-level invariant, restart persistence, and drift-rebuild behavior.

### 5. No sandbox semantic route in this slice

The current sandbox host advertises lexical retrieval only and does not register a semantic route. This change preserves that. Adding a sandbox semantic route is acceptable only as a truthful mock-backed semantic fixture with explicit capability metadata (per owner guidance), which is a separate change. Silently mounting the operation against the existing demo dataset with a stub embedding backend would mean advertising a sandbox semantic capability the sandbox does not in fact serve today, which would be a fork of the kind operation extraction is meant to prevent.

### 6. Native `runSemanticSearch` keeps backfill, drift, and snippet hydration

The native `runSemanticSearch` shell continues to compose owner fan-out, client grant manifest resolution, embedding-backend selection, vector-index choice (sqlite-vec vs blob-flat), snapshot persistence, and snippet hydration against the live SQLite store. Lifting that wiring up into the route handler would re-introduce the same drift surface this slice is removing. Inside `runSemanticSearch`, the public-contract slice now delegates to `executeSearchSemantic`. `parseSemanticSearchParams` is kept exported as a delegating shim that translates the operation's typed `SearchSemanticRequestError` into the previous plain-`Error` shape (`err.code`, optional `err.param`) so existing direct importers (notably `semantic-retrieval.test.js`) continue to receive the same error shape. Backfill, drift detection, embedding-backend factories, and the no-fallback invariant remain in `server/search-semantic.js`.

## Risks / Trade-offs

- **Operation grows too broad.** Mitigation: the boundary above is the cap. Embedding pipeline, vector-index implementations, snapshot bytes, FTS-equivalent ranking helpers, and records-table snippet reads stay in the dependency. The operation only orchestrates, slices, and shapes.
- **Snippet grant safety regresses.** Mitigation: `hydrateResult` is the only path that produces snippet text; the operation never reads record content. The native dependency continues to derive snippets only from the matched field's stored value via `pickVerbatimExcerpt`, and the existing verbatim-substring property test pins the contract.
- **Backend identity stale-cursor check regresses.** Mitigation: the operation's snapshot orchestration unconditionally compares the loaded snapshot's `backend_hash` against `getCurrentBackendIdentity()`; any mismatch raises `invalid_cursor`. The native dependency continues to compute identity over `(profile, model, dtype, dimensions, distance_metric)`.
- **`retrieval_mode` field accidentally omitted.** Mitigation: the operation's `search_result` shape unconditionally sets `retrieval_mode: "semantic"`. An operation-level test asserts the field appears on every hit.
- **Native instrumentation regresses.** Mitigation: the host retains ownership of `query.received`, `disclosure.served`, and `rejectQuery`. The operation only populates the `disclosureData` fields.
- **Cursor format accidentally aligns with lexical.** Mitigation: the operation owns `encodeSearchSemanticCursor` / `decodeSearchSemanticCursor` with the literal `sem1.` prefix; the existing cross-surface test (a lexical cursor passed to `/v1/search/semantic` ⇒ `invalid_cursor`) is preserved.
- **Score advertisement misfires.** Mitigation: the score gate is a pure function of `getAdvertisement()`. The native dependency returns the same advertisement helper; the operation only emits `score` when the advertisement is `kind: "semantic_distance"` lower-is-better.
- **No-fallback invariant erodes.** Mitigation: the existing source-level test on `server/search-semantic.js` is preserved unchanged. The new operation module is additionally checked against `server/search.js` and `server/search-semantic.js` import bans.
- **Worker invents architecture vocabulary.** Mitigation: names mirror existing operations (`executeSearchSemantic`, `SearchSemanticDependencies`, `SearchSemanticRequestError`).

## Migration Plan

1. Add the operation module and `reference-implementation/package.json` export.
2. Add native dependency wiring inside `runSemanticSearch`. Keep the existing helper signature (`runSemanticSearch({req, opts, tokenInfo, ...})`) so the route does not change call shape; internally, `runSemanticSearch` builds a `SearchSemanticDependencies` object from the existing helpers (`buildSemanticSearchPlanForGrant`, `buildSemanticSnapshot`, `persistSemanticSnapshot`, `loadSemanticSnapshot`, the records-table snippet hydration, and the backend-identity hasher) and calls `executeSearchSemantic`. The native route stays thin.
3. Demote `parseSemanticSearchParams` to a delegating shim that calls `parseSearchSemanticParams` and translates `SearchSemanticRequestError` to the previous plain-`Error` shape.
4. Add operation-level tests, boundary tests (shared gate plus per-operation `server/search.js` / `server/search-semantic.js` import demotion), and rerun targeted validation.

Rollback: the operation module is additive until the native shell is switched. If a regression is found before merge, revert the `runSemanticSearch` rewiring and the `parseSemanticSearchParams` shim.

## Open Questions

- Whether the native `runSemanticSearch` shell should be deleted entirely once the route mounts the operation directly. Decision: keep `runSemanticSearch` as the native dependency-wiring helper inside `server/search-semantic.js`. It currently composes owner fan-out, client grant manifest resolution, embedding-backend selection, vector-index choice, snapshot persistence, snippet hydration, and the backend-identity hasher against the live SQLite store; lifting that wiring up into the route handler would re-introduce the same drift surface this slice is removing.
- Whether the sandbox should also expose semantic search in this slice. Decision: no. The sandbox today advertises lexical retrieval only and does not register a semantic route. Adding a sandbox semantic route is acceptable only as a truthful mock-backed semantic fixture with explicit capability metadata; that is a separate change.
- Whether the operation should also own the explicit forbidden-parameter list, or leave it to the contract schema. Decision: own it. The contract schema (`additionalProperties: false`) may also reject these, but the handler-level `param` field is part of the public contract and the operation must remain the source of truth for it. This mirrors the existing behavior in `parseSemanticSearchParams`.
