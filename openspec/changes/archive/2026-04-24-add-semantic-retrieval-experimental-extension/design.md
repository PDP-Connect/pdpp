# Design — Semantic Retrieval Experimental Extension

**Status:** design draft (non-normative working notes for this change)
**Date:** 2026-04-23
**Owner decision inputs:**
- `design-notes/semantic-retrieval-experimental-extension-2026-04-23.md` (owner target)
- `design-notes/semantic-retrieval-status-options-2026-04-23.md` (status: experimental optional extension)
- `design-notes/surface-status-ladder-2026-04-23.md` (rubric)
- `design-notes/capability-discovery-options-2026-04-22.md` (layered server + stream discovery)
- `design-notes/semantic-retrieval-metadata-carrier-2026-04-23.md` (RS metadata as carrier; no new capability document)
- `design-notes/lexical-retrieval-launch-worker-brief-2026-04-23.md` (lexical floor, untouched)
- `add-polyfill-connector-system/design-notes/semantic-retrieval-surface-open-question.md` (full option space)
- `add-polyfill-connector-system/design-notes/pdpp-trust-model-framing.md` (owner-agent vs third-party client framing)
- `add-polyfill-connector-system/design-notes/owner-self-export-open-question.md` (derived-artifact boundary)
- `add-polyfill-connector-system/design-notes/authored-artifacts-vs-activity-open-question.md` (derived-artifact ownership)
- `apps/web/content/docs/spec-data-query-api.md` (current public query API conventions)

## 1. Status rung: experimental optional extension

Semantic retrieval sits on the **optional extension** rung of the surface-status ladder, but with one additional modifier this rubric does not yet have a dedicated rung for: **experimental / unstable**.

The difference from a stabilized extension:

- a stabilized extension commits the protocol to not breaking its contract silently
- an experimental extension commits the protocol to *naming the surface publicly* and *declaring that the contract may still break*

That difference is carried in capability metadata as `stability: "experimental"` (see §6). It is not just a doc-site adjective. Clients that read the advertisement MUST see the instability marker and MAY refuse to depend on the surface without fallback.

This change commits the protocol to:

- a named, publicly discoverable capability family: `semantic-retrieval`
- resource-server metadata advertisement + per-stream metadata declaration
- an explicit, machine-readable experimental/unstable marker
- no ecosystem assumption of availability unless advertised
- no silent protocol gravity from the reference's operational embeddings/ANN choice
- **no modification of the approved lexical retrieval contract**

Promotion to stabilized extension, and separately to core, is out of scope for this tranche. Promotion criteria are captured in `semantic-retrieval-status-options-2026-04-23.md`.

## 2. Endpoint shape: dedicated `GET /v1/search/semantic`

### 2.1 Why a dedicated route instead of extending `/v1/search`

The lexical retrieval tranche (`add-lexical-retrieval-extension`) committed `GET /v1/search` to a specific public contract:

- lexical-only matching
- explicit rejection of semantic/vector parameters as `invalid_request_error`
- no portable numeric score
- candidate-reference result shape

Mutating that contract — for example by adding `mode=semantic` or `rank=hybrid` to `/v1/search` — would:

1. Reopen the approved lexical contract that is intentionally being stabilized.
2. Force the stable lexical surface to carry capability facts about a fast-moving experiment.
3. Make the lexical retrieval extension's explicit "reject semantic/vector parameters" requirement a lie.
4. Make it impossible to retract or revise the semantic surface without destabilizing lexical retrieval at the same time.

Dedicated route wins:

- Semantic retrieval lives at `GET /v1/search/semantic`.
- Lexical retrieval lives at `GET /v1/search`.
- The two routes are siblings. Neither aliases to nor falls through to the other.
- The semantic surface can be revised, versioned, or pulled without touching the lexical contract.

### 2.2 Why `GET`, not `POST`, in v1

Mirrors the lexical-retrieval rationale:

- `GET` stays cacheable at the proxy layer for repeated queries.
- `q=` is small in practice; v1 does not require a request body.
- A richer future `POST /v1/search/semantic` body-DSL (e.g., structured filters, per-field weighting) can be a later, separately-versioned extension without breaking `GET`.

### 2.3 Why cross-stream, candidate-reference shape

Agents think cross-stream first (`find anything about X`). Candidate references avoid prematurely entangling semantic retrieval with field-projection semantics that the existing record-listing contract already owns. The shape stays close to lexical retrieval so agents do not have to learn two result grammars.

### 2.4 Query parameters (v1)

| Parameter | Required | Type | Notes |
|---|---|---|---|
| `q` | yes | string | The text query. Opaque to clients beyond "semantic match against authorized declared semantic fields, using the server's declared model". No raw vectors. No client-supplied embeddings. |
| `limit` | no | integer | Default and maximum declared in capability metadata (`default_limit`, `max_limit`). |
| `cursor` | no | string | Opaque semantic-search pagination cursor. MUST NOT reuse record-list, `changes_since`, or lexical-search cursors. |
| `streams[]` | no | repeated string | Optional stream-scope narrowing. Grant semantics mirror lexical retrieval (§4): client tokens with an unauthorized stream get `grant_stream_not_allowed`; owner tokens treat `streams[]` as a soft cross-connector filter. |

**Not in v1 (every one of these MUST be rejected with `invalid_request_error`)**:

- `vector=...` or any raw vector input
- `embedding=...` or any client-supplied embedding input
- `model=...`, `model_id=...`, `model_family=...`, or any model-selector parameter
- `rank=...`, `boost=...`, `weights=...`, `blend=...`, or any ranking-knob parameter
- `connector_id=...` (see §4.4)
- `filter[...]`, `filter[{field}][gte]`, etc.
- `fields`, `expand[]`, `expand_limit[...]`
- `order=` (semantic relevance ordering is implied; any alternative would be a later extension, not a silent widening)
- connector-specific parameters (any parameter whose meaning branches on connector identity)
- DSL-shaped parameters (`query=`, `body=`, nested JSON-in-a-querystring)

Rejecting rather than silently ignoring unknown parameters is how truthfulness is enforced on the experimental surface: a parameter that "seems to work but quietly doesn't" is exactly the failure mode experimental extensions are supposed to avoid.

### 2.5 Authentication and versioning

The endpoint follows the existing `spec-data-query-api.md` conventions:

- `Authorization: Bearer <access_token>` (grant-bound for client tokens; owner-token for owner self-export)
- `PDPP-Version` date header
- `Request-Id` echoed in the response

No new auth scheme. No capability-specific auth. Deployments that want to restrict semantic retrieval do so via grant scope on the normal scope vocabulary, not through a custom semantic-retrieval-only auth path.

## 3. Result shape: candidate references with a clearly experimental marker

### 3.1 Envelope

Reuse the existing list envelope (`object: "list"`, `has_more`, `next_cursor`, `data[]`). Agents already learned it for record listing and lexical retrieval.

### 3.2 `search_result` object (semantic variant)

```json
{
  "object": "search_result",
  "stream": "messages",
  "record_key": "msg_123",
  "connector_id": "https://registry.pdpp.org/connectors/messaging-app",
  "record_url": "/v1/streams/messages/records/msg_123",
  "emitted_at": "2026-04-23T12:34:56Z",
  "matched_fields": ["text"],
  "snippet": {
    "field": "text",
    "text": "...overdraft charges..."
  },
  "retrieval_mode": "semantic"
}
```

For owner-token callers on a resource server that scopes owner reads per connector (the reference implementation does this today), `record_url`, when emitted, includes the canonical owner-mode connector scope, identical to the lexical retrieval pattern:

