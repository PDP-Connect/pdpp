# Worker Brief — Public Lexical Retrieval Launch Shape — 2026-04-23

**Status:** owner execution brief  
**Audience:** worker agent preparing the next public retrieval/search tranche  
**Purpose:** define the exact lexical retrieval shape I want PDPP to publicly launch with, without widening into semantic retrieval or a giant generalized query system.

This is not a brainstorming note. Treat it as the target shape unless you find a concrete contradiction with existing code or specs.

## Owner decision

We should publicly launch **lexical retrieval** as an **optional extension**, not as ambient reference behavior and not as mandatory core PDPP.

That means:

- the reference implementation should ship it for real
- clients should be able to discover it and depend on it when advertised
- the base core protocol should not yet require it everywhere
- semantic/vector retrieval is explicitly out of scope for this tranche

## Why this is the launch shape

This choice is grounded in the current evidence:

- current PDPP core does not define lexical retrieval
- current mainline search surfaces are materially inadequate for agent navigation
- the problem is real enough that valid clients/agents fall back to SQLite
- lexical retrieval is much less opinionated than semantic retrieval
- lexical retrieval still needs a public contract, not just a better reference helper

So the right posture is:

- **more public than reference-only**
- **less committed than core**

## What to build

### 1. Public status

Treat lexical retrieval as a **named optional extension/capability family**, not as:

- silent reference magic
- a `_ref` convenience
- a semantic/vector feature
- a generic predicate DSL

### 2. Public endpoint

Launch with a dedicated **cross-stream** endpoint:

`GET /v1/search`

Required query parameters:

- `q` — required lexical query string

Allowed v1 query parameters:

- `q`
- `limit`
- `cursor`
- `streams[]` — optional repeated stream-scope narrowing

Do **not** add in v1:

- semantic/vector parameters
- `rank=...`
- arbitrary field filters on the search endpoint
- nested query DSL
- connector-specific search params

Reasoning:

- search is a distinct operation, not just a decoration on record listing
- agents think cross-stream first
- a dedicated endpoint keeps the contract honest
- we can add richer `POST /v1/search` later if needed

### 3. Result shape

Return **candidate references**, not fully hydrated records.

Recommended v1 response shape:

```json
{
  "object": "list",
  "url": "/v1/search",
  "has_more": true,
  "next_cursor": "opaque",
  "data": [
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
  ]
}
```

Constraints:

- `record_key` must be explicit so result consumers know exactly what to fetch next
- `record_url` is good and should be included if easy
- `matched_fields` should identify which declared searchable fields matched
- `snippet` is optional per result, but supported in the launch shape
- do **not** expose a normative numeric relevance score in v1

Reasoning:

- ordering can still be relevance-ordered without freezing a portable score contract
- agents need enough context to avoid blind N+1 fetches
- returning fully hydrated records would prematurely entangle search with view/fields projection semantics

### 4. Authorization and grant semantics

This is the most important honesty boundary.

The lexical retrieval extension must search only over:

- streams the caller is authorized to read
- fields the caller is authorized to read
- fields the stream declares as searchable

Concretely:

- if a stream is not granted, it contributes no hits
- if a field is not granted, it is not searched for that caller
- if a field is not declared searchable, it is not searched
- snippets must never reveal text from ungranted fields

If a stream has zero searchable+authorized fields for a given caller, that stream simply contributes no hits.

This extension must **not** create a second disclosure path outside grant enforcement.

### 5. Searchable field model

Use **stream-level declaration** for searchable fields.

The declaration belongs under stream query metadata, not in a giant global capability document.

Launch target:

```json
{
  "query": {
    "search": {
      "lexical_fields": ["text", "subject", "snippet"]
    }
  }
}
```

v1 scope:

- top-level textual fields only
- no nested paths
- no arrays
- no blobs
- no connector-specific semantics

If a worker believes arrays or nested paths are essential, stop and report rather than widening the launch shape unilaterally.

### 6. Capability discovery

Use the layered discovery model we already prefer:

