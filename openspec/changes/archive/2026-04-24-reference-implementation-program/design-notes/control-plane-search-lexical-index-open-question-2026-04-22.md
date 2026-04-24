# Open question — should the reference keep the new lexical search index behind `_ref/search`, or was that an optimistic branch taken too early?

**Status:** open question; experimental reference-only branch taken, no PDPP spec change recommended here  
**Raised:** 2026-04-22 during the `_ref/search` performance investigation  
**Scope:** reference-only control-plane search (`GET /_ref/search`) and its local storage/indexing strategy. No `/v1/search` surface is proposed here.

## Summary

The reference implementation took an explicit optimistic branch: it added a
SQLite FTS5-backed lexical index behind the existing read-only,
reference-designated `_ref/search` route so the operator console could remain
practical on a real local dataset.

That branch improved the live bottleneck materially, but it does **not**
resolve the underlying design question. The open question is whether this
should remain the reference's long-term shape for operator search, whether it
should be narrowed further, or whether taking the branch at all was premature.

This note exists to record that the project intentionally went out on a limb
for learnability and operator practicality, not because the broader search
question is closed.

## Why this question exists

The control-plane work already wanted a single cross-artifact search/jump
surface, and it wanted that surface to stay read-only and reference-designated:

- `design.md` records `GET /_ref/search?q=…` as an id-aware jump helper for the
  operator console.
- `tasks.md` Phase 5 explicitly limits cross-artifact search to read-only
  reference-designated helpers.
- `control-plane-discovery-brief.md` names `Search / Command` as the console's
  single cross-artifact jump surface and allows record-content search only
  "where locally practical."
- The same brief also mentions a `lightweight cross-artifact search index`.

At the same time, the broader search/retrieval question is still open at the
PDPP level:

- `semantic-retrieval-surface-open-question.md` explicitly treats search as a
  spec-level decision, not something the project should silently standardize by
  shipping `/v1/search`.
- The capability-discovery work from 2026-04-22 is also moving in the opposite
  direction from "quietly widen the protocol": small truthful capability
  surfaces first, larger discovery layers only if they earn their complexity.

So the project had a real tension:

1. the operator console needed `_ref/search` to stop being meaningfully slow on
   a real local instance
2. the protocol/search architecture was still unresolved

The lexical index experiment is the branch the reference took to relieve (1)
without pretending it had answered (2).

## What changed in the reference

The implementation now keeps a lexical FTS5 index over flattened scalar record
values and uses it only as a prefilter for `_ref/search` record-content hits.

Relevant files:

- [`reference-implementation/server/db.js`](../../../../reference-implementation/server/db.js)
  - creates and maintains the `ref_record_search` FTS5 table
  - keeps the index in sync via `records` triggers
  - rebuilds the index on startup if the index is missing or out of sync
- [`reference-implementation/server/index.js`](../../../../reference-implementation/server/index.js)
  - routes `_ref/search` record-content lookup through FTS when the query can
    be represented safely there
  - falls back to the previous scan path otherwise
- [`reference-implementation/server/ref-record-utils.js`](../../../../reference-implementation/server/ref-record-utils.js)
  - builds the conservative FTS match expression
  - keeps `findQueryMatch()` as the final authority for result acceptance,
    snippets, and word-boundary behavior
- [`reference-implementation/test/control-plane.test.js`](../../../../reference-implementation/test/control-plane.test.js)
  - proves record-hit behavior, restart rebuild, and insert/update/delete index
    maintenance

Important boundary:

- this experiment stays entirely behind `_ref/search`
- it does **not** add `/v1/search`
- it does **not** expose lexical scores or a new ranking contract
- it does **not** claim new capability-discovery semantics

## Why taking the branch seemed justified

The motivating bottleneck was concrete rather than theoretical.

Before the change, `_ref/search` record-content hits were dominated by a raw
`LOWER(record_json) LIKE '%...%' ORDER BY emitted_at DESC` scan over the full
records table. On a live local DB this was slow enough to undermine the
operator console's Search view.

After the experiment landed, the same live instance showed materially better
latency for representative `_ref/search` queries while preserving the current
response shape and post-filter semantics.