```json
{
  "object": "search_result",
  "stream": "transactions",
  "record_key": "txn_42",
  "connector_id": "https://registry.pdpp.org/connectors/usaa",
  "record_url": "/v1/streams/transactions/records/txn_42?connector_id=https%3A%2F%2Fregistry.pdpp.org%2Fconnectors%2Fusaa",
  "emitted_at": "2026-04-23T12:34:56Z",
  "matched_fields": ["description"],
  "retrieval_mode": "hybrid"
}
```

Field-by-field rationale:

- `object: "search_result"` — intentionally shared with lexical retrieval. Agents should not have to parse `object: "semantic_search_result"` and `object: "search_result"` as separate types. The surface is what differentiates the results, not a renamed envelope.
- `stream` + `record_key` — explicit so agents know exactly what to fetch next.
- `connector_id` — required on every result, same rationale as lexical retrieval: hydrations are per-connector, and owner-mode reads are scoped per connector on the RS.
- `record_url` — OPTIONAL. When emitted, MUST resolve to the canonical `GET /v1/streams/{stream}/records/{record_key}` endpoint for the same (stream, record_key). For owner-token callers on a per-connector RS, the URL MUST carry the canonical owner-mode `connector_id` query parameter.
- `emitted_at` — the record's emission timestamp, reused from record metadata. NOT a relevance signal, and NOT a semantic score.
- `matched_fields` — subset of (declared `semantic_fields`) ∩ (grant-readable fields). For semantic retrieval this is a best-effort attribution: the server names the declared fields whose content contributed to the hit. Implementations that cannot honestly attribute to a declared field SHOULD return `matched_fields: []` rather than invent a false attribution.
- `snippet` — OPTIONAL, grant-safe. Constraints identical to lexical retrieval: the snippet text MUST be drawn only from fields in the caller's grant that the stream declared as `semantic_fields`. "Embed everything, surface a compact paraphrase" is not permitted; snippet text MUST be verbatim substrings of authorized field content, not model-generated text.
- `retrieval_mode` — **experimental field**, REQUIRED. Values in v1 are `"semantic"` (pure vector/ANN match) and `"hybrid"` (semantic blended with lexical). This is the one explicitly experimental field the owner brief sanctions. Its purpose is to make the experimental mixed-mode story legible: a client that received a `"hybrid"` result can tell the server blended, and a later tranche can refine or rename this field without breaking the core candidate-reference shape.

### 3.3 What is intentionally NOT in the result shape in v1

- **No portable numeric score.** Not `score`, not `cosine`, not `bm25`, not `blend`. Different servers running different models cannot produce comparable numbers, and exposing a number would invite clients to compare incomparable things. Promoting relevance to a numeric contract is reserved for a future tranche with a stable cross-implementation definition or explicit opt-out.
- **No debug/trace fields** (`_debug`, `_explain`, `_vector_distance`) in the public shape. Reference implementations are free to expose these under `/_ref/*` surfaces, but they MUST NOT appear on the public extension.
- **No model-hash or embedding-revision stamps per-result.** The configured model is declared once at the capability-metadata level (§6). Per-result stamps would be a premature commitment to per-record embedding versioning (option V2 in the semantic-retrieval open question) which the owner has deliberately deferred.

### 3.4 Ordering

Results are returned in server-chosen relevance order. Higher-positioned results SHOULD generally be more relevant to `q` than lower-positioned results. No portable numeric ordering contract. No order parameter in v1.

## 4. Authorization and grant semantics

### 4.1 Grant-safe search paths

Identical invariants to lexical retrieval, restated here so the semantic surface is not a loophole:

- Streams outside the caller's grant contribute zero hits.
- Fields outside the grant projection are never embedded for query matching, never considered in ranking, and never contribute text to snippets, even if the stream declared them in `semantic_fields`.
- Fields not declared in `semantic_fields` are never embedded for query matching, even if the grant would allow reading them.

The extension searches only over the intersection:

```
(stream in grant) ∩ (field in grant projection) ∩ (field in stream.query.search.semantic_fields)
```