- **stream metadata** declares per-stream searchable fields
- a **small server-level capability layer** declares that the search family exists at all and how to use it globally

Do **not** invent a broad new capability document.

The server-level layer should only answer global facts like:

- lexical search is supported
- endpoint location
- whether cross-stream search is supported
- whether snippets are supported
- global max limit / default limit if needed

It should **not** duplicate per-stream field declarations.

### 7. Ranking and ordering

v1 should be:

- lexical only
- server-ordered by lexical relevance
- intentionally vague about ranking internals

Portable promise:

- results are lexical matches over authorized searchable fields
- higher-ranked results should generally be more relevant than lower-ranked results

Do **not** in v1:

- define BM25 scores as portable numeric semantics
- define semantic reranking
- define recency blending or custom connector weighting as contract

### 8. Pagination

Pagination must exist from day one.

Requirements:

- opaque cursor
- stable page progression for one search session
- no promise that search cursors are monotonic timestamps

Do not reuse `changes_since`.
Do not pretend search pagination is the same as record-list pagination.

### 9. Reference implementation strategy

The reference implementation should use **SQLite FTS5** for this tranche.

Do not add:

- sqlite-vec
- pgvector
- external search service
- semantic embeddings

This tranche is lexical only.

### 10. Relationship to existing search surfaces

Do **not** overload or redefine `/_ref/search` in this public launch.

The intended split is:

- `/_ref/search` remains reference-only artifact/operator jump/search
- `/v1/search` becomes the public lexical retrieval extension

If docs or generated artifacts currently blur this, fix the truthfulness drift as part of the tranche.

## What not to build

Do not widen this into:

- semantic/vector search
- embedding generation/versioning
- cross-connector entity resolution
- generic boolean/predicate query algebra
- connector-specific search APIs
- a new dashboard-specific ad hoc search layer separate from the public extension

If you find yourself wanting any of those, stop and report.

## Required deliverables

### A. OpenSpec change

Start by drafting a dedicated OpenSpec change for the lexical retrieval extension.

It should include:

- `proposal.md`
- `design.md`
- `tasks.md`
- spec delta(s) in the appropriate capability doc(s)

Do not skip the change and jump straight to code.

### B. Public contract definition

The change must define, at minimum:

- endpoint shape
- query params
- result shape
- authorization semantics
- searchable-field declaration shape
- capability discovery shape
- pagination semantics
- what is explicitly out of scope

### C. Reference implementation plan

The change should describe how the reference will implement it using SQLite FTS5 without promising that every implementation must use SQLite.

### D. Truthfulness cleanup

The change must account for the current search drift:

- current `/_ref/search` overclaims
- current dashboard search is brute-force
- current docs/OpenAPI are not coherent

The launch tranche should leave the repo more truthful than it found it.

## Acceptance bar

Before claiming the design is ready, the worker should be able to answer:

1. What exact fields are searched?
2. How does grant enforcement constrain search?
3. What can a third-party client discover before trying the endpoint?
4. Why is this lexical retrieval and not ambient generic search?
5. Why is this an extension and not core?
6. How does the public `/v1/search` surface differ from `/_ref/search`?
7. What portable behavior is promised, and what ranking details remain implementation-defined?

## Recommended worker output format

When reporting back, include:

1. proposed change name
2. exact files created/edited
3. the final recommended endpoint + metadata shapes
4. unresolved questions, if any
5. anything that forced a deviation from this brief

## Stop conditions

Stop and report instead of freelancing if any of these become necessary:

- semantic/vector search
- nontrivial new discovery document
- connector-specific search semantics
- searching unauthorized fields and “filtering later”
- exposing snippets that might leak ungranted text
- making lexical retrieval mandatory core in the same tranche

## Owner summary

Build the smallest honest public lexical retrieval capability that:

- makes agents stop needing SQLite at the floor
- stays generic across connectors
- stays honest under grant enforcement
- is publicly discoverable
- remains optional rather than prematurely becoming core