That makes the experiment defensible as a reference-only practicality move.
It does **not** make it self-evidently correct as the long-term answer.

## What remains open

### 1. Was indexing all scalar record values the right first cut?

The current experiment indexes flattened scalar values across retained records.
That is pragmatic, but it may be too broad.

Questions:

- Should operator lexical search index all scalar values, or only a smaller set
  of text-like fields?
- Is indexing numbers and booleans actually useful enough to justify the
  larger search corpus?
- Should future narrowing happen per stream, per field, or by another rule?

Prior art points toward "typed filters first, text search second," which argues
for caution here.

### 2. Is FTS tokenization an acceptable approximation?

SQLite FTS5 tokenization is not identical to the reference's existing
`findQueryMatch()` rules. Today the implementation handles that by using FTS as
an acceleration layer and then letting `findQueryMatch()` remain authoritative.

Questions:

- Is this two-stage model stable enough for the reference?
- Are there important query classes where the FTS prefilter is still too loose
  or too narrow?
- Should the experiment keep the fallback scan path indefinitely for those
  classes, or should the lexical contract be tightened explicitly?

### 3. Is duplicating searchable personal data in a local index acceptable?

The experiment duplicates searchable record content into a local FTS structure.
That may be entirely reasonable for a local reference/operator console, but it
is still a design choice with retention and deletion consequences.

Questions:

- Is the duplication acceptable for the reference's local-first trust model?
- Are there SQLite deletion/privacy knobs the reference should enable or at
  least discuss before this is treated as a stable local pattern?
- Does a future self-export or storage-topology decision need to say more about
  derived local search artifacts?

### 4. Is trigger-based maintenance the right reference tradeoff?

The current branch uses SQLite triggers for maintenance because the search
document is intentionally simple: flattened scalar values from `record_json`.

Questions:

- Is that simplicity durable enough to justify trigger maintenance?
- If the search document ever becomes more semantic than "flatten scalar
  values," does the index need to move into JS-managed maintenance instead?
- Is the rebuild-on-startup safeguard sufficient for reference quality?

### 5. Does the experiment create protocol gravity even if it stays under `_ref`?

This is probably the highest-stakes open question.

Even though the branch is explicitly reference-only, reference behavior has a
way of becoming "the thing future implementers assume exists." That is exactly
why the semantic-retrieval note warned against shipping a normative search
surface casually.

Questions:

- Will future readers infer that PDPP "has search" because the reference ships
  this behind `_ref/search`?
- If so, is the current lexical experiment narrow enough to avoid creating the
  wrong mental model?
- Should the project add stronger language elsewhere saying this is an operator
  convenience layer rather than a protocol promise?

## Current recommendation

Keep the experiment for now, but treat it as a bounded reference-only branch
that still needs review.

That means:

1. keep it behind `_ref/search` only
2. do not add `/v1/search`
3. do not expose ranking scores or capability claims from it
4. use operator experience and further review to decide whether this should be:
   - kept as-is
   - narrowed
   - reworked
   - or removed

The important thing is to resist quietly converting "we took a practical branch"
into "the project has now decided search architecture."

## What would answer the question

This question is closer to resolved when the project has explicit answers to:

- what operator search is actually supposed to search
- how much lexical approximation is acceptable
- whether duplication of searchable local data is acceptable in the reference
- whether the experiment is clearly enough separated from normative PDPP
  semantics

Until then, this should be read as:

> the reference optimistically went out on a limb so the operator console could
> stay useful, and the project now needs to decide whether that limb was the
> right one.

## Cross-references

- [`design.md`](../design.md)
- [`tasks.md`](../tasks.md)
- [`control-plane-discovery-brief.md`](control-plane-discovery-brief.md)
- [`semantic-retrieval-surface-open-question.md`](../../add-polyfill-connector-system/design-notes/semantic-retrieval-surface-open-question.md)
- [`capability-discovery-framing-2026-04-22.md`](capability-discovery-framing-2026-04-22.md)
- SQLite FTS5 docs: https://www.sqlite.org/fts5.html