### 4.2 The "embed everything, filter later" loophole is prohibited

An implementation MUST NOT:

- Embed records across every field and apply grant filtering only after vector recall.
- Return snippets drawn from fields outside the intersection above and rely on a UI layer to mask them.
- Run ANN against an index that covers fields outside the intersection and then post-filter hits.

The index and query path MUST respect field-level enforcement *before* any text leaves the grant boundary. If this is incompatible with a particular backend's indexing strategy, that backend SHOULD maintain per-field indexes or per-grant-shape indexes rather than breaking the invariant.

Equivalent rephrasing in conformance terms: *no declared semantic field is ever a proxy channel for an undeclared field*. An implementation that cannot structurally uphold that invariant SHOULD NOT ship the extension.

### 4.3 Snippets are verbatim grant-safe substrings

Snippets:

- MUST be verbatim substrings of authorized + declared fields.
- MUST NOT be model-generated summaries, paraphrases, or synthesized text.
- MAY be omitted per-result at the server's discretion without changing the rest of the shape.

This is stricter than it looks: snippets from a semantic surface are tempting to render as "AI-summarized for you." Doing so would blur the disclosure contract (what was the model given as input?), which would then blur the grant-safety contract.

### 4.4 Owner-token vs client-token `streams[]` (parity with lexical retrieval)

- **Client-token callers**: naming an unauthorized stream in `streams[]` is a hard `permission_error` with code `grant_stream_not_allowed`. Silent omission would hide grant violations.
- **Owner-token callers**: `streams[]` is a soft cross-connector filter. Naming a stream no owner-visible connector exposes simply yields zero hits from that stream, not an error. Naming no `streams[]` means "search across every owner-visible connector."
- **No public `connector_id` query parameter in v1.** Owner-token callers identify the hit's originating connector via the `connector_id` field on each result, not by pre-scoping the query. Passing `connector_id=...` in the query string MUST be rejected as `invalid_request_error`, same as the lexical retrieval rule.

## 5. Declared field model: `query.search.semantic_fields`

### 5.1 Why opt-in per field

Embedding is far more opinionated than lexical indexing:

- Embedding a binary blob field requires deciding how to turn the blob into text, which is connector-specific.
- Embedding a nested structured field requires deciding how to flatten it, which is schema-specific.
- Embedding a field that is PII-sensitive without the owner's explicit opt-in would be a silent disclosure.

Opt-in per field via `query.search.semantic_fields` keeps the extension aligned with the same truthfulness bar set by lexical retrieval's `lexical_fields`.

### 5.2 Declaration shape (v1)

```json
{
  "query": {
    "search": {
      "semantic_fields": ["text", "subject", "body"]
    }
  }
}
```

This co-exists with `lexical_fields`. A stream may declare one, the other, both, or neither:

```json
{
  "query": {
    "search": {
      "lexical_fields": ["text", "subject"],
      "semantic_fields": ["text", "body"]
    }
  }
}
```

The two declarations are independent. A field that is lexical-searchable is not automatically semantic-searchable, and vice versa. This is deliberate: making one imply the other would obscure the opinionated opt-in semantic retrieval requires.

### 5.3 v1 scope constraints

- Top-level scalar **string** fields only.
- No nested paths (`body.parts[].text`), no arrays, no blobs, no connector-specific semantics.
- Every entry MUST refer to a field present in the stream's schema.
- Entries that do not satisfy these constraints MUST be omitted by the implementation rather than silently mis-indexed.

### 5.4 Streams that do not participate

A stream that does not participate in semantic retrieval omits `query.search.semantic_fields`. If `query.search` exists only to declare `lexical_fields`, that is fine; `semantic_fields` is independently optional. Searches that include a non-participating stream simply contribute zero hits from that stream (no per-stream error signal — this matches lexical retrieval).

## 6. Capability discovery: `capabilities.semantic_retrieval`

### 6.1 Carrier

