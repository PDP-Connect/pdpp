## Decision

Adopt identity-first keyset pagination for the unscoped `GET /_ref/connectors`
summary feed. The page is selected from the owner-visible `connector_instances`
set before reconciliation or any evidence read. Every later batch is keyed by
the exact `connector_instance_id` values from that page. `connector_id` is
catalog identity only; it SHALL NOT join sibling connection evidence.

This is a page read model, not another truth/cache. `connector_summary_evidence`
continues to be a disposable projection repaired from canonical authorities;
time-relative freshness, health, verdict, and next action continue to be
synthesized at read time.

## Concept gate

Proceed only if the implementation can prove all of the following before its
default is changed:

- The page inventory is an owner-scoped, immutable keyset query. Preserve the
  present visible ordering with `(connector_id, created_at,
  connector_instance_id)` ascending; the final id is the unique tie-breaker.
  These fields are durable identity facts, not display name, status, verdict,
  or evidence recency.
- The opaque, versioned cursor binds that tuple, owner scope, and ordering
  version. Invalid, cross-owner, or version-mismatched cursors fail as typed
  invalid requests. The server reads `limit + 1`, returns `has_more`, and emits
  `next_cursor` only when a further identity exists.
- `limit` is required for the new paginated mode, positive, and capped at 100.
  The cap is deliberately below SQLite's historical 999 host-parameter floor;
  every multi-id store query must still chunk defensively and bind values.
- The page's exact ids scope the evidence barrier and every durable batch. No
  page query may replace an absent page id with a connector-wide fallback.
- Page traversal is keyset-stable, not snapshot-stable. A row that remains in
  the set is not duplicated or skipped by updates to mutable summary evidence;
  inserts before an issued boundary appear after restart, and deletion is
  tolerated. A cross-page snapshot would require explicit snapshot state and
  is out of scope.
- SQLite and a real disposable PostgreSQL database produce the same ids,
  summary fields, cursor behavior, typed failures, and query-slope result.

These gates follow PostgreSQL's requirement for a unique `ORDER BY` and its
warning that large offsets still compute skipped rows; they also reflect the
fact that PostgreSQL Read Committed statements and SQLite committed reads do
not supply an implicit cross-request snapshot. [PostgreSQL LIMIT/OFFSET](https://www.postgresql.org/docs/current/queries-limit.html), [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html), [SQLite isolation](https://www.sqlite.org/isolation.html)

## API and migration

1. Retain `?connection=` exactly: it resolves one exact/unambiguous connection
   and remains unpaginated, deep, and output-compatible.
2. Add `limit` and `cursor` to the unscoped list response, with `has_more` and
   nullable `next_cursor`. The console moves to the paginated contract first.
3. During one compatibility release, an unparameterized request retains its
   current small-fleet envelope and ordering but returns a deprecation signal;
   it MUST NOT silently truncate a large fleet. The final switch makes the
   bounded default explicit and is blocked on consumer migration/UAT.
4. Fleet-wide counts, attention rollups, and fleet health continue to use their
   own bounded aggregation/composition endpoint. They are not inferred from a
   page and are not embedded into every item.

The temporary compatibility mode is intentional: changing an unpaginated list
to a default cap changes large-client semantics. Stripe's established list
surface likewise uses a bounded `limit` and opaque continuation cursor; its
specific object cursor is not reused here because PDP-Connect needs an exact
connection-identity tuple. [Stripe pagination](https://docs.stripe.com/api/pagination)

## Evidence batching boundary

The gatherer accepts the page identity set and returns maps keyed by exact
connection id. It is distinct from pure per-item synthesis and fleet rollups.

| Axis | Classification | Page design |
| --- | --- | --- |
| identity/inventory; manifest; active-count eligibility | portable reusable reference query | one keyset identity page plus manifest/active-count batches for page connector ids |
| summary evidence and stream facts | PDPP product projection | call the existing scoped reconcile/read with the page ids; preserve its SQLite `IN (...)` and PostgreSQL `ANY($1::text[])` semantics |
| schedules | portable reusable reference query | add `listSchedulesByConnectionIds(ids)`; map by `connector_instance_id` |
| latest/latest-successful run history and terminal data | portable reusable reference query | batch latest run history by ids and status, then batch terminal/rate facts by selected run ids |
| retained-size/record projection | PDPP product projection | page-scoped retained-size connection and stream snapshots |
| detail gaps, recovered/terminal counts, attention, acquisition batches, credential metadata, local coverage | PDPP product projection | per-axis page batch with the current limit/null/unreliable semantics preserved |
| device heartbeat/outbox | PDPP product projection | batch the durable connection-scoped heartbeat evidence; preserve its current unknown/unreliable distinction |
| browser lease/surface; allocator inventory | genuinely runtime-only | snapshot/filter once for the page's relevant identities; do not persist it or use it as fleet truth |

`listSchedules()` remains required for the scheduler and schedule-management
views. PR #51 (`b0f5174a4`) is a safe interim optimization: it replays an
owner-wide schedule list by exact connection id and its characterization test
proves current small-fleet output parity. It is not terminal for this page path:
each 100-item page would deserialize the owner's entire schedule set. The new
id-scoped method is therefore required before the paginated path is declared
scalable. PostgreSQL array comparison supports the `= ANY(array)` form; SQLite
requires host parameters and has a configurable variable limit, hence an empty
id set must short-circuit and SQLite batches must be chunked. [PostgreSQL array comparisons](https://www.postgresql.org/docs/current/functions-comparisons.html), [SQLite limits](https://www.sqlite.org/limits.html), [SQLite bind API](https://www.sqlite.org/c3ref/bind_blob.html)

## Alternatives rejected

- **Owner-wide evidence/schedule snapshots for each page:** fewer statements
  than N+1, but still O(fleet) bytes/work per page.
- **Persisted rendered summary/fleet cache:** duplicates existing derived facts
  and risks stale verdict copy; the established evidence design rejects it.
- **OFFSET pagination:** costly at deep offsets and vulnerable to row movement.
- **One transaction/snapshot across page traversal:** would require durable or
  server-held snapshot lifecycle and is disproportionate to an owner console.
- **Connector-id batches:** unsafe for multiple connections of one connector.

The JSON:API cursor profile similarly recommends unique immutable ordering,
explains that changing collections are not snapshots, and treats snapshot
guarantees as an additional server responsibility. [JSON:API cursor profile](https://jsonapi.org/profiles/ethanresnick/cursor-pagination/)

## Validation and UAT

- Characterize the present 1–20 connection output byte-for-byte before and
  after pagination compatibility mode, including drafts, revoked rows,
  duplicate connector ids, local-device rows, and scoped `?connection=`.
- Add SQLite and PostgreSQL cursor tests for malformed/scope-mismatched cursor,
  tuple ties, delete/update/insert between pages, and no cross-connection
  evidence leakage.
- Add N-slope tests at N=1 and N=1000 with a fixed 100-row page. Assert a
  constant number of statements/rows bounded by page size for each durable
  axis, and separate tests for runtime snapshots. Assert SQLite chunking and
  PostgreSQL empty-array behavior explicitly.
- Run the existing connector summary, scoped-route slope, evidence-engine
  SQLite, and Postgres suites; add the new route contract and console consumer
  tests. Validate with a synthetic 1,000-connection owner before enabling the
  default.
- UAT: follow all pages, verify each visible identity once, mutate schedule/run/
  attention while paging, check page-local detail matches the exact scoped
  route, and independently compare fleet rollups to a bounded aggregate.
