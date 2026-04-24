# Query/API implementation slice map - 2026-04-24

Status: promoted in part
Source: `openspec/changes/add-polyfill-connector-system/design-notes/query-api-readiness-audit-2026-04-24.md`
Promoted artifact: `openspec/changes/add-filtered-retrieval-search/`

## Proposed split

### 1. `add-filtered-retrieval-search`

Why: filtered search is the highest-leverage client gap, and current retrieval specs explicitly reject `filter[...]`.

Scope: allow `GET /v1/search` and `GET /v1/search/semantic` to accept existing record-list exact/range filters when exactly one `streams[]` value is present. Reuse existing grant-safe filter validation and keep ranking knobs, scores, expansion, sort, and cross-stream filtered search out of scope.

Acceptance shape: successful lexical and semantic searches with declared range filters; rejection for missing/multiple streams, unauthorized fields, undeclared ranges, unsupported operators, malformed values, and still-forbidden search parameters.

Status: drafted as an OpenSpec change.

### 2. `backfill-first-party-query-range-filters`

Why: record-list range filters already work, but shipped polyfill manifests declare none, so assistants cannot ask basic date/amount/size questions over real connectors.

Scope: add `query.range_filters` to first-party manifests using the audit's field list, plus manifest validation that range fields exist, are orderable, and use only supported operators.

Acceptance shape: Gmail, Slack, GitHub, YNAB, ChatGPT, Codex, and Claude Code have assistant-critical date/number filters; remaining shipped manifests are covered or explicitly excluded; smoke tests prove record-list range filtering over real polyfill-style manifests.

OpenSpec need: implementation slice can be OpenSpec because it changes first-party manifest behavior and validator expectations, but it should not change the public filter contract.

### 3. `define-query-schema-discovery-floor`

Why: clients can fetch per-stream metadata only when they know connector and stream names; owner-token polyfill callers still need out-of-band connector IDs.

Scope: choose the v0.1 discovery floor: either public owner-token connector enumeration plus per-stream metadata, or a one-shot schema/capability endpoint. Also correct stale docs that describe old stream metadata fields.

Acceptance shape: an owner token can enumerate connector IDs and discover all accessible stream schemas/capabilities without out-of-band IDs; docs say `object: "stream_metadata"`, `relationships`, `query.search`, `query.range_filters`, and `query.expand` are the metadata truth.

OpenSpec need: yes, if adding a public endpoint or capability document. Documentation-only correction can be a smaller docs task.

### 4. `enable-safe-parent-child-expand`

Why: `expand[]` works in the server but shipped polyfill manifests do not enable it, and many relationships are directionally incompatible with the current parent-to-child engine.

Scope: add a manifest validator for `query.expand` plus safe parent-to-child expansions only, such as Gmail messages to message bodies/attachments and Slack messages to attachments/reactions. Do not add belongs-to/reverse/nested graph semantics.

Acceptance shape: every `query.expand` entry has a matching relationship and related stream foreign key; RS tests show Gmail/Slack expansions hydrate grant-safe children with `expand_limit`; belongs-to relations remain explicitly deferred.

OpenSpec need: yes for validator/first-party behavior. A separate design note should keep the belongs-to/reverse expansion question open.

### 5. `define-initial-changes-bookmark`

Why: `changes_since` works once a client has an opaque cursor, but there is no documented initial bookmark flow and docs currently conflate `next_cursor` with `next_changes_since`.

Scope: first correct the docs conflict, then choose exactly one initial sync/bookmark contract such as `changes_since=beginning`, a stream `changes-cursor` endpoint, or full-list terminal `next_changes_since`.

Acceptance shape: a new client can establish a first opaque changes bookmark without constructing internal cursor JSON; raw timestamps remain rejected unless explicitly specified; tests cover initial bookmark, pagination, expiry, and cursor-space separation.

OpenSpec need: yes for any new initial bookmark contract. The docs correction is a prerequisite and can be a smaller task.

## Keep as design notes / open questions for now

- Cross-stream filtered search across heterogeneous field names and partial stream support.
- Public semantic score fields, score calibration, reranking output, and caller-controlled hybrid weights.
- Belongs-to, reverse, nested, or graph traversal expansion.
- Gmail attachment byte hydration, blob storage topology, grant affordance, `blob_ref` shape, and HTTP `HEAD`/range behavior.
- Timestamp-based `changes_since` input semantics.
- Geospatial filters, aggregations, sort-by, and connector-specific search DSLs.