Same carrier as lexical retrieval: the `capabilities.semantic_retrieval` object is published inside the **existing resource-server metadata document** (the unauthenticated document already used to publish OAuth-shaped metadata and the `capabilities.lexical_retrieval` advertisement).

Rationale:

- Clients already probe that document for lexical retrieval.
- `capability-discovery-options-2026-04-22.md` recommends small server-level additions rather than a new capability document.
- `semantic-retrieval-metadata-carrier-2026-04-23.md` explicitly recommends the existing RS metadata document as the carrier and rejects adding a new capability document for this tranche.
- Co-locating both capability objects makes the advertisement consistent, auditable, and cacheable through the same HTTP layer.

No new top-level document. No AS-metadata layering. No new discovery protocol.

### 6.2 Shape (v1)

```json
{
  "capabilities": {
    "semantic_retrieval": {
      "supported": true,
      "stability": "experimental",
      "endpoint": "/v1/search/semantic",
      "cross_stream": true,
      "query_input": "text",
      "snippets": true,
      "lexical_blending": false,
      "model": "<server-declared-model-id>",
      "dimensions": 1024,
      "distance_metric": "cosine",
      "default_limit": 25,
      "max_limit": 100,
      "index_state": "built",
      "language_bias": {
        "primary": "en",
        "note": "Model has documented reduced recall for CJK scripts"
      }
    }
  }
}
```

Required keys when `supported: true`:

- `supported` — boolean
- `stability` — MUST be the string `"experimental"` in v1. A future stabilized tranche would move this to `"stable"`; silently dropping the field is not permitted.
- `endpoint` — path resolvable on the same resource server; `/v1/search/semantic` unless the RS is mounted under a path prefix.
- `cross_stream` — boolean. Whether `GET /v1/search/semantic` without `streams[]` is supported.
- `query_input` — MUST be the string `"text"` in v1. Enumerated so a future tranche could add `"vector"` or `"hybrid"` without breaking clients that already understand `"text"`.
- `snippets` — boolean. Whether the server MAY return snippets (same contract as lexical retrieval: never grant-unsafe).
- `lexical_blending` — boolean. Whether the server blends lexical signal into ranking. When `true`, results MAY carry `retrieval_mode: "hybrid"`; when `false`, results MUST carry `retrieval_mode: "semantic"`.
- `model` — string identifier. This is the one public declaration that acknowledges an opinionated choice: clients who care about model provenance can read it. The value is a server-declared string; the protocol does NOT standardize a registry of model identifiers. Servers SHOULD use the vendor's published canonical identifier when one exists.
- `dimensions` — integer. Declared for index-state truthfulness. Servers that never accept raw vector input (which is all v1 servers) MAY still declare it; it helps operators and owners reason about re-embedding cost.
- `distance_metric` — string, one of `cosine`, `dot`, `l2`. Same rationale as `dimensions`: declared for truthfulness, not for client query construction.
- `default_limit`, `max_limit` — integers. Parallel to lexical retrieval.
- `index_state` — one of `built`, `building`, `stale`. See §6.3.

Optional keys:

- `language_bias` — an object with at minimum `primary` (BCP-47 tag) and a free-form `note`. Published when the configured model has materially known locale/language bias.

### 6.3 `index_state` values

- `built` — the semantic index over the declared `semantic_fields` is up to date within the server's rebuild cadence.
- `building` — the server is currently (re)building the index; the endpoint MAY return partial or empty results.
- `stale` — the server's declared model or declared `semantic_fields` have changed in a way that invalidates existing index coverage; the extension is best-effort while `stale` is reported, and the server MAY return empty or partial results. The server MUST NOT substitute lexical-only matching (or any other non-semantic fallback) behind the semantic surface while continuing to advertise `retrieval_mode: "semantic"` or `"hybrid"` on results — doing so would make the public result-shape contract dishonest. Clients that depend on semantic recall SHOULD treat `stale` as "this extension is best-effort right now" and MAY fall back to the lexical retrieval surface themselves.

