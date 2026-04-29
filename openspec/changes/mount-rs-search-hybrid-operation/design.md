## Context

`define-reference-operation-environments` established that AS/RS behavior should live behind canonical operation capsules. The `mount-rs-search-lexical-operation` and `mount-rs-search-semantic-operation` slices extracted the single-surface retrieval endpoints to operations. Hybrid retrieval is the next surface in the sequence; it is the composition layer over the existing lexical and semantic surfaces, defined by `define-hybrid-retrieval/specs/hybrid-retrieval/spec.md`.

The current state of the route:

- Native Fastify `GET /v1/search/hybrid` is already a thin route handler that delegates to `runHybridSearch` in `server/search-hybrid.js`. The route is registered only when BOTH lexical and semantic retrieval are advertised on this server (`hybridLexicalAvailable && hybridSemanticAvailable`); otherwise the route is omitted and the corresponding `capabilities.hybrid_retrieval` advertisement is omitted from `/.well-known/oauth-protected-resource`. `runHybridSearch` mixes the public-contract slice (allowlist + cursor rejection + forbidden-parameter list, `q`-required, `limit` clamping, `streams[]` normalization, `filter[...]` coupling, sub-request fan-out, round-robin merge with dedup by `(connector_id, stream, record_key)`, per-source score forwarding under `scores`, `retrieval_mode: "hybrid"` and `retrieval_sources` provenance, list-envelope shape, and `disclosure.served` data block) with the imports of `runLexicalSearch` (`server/search.js`) and `runSemanticSearch` (`server/search-semantic.js`).
- There is no sandbox hybrid route. The sandbox advertises lexical retrieval only and does not register a semantic surface.
- Hybrid is the only retrieval surface that does NOT support cursor pagination in v1 (the spec's explicit pagination choice; clients that need paging beyond `limit` should fall back to the individual lexical or semantic endpoints).

This change does not rewrite `server/search-hybrid.js` broadly. It extracts the public-contract slice from `runHybridSearch` into an operation capsule and reduces `runHybridSearch` to a thin native dependency-wiring shell around the existing `runLexicalSearch` / `runSemanticSearch` runners. Hybrid is NOT a new grant-logic path — grant enforcement remains inside the underlying runners.

## Goals / Non-Goals

**Goals:**

- Define a canonical `rs.search.hybrid` operation module whose semantics are independent of HTTP framework, sandbox UI, concrete database driver, the native lexical helper module (`server/search.js`), the native semantic helper module (`server/search-semantic.js`), the native hybrid helper module (`server/search-hybrid.js`), and `process.env`.
- Mount the operation from the native Fastify reference server.
- Preserve `GET /v1/search/hybrid` response shape, error codes (including the explicit `cursor` rejection and the explicit forbidden-parameter list), per-hit `retrieval_mode: "hybrid"`, per-hit `retrieval_sources` provenance (subset of `["lexical", "semantic"]`, lexical-first order), per-source `scores` map shape (each entry is the underlying surface's score object verbatim; no normalization; no flat `score` field on individual hybrid hits), dedup semantics (`(connector_id, stream, record_key)`), grant filtering through the underlying runners, stream/filter query semantics, and disclosure-spine shape (`query_shape: 'search_hybrid'`, `record_count`, `has_more`, `mode`, `lexical_count`, `semantic_count`) exactly.
- Keep advertisement gating where it is today — the native route remains registered only when both lexical and semantic retrieval are advertised on this server.
- Preserve grant-enforcement delegation: the operation invokes the lexical and semantic runners through capability dependencies; it does NOT itself enforce grant projection, stream-grant intersection, field-grant intersection, or record-level grant constraints — those remain inside the underlying runners.

**Non-Goals:**

- Do not introduce hybrid cursor pagination. v1 hybrid rejects the `cursor` parameter explicitly and the operation envelope SHALL NOT carry `next_cursor`.
- Do not change scoring semantics. Per-hit hybrid hits expose per-source scores under a `scores` map keyed by source name; each value is the underlying surface's score object (e.g. `{kind: "bm25", value, order}` for lexical, `{kind: "semantic_distance", value, order}` for semantic). The operation SHALL NOT normalize across surfaces and SHALL NOT introduce a flat `score` field on hybrid hits.
- Do not introduce a new grant-logic path. The operation does not compile a plan, build a snapshot, persist a snapshot, or read records; it consumes already-grant-filtered per-source result envelopes.
- Do not change lexical or semantic operation contracts.
- Do not refactor `server/search-hybrid.js` outside the `runHybridSearch` shell.
- Do not add a sandbox `/sandbox/v1/search/hybrid` route. The sandbox today advertises lexical retrieval only.

## Decisions

### 1. The operation owns the host-independent public-contract slice

The operation owns:

- strict v1 query-param allowlist (`q`, `limit`, `streams`, `streams[]`, `filter`); rejects unknown keys with `invalid_request` and `param: <key>`;
- explicit `cursor` rejection: any `cursor` parameter on the wire ⇒ `invalid_request` with `param: 'cursor'`. This is intentionally stricter than the lexical/semantic surfaces, which DO support cursor. The rejection is part of the public contract pinned by the existing `hybrid-retrieval.test.js` "v1 hybrid rejects cursor" and "lexical/semantic cursors are rejected by hybrid" scenarios;
- explicit forbidden-parameter list (`vector`, `embedding`, `embed`, `model`, `model_id`, `model_family`, `rank`, `boost`, `weights`, `blend`, `connector_id`, `fields`, `expand`, `expand[]`, `expand_limit`, `expand_limit[]`, `order`, `sort`, `mode`); each rejected with `invalid_request` and `param: <key>`;
- `q` non-empty required → `invalid_request` with `param: 'q'`;
- `limit` clamp (default 25, min 1, max 100);
- `streams[]` normalization (string or array, trim, drop empty, return null when empty);
- `filter[...]` requires exactly one `streams[]` value → `invalid_request` with `param: 'streams'`;
- mode classification (`owner` vs `client`) from the actor;
- per-source fan-out via the `runLexical` and `runSemantic` capability dependencies. The operation passes the parsed sub-request params (`{q, limit, streams, filter}`) verbatim and lets each runner enforce advertisement, grant projection, stream-grant intersection, field-grant intersection, and any record-level grant constraints. Errors from either runner propagate unchanged — hybrid behaves identically to calling the underlying endpoints for the same grant (e.g. `grant_stream_not_allowed` from semantic surfaces through hybrid as well);
- round-robin merge of the two per-source result lists, preserving per-source rank order so neither surface dominates the first page;
- dedup by `(connector_id, stream, record_key)` with the dedup map preserving insertion order (so overlapping hits get the best available rank from whichever source surfaced them first);
- `matched_fields` union across sources without duplication (lexical-first discovery order so the field order is reproducible across runs);
- per-source `scores` map: each entry is the underlying surface's score object forwarded verbatim. The operation SHALL NOT emit a flat `score` field on hybrid hits, SHALL NOT normalize values across surfaces, and SHALL NOT mutate the underlying score objects;
- first-non-empty snippet preservation: the dedup map keeps the first non-empty snippet encountered (lexical snippets are highlighted; semantic snippets are verbatim excerpts; either is informative; the operation does not invent a combined one);
- `retrieval_sources` provenance: subset of `["lexical", "semantic"]`, in lexical-first order so the shape is stable across runs;
- `retrieval_mode: "hybrid"` on every emitted hit;
- list-envelope shape (`object: 'list'`, `has_more`, `data: []`) — the host adds the host-shaped `url` field. v1 hybrid intentionally omits `next_cursor`; the operation envelope type does NOT carry it;
- limit application AFTER dedup+merge so hybrid never returns fewer hits than requested purely because of cross-source overlap. `has_more` honestly reports merged-list truncation; since v1 hybrid has no cursor, `has_more` is informational only;
- `disclosure.served` data block (`query_shape: 'search_hybrid'`, `record_count`, `has_more`, `mode`, `lexical_count`, `semantic_count`).

Adapter-bound concerns stay behind dependencies:

- `runLexical(params)` → per-source result envelope from the lexical runner under the caller's grant;
- `runSemantic(params)` → per-source result envelope from the semantic runner under the caller's grant.

The native shell wires these against `runLexicalSearch` (in `server/search.js`) and `runSemanticSearch` (in `server/search-semantic.js`), each invoked with a synthetic sub-request that carries the parsed hybrid params verbatim. Grant enforcement, plan compilation, snapshot orchestration, ranking, snippet hydration, and record-url formatting all live inside those underlying runners; hybrid does NOT duplicate them.

### 2. Hosts still own auth, instrumentation, and response writing

The host adapter retains:

- token authentication (`requireToken`);
- request id / trace id assignment;
- the registration gate (route mounted only when both lexical and semantic retrieval are advertised on this server);
- `query.received` / `disclosure.served` event emission and `rejectQuery` error mapping;
- response writing (Fastify `res.json`);
- the host-shaped `url` envelope field (`/v1/search/hybrid`).

Operation-thrown errors carry `code` (`invalid_request`) and may carry `param` (`cursor`, `q`, `streams`, or any forbidden / unknown key) so the host adapter can map them through the existing error envelopes (`rejectQuery`, `handleError`) without re-deriving the rules. Errors from the underlying runners propagate unchanged — `grant_stream_not_allowed` and any other code surface identically through hybrid as they do on the direct endpoints.

### 3. The operation module MUST NOT import host or storage concretes

Same boundary as the existing operations: no Fastify, Next, SQLite, Postgres, raw DB modules, sandbox UI, the native `server/search.js` helper module, the native `server/search-semantic.js` helper module, the native `server/search-hybrid.js` helper module, or `process` / `process.env`. The shared `operation-boundary.js` gate enumerates the operations directory and enforces the rule for every operation, including the new one. A per-operation boundary test additionally asserts that the operation does not statically import `server/search.js`, `server/search-semantic.js`, or `server/search-hybrid.js` so the no-back-door invariant is grep-visible at the operation boundary as well.

### 4. Public response shape is preserved

The change is structural, not behavioral. Native `GET /v1/search/hybrid` JSON envelopes MUST remain byte-equivalent. The existing `hybrid-retrieval.test.js` cases are the regression baseline — they continue to assert the advertisement gate (only when both surfaces are on), happy-path owner-token hybrid search across two streams, client-token grant projection through both surfaces, dedup of a record matching both sources with merged sources + scores, lexical-only and semantic-only provenance, the v1 cursor rejection, the cross-surface cursor rejection (lexical and semantic cursors rejected by hybrid), no `next_cursor` in v1, the explicit forbidden-parameter list, `q`-required, and that the underlying `/v1/search` and `/v1/search/semantic` response shapes are unchanged when hybrid is advertised.

### 5. No sandbox hybrid route in this slice

The current sandbox host advertises lexical retrieval only and does not register a semantic surface. A sandbox hybrid route would require both a sandbox semantic fixture (still out of scope per the semantic-operation slice's decision) and a truthful hybrid advertisement; silently mounting a hybrid route over a single-surface sandbox dataset would advertise a capability the sandbox does not in fact serve. This change preserves the current state.

### 6. Native `runHybridSearch` keeps the lexical/semantic runner imports

The native `runHybridSearch` shell continues to compose `runLexicalSearch` and `runSemanticSearch`. Lifting that wiring up into the route handler would re-introduce the same drift surface this slice is removing. Inside `runHybridSearch`, the public-contract slice now delegates to `executeSearchHybrid`. `parseHybridSearchParams` is kept exported as a delegating shim that translates the operation's typed `SearchHybridRequestError` into the previous plain-`Error` shape (`err.code`, optional `err.param`) for any direct callers.

### 7. Hybrid is NOT a new grant-logic path

The operation MUST NOT enforce grant projection, stream-grant intersection, field-grant intersection, or record-level grant constraints. Those rules live inside `runLexicalSearch` and `runSemanticSearch`. Errors from either runner propagate unchanged. This invariant is realized at the operation boundary by the per-operation `server/search.js` and `server/search-semantic.js` import bans (the operation cannot reach into either underlying retrieval surface to re-implement grant logic on its own).

### 8. v1 hybrid scores are NOT normalized across surfaces

The underlying lexical and semantic surfaces use different score kinds (`bm25` vs `semantic_distance`), different orders (both currently `lower_is_better`, but the field is part of each underlying surface's contract), and different value semantics (implementation-relative vs distance). v1 hybrid SHALL NOT collapse them into a single value. Per-hit hybrid hits expose per-source scores under a `scores` map keyed by source name; each value is the underlying surface's score object forwarded verbatim. There is NO flat `score` field on hybrid hits — its presence would imply a normalization v1 does not perform.

## Risks / Trade-offs

- **Operation grows too broad.** Mitigation: the boundary above is the cap. The lexical and semantic runners stay behind capability dependencies; the operation only orchestrates parsing, fan-out, merge, dedup, and shaping.
- **Grant enforcement regresses.** Mitigation: the operation does NOT itself enforce grant rules. The per-operation `server/search.js` and `server/search-semantic.js` import bans pin this at the operation boundary. Errors from the underlying runners propagate unchanged.
- **Cursor support accidentally added.** Mitigation: the operation rejects `cursor` in the parser before any runner is invoked. The envelope type does NOT carry `next_cursor`. The existing `hybrid-retrieval.test.js` cases (cursor rejected; lexical/semantic cursors rejected; no `next_cursor` in v1) are the regression baseline.
- **Score normalization sneaks in.** Mitigation: the operation forwards per-source score objects verbatim under `scores[source]`. The hybrid result type explicitly omits a flat `score` field. An operation-level test pins both invariants.
- **Dedup order regresses.** Mitigation: the dedup map preserves insertion order (round-robin lexical-first), and `retrieval_sources` is emitted in lexical-first order. An operation-level test asserts both.
- **`retrieval_mode` field accidentally omitted.** Mitigation: the operation's `search_result` shape unconditionally sets `retrieval_mode: "hybrid"`. An operation-level test asserts the field appears on every hit.
- **Native instrumentation regresses.** Mitigation: the host retains ownership of `query.received`, `disclosure.served`, and `rejectQuery`. The operation only populates the `disclosureData` fields.
- **Worker invents architecture vocabulary.** Mitigation: names mirror existing operations (`executeSearchHybrid`, `SearchHybridDependencies`, `SearchHybridRequestError`).

## Migration Plan

1. Add the operation module and `reference-implementation/package.json` export.
2. Add native dependency wiring inside `runHybridSearch`. Keep the existing helper signature (`runHybridSearch({req, opts, tokenInfo, ...})`) so the route does not change call shape; internally, `runHybridSearch` builds a `SearchHybridDependencies` object that wraps `runLexicalSearch` and `runSemanticSearch` and calls `executeSearchHybrid`. The native route stays thin.
3. Demote `parseHybridSearchParams` to a delegating shim that calls `parseSearchHybridParams` and translates `SearchHybridRequestError` to the previous plain-`Error` shape.
4. Add operation-level tests, boundary tests (shared gate plus per-operation `server/search.js` / `server/search-semantic.js` / `server/search-hybrid.js` import demotion), and rerun targeted validation.

Rollback: the operation module is additive until the native shell is switched. If a regression is found before merge, revert the `runHybridSearch` rewiring and the `parseHybridSearchParams` shim.

## Open Questions

- Whether the native `runHybridSearch` shell should be deleted entirely once the route mounts the operation directly. Decision: keep `runHybridSearch` as the native dependency-wiring helper inside `server/search-hybrid.js`. It currently imports `runLexicalSearch` and `runSemanticSearch` and translates the operation's typed errors back into the existing plain-`Error` shape; lifting that wiring up into the route handler would re-introduce the same drift surface this slice is removing.
- Whether the sandbox should also expose hybrid search in this slice. Decision: no. The sandbox advertises lexical retrieval only and does not register a semantic surface; introducing a sandbox hybrid surface would require both a sandbox semantic fixture and a truthful hybrid advertisement, which is out of scope.
- Whether the operation should also own the explicit forbidden-parameter list and the `cursor` rejection, or leave them to the contract schema. Decision: own them. The handler-level `param` field is part of the public contract and the operation must remain the source of truth for it. This mirrors the existing behavior in `parseHybridSearchParams` and the operation-owned forbidden lists in lexical and semantic.
- Whether to expose advertisement gating (the route registration check for `hybridLexicalAvailable && hybridSemanticAvailable`) inside the operation. Decision: no. The advertisement gate decides whether the route exists at all; once the route is mounted, every request is by definition under a server that advertises both surfaces. Lifting the gate into the operation would either duplicate the host-level decision or push registration policy into the operation, neither of which is appropriate for a public-contract slice.
