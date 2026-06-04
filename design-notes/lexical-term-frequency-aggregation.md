# Lexical Term Frequency Aggregation

Status: captured
Owner: reference implementation owner
Created: 2026-05-23
Updated: 2026-06-04
Related: openspec/changes/archive/2026-05-29-canonicalize-public-read-contract, openspec/changes/archive/2026-05-29-add-aggregate-time-buckets-and-distinct, openspec/changes/archive/2026-06-01-make-mcp-query-filters-agent-usable

## Question

How should the reference implementation expose "top terms in message
bodies" and similar full-text term-frequency aggregations? Specifically:
is this a record-field `group_by` mode, a separate
lexical-index aggregation, or a deferred follow-up that does not belong
in the current read surface at all?

## Context

The read-surface analytics work (landed on `main` as
`canonicalize-public-read-contract` and
`add-aggregate-time-buckets-and-distinct`) makes categorical top-N
explicit as `metric=count&group_by=<field>` over manifest-declared
scalar facet fields. Slack reaction `emoji`, channel `id`, and partner
`user_id` cleanly fit that mold — the connector emits one record per
categorical value, and counting groups requires no analyzer.

Free-text term frequency does not. Counting the most common terms in
message bodies (or PR descriptions, or transcript turns) depends on:

- analyzer choice (default vs language-specific vs stemmed vs ngram);
- stopword policy (per language? per stream? caller-supplied?);
- token normalization (case folding, diacritics, emoji handling);
- privacy redaction (PII tokens that the lexical index quietly drops
  from counts but not from records);
- whether counts come from the raw record store or from the lexical
  index, which may already have applied analyzer changes the caller
  cannot see.

Overloading `group_by=text_field` would silently make all of those
choices on behalf of the caller, and the resulting counts would not be
comparable across deployments that picked different analyzers.

## Stakes

- Aggregate honesty: a caller asking "top terms in my Slack messages"
  expects a number that means something. If the analyzer is invisible,
  the number isn't audit-quality.
- Grant projection: lexical-index aggregation must respect grant
  projections (per-stream, per-field), otherwise a top-terms call can
  leak signal about records the caller can't read directly.
- Privacy: a top-terms list is a low-friction surface for re-identifying
  rare tokens. It needs a deliberate redaction policy, not the implicit
  one the lexical index happens to use.
- Standards-readiness: if PDPP eventually advertises term-frequency as
  a normal aggregation, the manifest needs a way to declare an analyzer,
  a stopword set, a minimum count threshold, and a redaction policy
  per stream.

## Current Leaning

Treat lexical-index aggregation as a separate primitive, not a hidden
mode of the existing `aggregateStream` operation. Specifically:

- The current contract rejects `group_by=<free_text_field>` with
  `unknown_field` rather than silently tokenizing. The MCP
  `aggregate_records` tool description should state this explicitly so
  callers do not waste calls trying.
- A future OpenSpec change should introduce a `lexical_aggregate`
  operation (or extend `aggregateStream` with an explicit `analyzer`
  parameter and a manifest-declared analyzer allow-list) that exposes:
  - a per-stream `lexical_index_aggregations` declaration in the
    manifest, including analyzer id, stopword set id, minimum count
    threshold, and per-token redaction policy;
  - a `metric=term_frequency&field=<lexical_field>` shape on the
    aggregate response, returning `term` and `count` ordered by
    `count desc, term asc`;
  - a contract-level capability flag so deployments without a lexical
    index honestly advertise the absence.

The interim contract surface is: scalar `group_by` for facets,
explicit "no" for free-text fields, and a recorded follow-up so the
need is not lost.

## Promotion Trigger

Promote to an OpenSpec change when any of the following is true:

- The reference implementation adds a lexical index that can serve
  per-token counts within grant projection.
- A connector (Slack, Gmail, PR transcripts) ships a manifest
  declaration that would benefit from analyzer-explicit aggregation.
- An external reviewer or app developer requests "top terms" as a
  first-class call and the answer is not yet "supported via
  lexical_aggregate."

## Decision Log

- 2026-05-23: Captured during the read-surface analytics-capabilities
  closeout. Filed out-of-scope from that change because it requires
  manifest schema additions, an analyzer/redaction policy, and a
  separate capability flag that do not belong in the current per-stream
  aggregate field allow-list work.
- 2026-06-04: Re-filed onto current `main` from the now-closed PR
  vana-com/pdpp#3 (`decomplect-ri-construction-boundaries`), which was
  closed as superseded. `Related:` pointers refreshed to the artifacts
  that actually landed on main: the analytics read surface
  (`canonicalize-public-read-contract`,
  `add-aggregate-time-buckets-and-distinct`) and the agent-query
  efficiency work (archived as
  `2026-06-01-make-mcp-query-filters-agent-usable`, the PR's
  `add-agent-query-efficiency-contract` concept). No `lexical_aggregate`
  / `term_frequency` operation exists on main yet, so the deferral and
  its promotion triggers still stand.