This is an intentionally small vocabulary. It does **not** promise rebuild semantics, per-record revision stamps, or deterministic "re-embed on next write" behavior. It only tells clients whether the advertised contract is currently honest.

### 6.4 What the advertisement does NOT do

- It does NOT enumerate per-stream `semantic_fields`. That lives in per-stream metadata (§5).
- It does NOT enumerate concurrent models. One model per advertisement. A future tranche may change this; v1 keeps it one-to-one to avoid committing to multi-model semantics now.
- It does NOT become a generalized capability-statement document. It is `capabilities.semantic_retrieval`, sibling to `capabilities.lexical_retrieval`.
- It does NOT grow grant-bound fields. Like the lexical advertisement, the semantic advertisement is discoverable without a bearer token.

### 6.5 Relationship to lexical retrieval advertisement

The two advertisements are independent. A server MAY advertise only lexical retrieval, only semantic retrieval, both, or neither. A client MUST NOT infer one from the presence of the other.

## 7. Pagination semantics

### 7.1 Opaque cursors, independent from all other pagination

- `GET /v1/search/semantic` returns `has_more` and `next_cursor` (opaque).
- Clients pass `next_cursor` back verbatim as `cursor`.
- Semantic-search cursors are **distinct** from:
  - record-list cursors on `GET /v1/streams/{stream}/records`
  - `changes_since` cursors
  - lexical-search cursors on `GET /v1/search`
- A cursor from one of those surfaces MUST NOT be accepted by the others.

### 7.2 Non-promises

Pagination progress is best-effort within one semantic-search session (same `q`, same `streams[]`, same grant). It is not promised to survive:

- server restart
- index rebuild
- model change
- grant change
- reranker change

Stale cursors MAY be rejected with `invalid_cursor`; clients recover by issuing a fresh search. This aligns with lexical retrieval's pagination posture and keeps the server free to rebuild semantic indexes without owing every in-flight client a stable continuation.

## 8. Ranking posture and non-promises

### 8.1 Promise

Results are relevance-oriented: higher-positioned results SHOULD generally be more relevant to `q` than lower-positioned results.

### 8.2 Non-promises (protocol-level)

The following are explicitly NOT portable contract in v1:

- BM25 scores, cosine distances, or any portable numeric relevance score.
- A specific embedding model, a specific tokenizer, or a specific similarity metric implementation.
- A specific lexical-blending formula when `lexical_blending: true`.
- A specific reranker (cross-encoder, ColBERT, LLM reranker, etc.).
- A specific ANN strategy (HNSW, IVF-PQ, flat) or recall-vs-latency knob.
- Recency blending or per-connector weighting.
- Stability of ranking across model upgrades or index rebuilds.

### 8.3 What is implementation-defined (see §9)

Everything in §8.2 is intentionally implementation-defined. The stable boundary is:

- declared capability facts (§6)
- declared semantic fields (§5)
- grant-safe paths (§4)
- request shape (§2)
- result shape (§3)

Inside that boundary, implementations keep their hackability.

## 9. What is implementation-defined

The extension intentionally leaves the following hackable behind the declared boundary:

- exact embedding backend (OpenAI API, local `llama.cpp`, sentence-transformers, Cohere, bring-your-own)
- exact vector/index backend (sqlite-vec, pgvector, FAISS, HNSWlib, Turbopuffer, external service)
- ANN strategy and recall/latency tuning
- tokenizer and text-chunking details (sentence splitting, overlap, max chunk length)
- reranker details (none, cross-encoder, LLM-as-reranker)
- lexical-blending formula when `lexical_blending: true` (RRF, linear blend, learned blend)
- batch/rebuild mechanics (incremental, nightly, owner-triggered)
- per-owner or per-deployment localized model selection
- index storage topology (co-located with records, separate store, CDN-fronted)
- whether embeddings are content-addressed or per-record (option V1–V4 in the open question — all three remain implementation-defined)

