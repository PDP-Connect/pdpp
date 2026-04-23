# Design — Lexical Retrieval Extension

**Status:** design draft (non-normative working notes for this change)
**Date:** 2026-04-23
**Owner decision inputs:**
- `design-notes/lexical-retrieval-launch-worker-brief-2026-04-23.md` (owner target)
- `design-notes/lexical-retrieval-status-options-2026-04-23.md` (status: optional extension)
- `design-notes/surface-status-ladder-2026-04-23.md` (rubric)
- `design-notes/capability-discovery-options-2026-04-22.md` (layered server + stream discovery)
- `design-notes/control-plane-search-lexical-index-open-question-2026-04-22.md` (current reference branch)
- `apps/web/content/docs/spec-data-query-api.md` (current public query API)

## 1. Status rung: optional extension

This capability sits on the **optional extension** rung of the surface-status ladder:

- public (unlike `/_ref/*`)
- discoverable via capability metadata (unlike silent reference behavior)
- not yet mandatory (unlike core)
- portable enough to define honestly
- carries no opinion on embedding models, ranking math, or tokenizer

That rung commits this change to:

- named capability family: `lexical-retrieval`
- resource-server metadata advertisement + per-stream metadata declaration
- no ecosystem assumption of availability unless advertised
- no silent protocol gravity from the reference's operational FTS5 index

Promotion to core is out of scope for this tranche (see `lexical-retrieval-status-options-2026-04-23.md`).

## 2. Endpoint shape: dedicated cross-stream `GET /v1/search`

### 2.1 Why dedicated, not a new parameter on record listing

The owner target is explicit: search is a distinct operation, not a decoration on record listing.

Arguments against reusing `GET /v1/streams/{stream}/records`:

- Agents want to search cross-stream first and narrow later.
- Record listing already carries grant-bound `filter[...]`, `fields`, `expand[]`, expansion limits, and a non-relevance sort contract. Overloading it with `q=` conflates those semantics and forces a portable ranking contract onto a surface that historically promised deterministic cursor order.
- A dedicated endpoint keeps each surface's contract honest and keeps the door open for a future `POST /v1/search` body-DSL without renegotiating the existing listing API.

### 2.2 Why `GET`, not `POST`, in v1

- A `GET` keeps the surface cacheable at the proxy layer for repeated queries.
- `q=` is small in practice; the v1 shape does not require request bodies.
- If a later tranche needs rich boolean/predicate search, it is reserved as `POST /v1/search` (see "Deferred" in the proposal). The `GET` surface stays stable.

### 2.3 Query parameters (v1)

| Parameter | Required | Type | Notes |
|---|---|---|---|
| `q` | yes | string | The lexical query. Opaque to clients beyond "lexical match over authorized declared searchable fields". |
| `limit` | no | integer | Default 25, max 100. Same envelope as record listing for client ergonomics, but not a grant constraint. |
| `cursor` | no | string | Opaque search-pagination cursor. MUST NOT reuse record-list or `changes_since` cursors. |
| `streams[]` | no | repeated string | Optional stream-scope narrowing. If omitted, search runs across all authorized streams. If a named stream is not authorized, the request is rejected (`grant_stream_not_allowed`) rather than silently ignored. |

Not in v1:

- `rank=...`
- `filter[...]`, `filter[{field}][gte]` etc.
- `fields`, `expand[]`, `expand_limit[...]`
- `order=` (search is relevance-ordered; any later change would be an extension, not a silent widening)
- connector-specific parameters
- any semantic/vector parameter

### 2.4 Authentication and versioning

The endpoint follows the existing `spec-data-query-api.md` conventions:

- `Authorization: Bearer <access_token>` (grant-bound)
- `PDPP-Version` date header
- `Request-Id` echoed in the response

## 3. Result shape: candidate references, not hydrated records

### 3.1 Envelope

Reuse the existing list envelope (`object: "list"`, `has_more`, `next_cursor`, `data[]`) so agents do not learn a second pagination grammar.

### 3.2 `search_result` object

```json
{
  "object": "search_result",
  "stream": "messages",
  "record_key": "msg_123",
  "record_url": "/v1/streams/messages/records/msg_123",
  "emitted_at": "2026-04-23T12:34:56Z",
  "matched_fields": ["text"],
  "snippet": {
    "field": "text",
    "text": "...overdraft charges..."
  }
}
```

Rationale:

- `record_key` is explicit so agents know exactly what to fetch next without parsing URLs.
- `record_url` is OPTIONAL: implementations MAY include it for ergonomic hydration, MAY omit it. When emitted it MUST resolve to the canonical `GET /v1/streams/{stream}/records/{record_key}` endpoint for the same `stream` and `record_key`. Recommended in v1 because it eliminates a client-side URL templating step, but never required.
- `matched_fields` lists which **declared searchable** fields matched; it is a subset of that declaration, never a raw reflection of server-side index internals.
- `snippet` is optional per result. When emitted, it references a single `matched_fields` entry and contains only text the caller is authorized to read.
- `score` and any numeric rank are intentionally absent in v1. Portable numeric scoring would require freezing a specific ranking formula across implementations; the brief prohibits that.

### 3.3 Why not return full records

Returning hydrated records would:

- prematurely couple search to the record-listing field/projection contract
- force implementations to re-run grant field-projection in the search path
- make it impossible to decouple ranking cost from hydration cost at the server

Candidate references let the client use record listing or single-record reads with its existing projection choices.

## 4. Authorization and grant safety

### 4.1 Invariants

For a given caller `C` and grant `G`:

1. A stream `s` contributes zero hits if `s` is not in `G`.
2. A field `f` of stream `s` is searched for `C` only if:
   - `s` declares `f` in `query.search.lexical_fields`, AND
   - `f` is readable under `G` (i.e., present in the grant's effective field projection for `s`).
3. Matched-field lists MUST be a subset of the intersection of (declared searchable) ∩ (readable under grant).
4. Snippets MUST NOT include substrings drawn from fields outside that intersection. Implementations SHOULD source snippet text by re-reading the record under the caller's grant-projected view, not from a raw index backing store.
5. If a stream has an empty searchable ∩ authorized set for this caller, the stream contributes zero hits and is otherwise invisible to search.

This is the most important honesty boundary: the extension MUST NOT become a second disclosure path outside grant enforcement. If safe snippets cannot be produced under these invariants, a conforming implementation MUST omit the `snippet` field rather than widen disclosure.

### 4.2 Non-goal: filter-later enforcement

A conforming implementation MUST NOT search over unauthorized fields and then "filter results later." That pattern risks leaking through observable side channels (result existence, ordering, latency). Field-level gating MUST happen before the field contributes to matching.

### 4.3 Authorization errors

- `grant_stream_not_allowed` — `streams[]` names a stream not in the grant.
- `permission_error` / `grant_expired` / `grant_revoked` — reuse existing `spec-data-query-api.md` codes.
- No new error type is introduced for "no searchable+authorized fields for this caller"; that case returns an empty result list, because the same call would be legal on a stream that had declared no searchable fields at all.

## 5. Searchable-field declaration: stream-level

### 5.1 Shape

Stream metadata (the existing per-stream `GET /v1/streams/{stream}` body) gains an optional nested object:

```json
{
  "query": {
    "search": {
      "lexical_fields": ["text", "subject", "snippet"]
    }
  }
}
```

Interpretation:

- `query.search` is present iff this stream participates in lexical retrieval.
- `lexical_fields` is the set of top-level scalar textual fields the stream declares searchable.
- A stream MAY participate in the extension with an empty `lexical_fields` only in the sense that it is still advertised as "search-aware" (for example, to signal the connector has been evaluated and intentionally exposes nothing). In practice, the recommended form is to omit `query.search` entirely for streams that do not participate.

### 5.2 Scope of `lexical_fields` in v1

Allowed:

- top-level scalar string fields defined by the stream's `schema`
- string fields whose schema shape is straightforwardly textual

Not allowed in v1:

- nested JSON paths
- arrays of strings
- blob/`blob_ref` content
- connector-specific searchable semantics masquerading as lexical fields
- any field not declared in the stream's schema

If a worker or implementer concludes that nested paths or arrays are essential, the correct move is to stop, surface the contradiction, and propose a follow-up change — not to widen the launch shape unilaterally (see the brief's stop conditions).

### 5.3 Why stream-level and not a global document

Per `capability-discovery-options-2026-04-22.md`, stream metadata is the authoritative place for stream-specific query power. A global per-field registry would:

- duplicate information the stream already owns
- create drift between stream schema and global registry
- encourage a broader capability document the project has intentionally deferred

## 6. Resource-server capability advertisement: small, global-only

### 6.1 Carrier

The advertisement is carried inside the **existing resource-server metadata document** the project already publishes for OAuth-shaped resource-server metadata. The extension does not introduce a new metadata document and does not live on the authorization server.

Rationale for picking the RS metadata document specifically:

- `/v1/search` is a resource-server endpoint, not an AS endpoint. Co-locating the advertisement with the surface it describes minimizes drift.
- The RS metadata document is already discoverable without a grant, which is a hard requirement for client/agent onboarding (a client must be able to decide whether to attempt the extension before negotiating a token).
- It mirrors the layered server + stream discovery model preferred in `capability-discovery-options-2026-04-22.md` (SCIM-style global service config + per-resource discovery), without introducing a new top-level document.

This decision is now part of the contract, not deferred. If a later tranche concludes the carrier should move (for example, into a dedicated `/v1/capabilities` document), that move is a separately-tracked change, not an unspecified implementation choice.

### 6.2 Shape

```json
{
  "capabilities": {
    "lexical_retrieval": {
      "supported": true,
      "endpoint": "/v1/search",
      "cross_stream": true,
      "snippets": true,
      "default_limit": 25,
      "max_limit": 100
    }
  }
}
```

Interpretation:

- `supported: true` advertises that the extension is present on this server. A non-supporting server MUST either omit `capabilities.lexical_retrieval` entirely or set `supported: false`.
- `endpoint` is the portable contract endpoint path. It MUST resolve on the same resource server. It SHALL be `/v1/search` unless the resource server is mounted under a path prefix, in which case the prefix SHALL be reflected.
- `cross_stream` reports whether omitting `streams[]` is supported; if `false`, clients MUST always send at least one `streams[]` entry.
- `snippets` reports whether snippets are ever emitted.
- `default_limit` / `max_limit` are informational and aligned with the per-request `limit` parameter.

When `supported: true`, all of `endpoint`, `cross_stream`, `snippets`, `default_limit`, and `max_limit` are required keys, so clients can shape requests without trial-and-error. Missing keys make the advertisement invalid, and clients MAY treat them as if `supported: false`.

### 6.3 What this advertisement is NOT

It MUST NOT:

- re-enumerate per-stream `lexical_fields`
- describe per-stream ranking
- duplicate schema information
- grow into a generalized capability-statement document
- depend on a bearer token for retrieval — it travels with the unauthenticated RS metadata document

If a future tranche justifies a broader document, that is a separate change per the rubric in `capability-discovery-options-2026-04-22.md`.

## 7. Ranking and ordering

v1 is deliberately vague about ranking internals. The only portable promises are:

- Results are lexical matches over authorized+declared-searchable fields.
- Results are returned in relevance-oriented order.
- Higher-ranked results should generally be more relevant than lower-ranked results.

v1 does NOT portably define:

- BM25 scores or any numeric scoring contract
- semantic reranking
- recency blending
- per-connector custom weighting
- tokenization rules beyond "lexical"

Any richer ordering contract is a future change.

## 8. Pagination

### 8.1 Why a separate cursor grammar

Search results are not ordered by `(cursor_field, primary_key)`; they are ordered by relevance within a query session. Reusing record-list cursors would imply:

- stable chronological progression (which search does not guarantee)
- index-aligned monotonicity (which relevance ranking does not have)

### 8.2 Contract

- `next_cursor` is opaque.
- Within a single client-facing search session (same `q`, same `streams[]`, same grant), cursoring MUST progress stably enough to avoid obvious duplication and infinite loops. Implementations MAY snapshot a result set at the first page to achieve this.
- `changes_since` is not supported on `/v1/search`. Agents that need change-driven retrieval should continue to use record-list `changes_since` on hydrated streams.
- Cursors are not promised to survive server restarts, grant changes, or index rebuilds.

## 9. Reference implementation plan (non-normative)

This section describes how the reference will realize the contract. It is intentionally *not* part of the portable contract; another PDPP implementation MAY use Postgres FTS, OpenSearch, an in-memory engine, etc.

### 9.1 Backing store

The reference will use **SQLite FTS5**.

Rationale:

- The reference already runs on SQLite.
- The existing `_ref/search` optimistic branch already demonstrates FTS5 viability inside the reference.
- FTS5 is fully local, which matches the reference's local-first trust model.

Explicitly out of scope:

- sqlite-vec
- pgvector
- external search services
- semantic embeddings

### 9.2 Index scope in the reference

- Index only fields declared by streams in `query.search.lexical_fields`. Do not index unauthorized-by-declaration fields.
- Maintain index via SQLite triggers on the `records` table, with a startup rebuild safeguard for drift recovery (mirroring the `_ref/search` experiment's maintenance model).
- Treat the index as a derived artifact: it is rebuildable from records, and retention/deletion flow through records first.

### 9.3 Separation from `/_ref/search`

- `/_ref/search` stays reference-only: operator/artifact/id jump, not a retrieval contract.
- `/v1/search` is the public retrieval surface.
- The reference MAY share index infrastructure behind the scenes, but MUST NOT advertise `_ref/search` as the public surface and MUST NOT document the two as the same contract.

### 9.4 Dashboard behavior

Once the extension ships, the dashboard's current brute-force text fan-out MUST be replaced by calls to `/v1/search` (or an equivalent internal helper over the same enforcement path). The fan-out is explicitly redescribed as a temporary reference-only fallback, not a public retrieval claim.

## 10. Truthfulness cleanup created by this change

The current repo has three identifiable sources of retrieval drift:

1. **`/_ref/search` overclaims.** Any wording that suggests `/_ref/search` is a public retrieval surface must be corrected. It is an operator/artifact/id-jump helper only.
2. **Dashboard brute-force search.** Today this is a fan-out substring scan in application code. Docs that imply this is a general search capability must be narrowed; the dashboard adopts the extension once it ships.
3. **`spec-data-query-api.md` deferral wording.** The existing "richer cross-stream search could be added later via `POST /v1/search`" note predates this decision. That wording must be rewritten to:
   - Direct public lexical retrieval to this extension at `GET /v1/search`.
   - Reserve `POST /v1/search` only as a possible future DSL-bearing surface, clearly marked as not-yet-spec'd.

None of these cleanups require widening the public contract; they only require making the existing docs match the decisions in this change.

## 11. Portable contract vs implementation-defined behavior

Explicit split so promotion/demotion decisions are cheap later.

**Portable contract (spec):**
- Extension name, discoverability, endpoint path, method, query parameters
- `search_result` shape
- Grant-safety invariants
- `query.search.lexical_fields` declaration shape
- Server-level advertisement shape
- Opaque-cursor pagination semantics
- Non-existence of a portable numeric score in v1

**Implementation-defined (not contract):**
- Tokenization / analyzer
- Ranking formula
- Backing store (FTS5, Postgres FTS, etc.)
- Index maintenance strategy
- Cursor encoding
- Whether snippets are character- or token-windowed, and exact window size
- Whether a stream contributes to search at all (controlled by the stream's own `lexical_fields` declaration, not by the extension's advertisement)

## 12. Alternatives considered (and rejected)

- **Overload `/_ref/search`.** Rejected. Overloads a reference-only surface with a public contract, muddles the `_ref/*` status rung, and creates exactly the protocol-gravity problem the open-question note warned about.
- **Add `q=` to `GET /v1/streams/{stream}/records`.** Rejected. Conflates record listing's deterministic cursor contract with relevance ordering; pushes cross-stream search into per-stream fan-out on the client; blocks the clean future `POST /v1/search` path.
- **Start with `POST /v1/search` and a body-DSL.** Rejected for v1. Locks in a DSL before we have evidence we need one; harder to cache; the brief explicitly prefers the smallest honest public contract.
- **Global searchable-fields registry document.** Rejected. Duplicates stream metadata; drifts; contradicts `capability-discovery-options-2026-04-22.md` (layered server + stream, not a broad capability document).
- **Mandatory core in this tranche.** Rejected per `lexical-retrieval-status-options-2026-04-23.md`: the need is real, but the shape is not yet ecosystem-proven enough to force on every implementation.
- **Expose portable numeric relevance scores in v1.** Rejected. Would force a specific ranking formula or create meaningless cross-implementation numbers. Can be added later once we have evidence.
- **Search unauthorized fields and filter later.** Rejected. Creates a shadow disclosure path and an observable side channel. Non-negotiable.

## 13. Acceptance bar (answers to the brief's gating questions)

1. **What exact fields are searched?** Only fields that are both (a) declared in the stream's `query.search.lexical_fields` and (b) readable under the caller's grant.
2. **How does grant enforcement constrain search?** Streams outside the grant contribute zero hits; fields outside grant projection are never searched for that caller; snippets never quote ungranted text; unauthorized `streams[]` is a hard error.
3. **What can a third-party client discover before trying the endpoint?** The server-level capability advertisement (support flag, endpoint, `cross_stream`, `snippets`, limits) plus per-stream `query.search.lexical_fields` via existing stream metadata.
4. **Why lexical and not ambient generic search?** Lexical retrieval avoids embedding/model/language-lock-in and has a tractable portable shape; semantic retrieval does not.
5. **Why extension, not core?** The need is real but the shape is not yet ecosystem-proven; forcing it everywhere now would freeze a contract we might need to evolve. The ladder says "extension" is the right rung today.
6. **How is `/v1/search` different from `/_ref/search`?** `/v1/search` is public, portable, grant-enforced, discoverable, and lexical-retrieval-shaped. `/_ref/search` is reference-only, artifact/id-jump-shaped, and makes no interoperability claim.
7. **What is portable vs implementation-defined?** See §11.

## 14. Stop conditions honored

The following brief-level stop conditions did NOT trigger during this design pass; if a future worker hits any of them, they MUST stop and re-open the design rather than widen this change:

- semantic/vector retrieval becoming necessary
- a broader new discovery document seeming required
- connector-specific search behavior seeming required
- unauthorized-field search + filter-later seeming necessary
- safe snippets appearing impossible under the current model
- concluding this must be core rather than an extension