The rule, stated once more because it is the load-bearing principle of the whole change:

- implementation freedom behind the boundary
- truthful declaration at the boundary

## 10. What this extension does NOT promise

Explicit non-promises, repeated here so the conformance bar is unambiguous:

- **Not core.** Clients MUST NOT assume availability on unadvertised servers.
- **Not cross-server comparable.** Results between two servers running different models, or even the same model with different corpora or reranking, are not directly comparable.
- **No portable numeric score.** Result ordering is relevance-oriented; no cosine, no BM25, no blend number, no normalized score.
- **No canonical embedding export.** Self-export content is governed separately (`owner-self-export-open-question.md`, `authored-artifacts-vs-activity-open-question.md`). This extension does not pre-empt that decision by declaring embeddings canonical.
- **No entity resolution.** "The same person across Gmail and Slack" is a separate open question and not a semantic-retrieval guarantee.
- **No generalized vector API.** No raw vector query, no client-supplied embeddings, no ANN-direct surface.
- **Not a replacement for lexical retrieval.** Lexical retrieval remains the stable public retrieval floor. Generated/private connectors must still be able to succeed with lexical retrieval alone.

## 11. What makes this "experimental" rather than "stabilized"

The single-fact answer: the server's advertisement carries `stability: "experimental"` and the proposal/spec document that breaking revisions are acceptable during prelaunch.

The longer answer, for downstream maintainers deciding when to promote:

- The proving cycle described in `semantic-retrieval-status-options-2026-04-23.md` has not yet completed.
- We have not yet confirmed that the text-only query shape is the right public entry point long-term.
- We have not yet proven the capability-metadata vocabulary is sufficient for real third-party clients.
- The self-export story for derived artifacts (embeddings) is deliberately unresolved.
- The rebuild/version/drift story is only named (`index_state`), not standardized.

Any of those could force a contract change. The experimental marker is how we keep that door open without deceiving clients who depend on the surface.

Demotion criteria (experimental → reference-only or removed entirely):

- the grant-safety invariant cannot be upheld under real backends
- snippets cannot be kept verbatim and grant-safe at acceptable quality
- the metadata vocabulary cannot be made truthful enough to ship publicly
- the surface is not materially better than lexical retrieval alone

Promotion criteria (experimental → stabilized optional extension):

- one full proving cycle has shown a stable capability shape
- the discovery metadata is clear and sufficient for real third-party clients
- the rebuild/version/export story is no longer hand-wavy
- the surface is not lying about portability (it is not, and must not in any future revision, pretend to be cross-server comparable)

## 12. Interaction with adjacent open questions

### 12.1 Owner self-export (derived artifacts)

This change deliberately does NOT take a position on whether owner self-export includes embeddings as canonical content. The reference implementation MAY compute and store embeddings as an implementation detail; exposing them to owner self-export is a separate decision governed by `owner-self-export-open-question.md` and `authored-artifacts-vs-activity-open-question.md`. Clients MUST NOT assume that a semantic retrieval extension implies an embeddings-in-self-export contract.

This is why the spec declares `model`, `dimensions`, and `distance_metric` in capability metadata but does not standardize a self-export shape for embeddings.

### 12.2 Connector-specific semantics

Different connectors could in principle have rich connector-specific semantic signals (for example, a messaging connector's "reply-to" graph). This change intentionally does not expose connector-specific semantic semantics on the public surface. Connector-specific enrichment happens at the record/emit level and lands in declared semantic fields, not in a connector-gated branch of `GET /v1/search/semantic`.

### 12.3 Pdpp-trust-model framing

The design reads well under both framings in `pdpp-trust-model-framing.md`:

- **Owner-agent primary**: the owner configures the server-side model; the agent queries text; results are grant-safe.
- **Third-party client primary**: the client reads `capabilities.semantic_retrieval`, learns the model and stability posture, and decides whether to depend on the extension or fall back to lexical retrieval.

The same contract serves both. The `stability: "experimental"` marker is especially useful in the third-party frame, where the client otherwise has no protocol-level way to discover the experimental status.

### 12.4 Lexical retrieval as the stable floor

`add-lexical-retrieval-extension` is the floor. This change does not weaken it and does not depend on it for semantic correctness. A client that the server advertises both extensions MAY legitimately choose to issue both a lexical and a semantic query and merge results client-side; the protocol does not legislate that choice.

## 13. Reference implementation strategy (non-normative)

Intended for the future implementation tranche. Not part of the public contract.

- Backing store: a locally-hostable vector index (candidate: `sqlite-vec` alongside the existing SQLite store used by the reference). The choice is not normative.
- Model: a server-configured embedding provider (candidate: a local embedding model for default-offline runs; a hosted provider behind explicit operator opt-in). The choice is not normative and MUST be reflected in `capabilities.semantic_retrieval.model`.
- Index maintenance: per the lexical retrieval approach, maintained in JS at record write/update/delete call sites with a startup rebuild safeguard for drift recovery. MUST respect `semantic_fields` as the sole source of truth for what is embedded.
- Drift reporting: the reference SHOULD compute `index_state` honestly — when `semantic_fields` changes, or when the configured model changes, the advertised `index_state` MUST reflect the resulting degraded mode (`stale`) until rebuild.
- Reference-only artifacts: any `/_ref/*` semantic experiments (e.g., debug score dumps, model-output inspection) MUST remain reference-only and MUST NOT be aliased as the public extension. Same pattern as `/_ref/search` vs `/v1/search`.

Nothing above is normative protocol behavior. A different implementation is free to ship a completely different backend as long as it respects the declared boundary.

## 14. Truthfulness cleanup

This tranche is comparatively small on truthfulness cleanup because lexical retrieval's own tranche is already clearing most of the ambient search drift. The only cleanup items this tranche introduces:

- `apps/web/content/docs/spec-data-query-api.md` — when the lexical tranche's rewrite of the "richer cross-stream search via `POST /v1/search`" wording lands, this tranche adds (or allows a follow-up tranche to add) a short, clearly-labeled experimental pointer: "Semantic retrieval is available as an experimental extension at `GET /v1/search/semantic`. It is unstable and not part of the stable public contract." The pointer MUST surface the experimental marker; the doc SHOULD NOT describe `GET /v1/search/semantic` and `GET /v1/search` as interchangeable.
- Any dashboard, docs, or operator UI that will eventually consume semantic retrieval MUST NOT be described as a public claim of semantic retrieval support before the reference actually advertises it in RS metadata. Until then, dashboard use of semantic retrieval SHOULD be scoped to reference-only surfaces.
- No existing public contract is asked to move to accommodate this change. In particular, `GET /v1/search`, `GET /v1/streams/{stream}/records`, `/_ref/search`, and the existing resource-server metadata carrier are all unmodified by this tranche.

## 15. Stop-and-report conditions for future workers on this change

A later worker applying this change MUST stop and re-open the design rather than widening the contract if any of the following become necessary:

- raw vector queries (`vector=...`) are needed for the first public shape
- semantic retrieval can only work by mutating `GET /v1/search`
- a broader new capability-statement document appears required
- grant-safe snippets seem impossible under the chosen backend
- the metadata vocabulary cannot be made truthful enough for public exposure
- the conclusion is that semantic retrieval must be core, or must be a stabilized (non-experimental) extension, in this same tranche
- connector-specific semantic parameters seem required
- multiple concurrent embedding models need to be advertised on one RS in one contract
- a portable numeric relevance score appears necessary

These are the same failure modes the owner brief enumerates. They are load-bearing: widening the contract silently under any of these pressures defeats the entire point of shipping this as an experimental, revisable extension rather than as core.
