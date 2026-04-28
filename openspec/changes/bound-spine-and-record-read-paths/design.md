## Context

The reference implementation uses SQLite through `better-sqlite3`. The
previous memory-pressure fix addressed the read paths observed in its crash
repro harness, but left other direct `db.prepare(...).all()` sites in place.
The next failure appeared through the reference spine timeline path: a dashboard
page requested a run timeline whose event count was large enough to recreate
the same unbounded-materialization failure class.

The first implementation tranche went beyond the immediate spine path by adding
a typed DB wrapper and migrating many call sites into registered SQL artifacts.
That is valuable, but it did not fully eliminate all historical direct prepares.
The durable OpenSpec contract therefore needs to describe what the branch
actually enforces, not the stronger design we still want later.

## Design

### 1. Typed wrapper, not a new database engine

`reference-implementation/server/db.js` remains the database engine bootstrap:
schema initialization, sqlite-vec probing, busy handling, and the cached
prepare proxy stay there. `reference-implementation/lib/db.ts` sits above it
and exposes the public authoring surface for migrated call sites:

- `getOne` for single-row reads.
- `getMany` for bounded page reads.
- `iterate` for registered streaming reads.
- `exec` for mutations.
- `allowUnboundedReadAcknowledged` for small-enumeration scans with runtime
  overflow checks.
- `iterateDynamicSqlAcknowledged` for the few dynamic SQL builders that cannot
  be static query artifacts.
- `transaction` for the existing better-sqlite3 transaction idiom.

The wrapper makes the intended read shape visible in code review. It does not,
by itself, prove every old call site has been migrated.

### 2. Registry validation catches malformed static artifacts

Static SQL lives under `reference-implementation/server/queries/**`. Each file
declares frontmatter such as `@terminator`, `@cursor_field`, `@bounded_by`,
`@table`, and `@max_rows`. The loader validates each artifact at startup
against the live database and rejects multi-row artifacts that omit both a
`LIMIT ?` placeholder and a small-enumeration annotation.

This gives us a real structural check for the migrated surface. It is not a
global SQL linter for dynamically composed SQL.

### 3. Spine timelines page in SQL

The immediate regression is closed by changing run, grant, and trace timelines
to fetch a single SQL page. Cursors are opaque reference-internal values. The
public response shape gains `limit`, `truncated`, and `next_cursor`
additively, so existing clients still see an event list while clients that need
full history can follow pages.

The scoped endpoints are:

- `GET /_ref/runs/:runId/timeline`
- `GET /_ref/grants/:grantId/timeline`
- `GET /_ref/traces/:traceId`

### 4. Correlation summaries use aggregate extent

List surfaces may hydrate only a bounded event sample to derive display fields.
That is acceptable only if summary extent fields do not pretend the sample is
the whole correlation. The implementation therefore uses SQL aggregate values
for `first_at`, `last_at`, and `event_count` after hydration.

Lifecycle-derived display fields may still be approximate above the hydration
cap. A later indexed-terminal-event pass can make those exact without
re-materializing the full event list.

### 5. Staged-file gate prevents new direct prepares

The pre-commit gate rejects newly staged direct `db.prepare(...)` /
`getDb().prepare(...)` usage outside the small allowlist:

- `reference-implementation/lib/db.ts`
- `reference-implementation/server/db.js`
- `reference-implementation/server/queries/index.ts`

This is a prevention gate for new code. It intentionally does not claim that
all grandfathered call sites are gone.

## Non-Goals

- Fully migrating every historical `db.prepare(...)` call site in the reference
  implementation.
- Proving that every dynamic SQL path has a SQL-enforced page bound.
- Enforcing `REVIEWED-*` comment proximity in lefthook. The loud escape-hatch
  names remain the review trigger; comment enforcement can be reconsidered if
  audit evidence shows reviewers miss them.
- Solving response-size budgets, process supervision, or route concurrency.
  Those remain useful defense-in-depth work but are separate from the measured
  spine timeline regression.

## Risks

- **Residual direct prepares remain.** The staged-file gate prevents new ones
  but does not remove all old ones. The remaining set must stay visible in
  owner review and follow-up planning.
- **Dynamic SQL still depends on caller discipline.** The dynamic escape hatch
  centralizes the surface but cannot statically prove that every generated SQL
  shape is bounded.
- **Pagination is additive but still a behavior change for very long
  timelines.** Clients that assumed a single response contained every event now
  need to follow `next_cursor` when `truncated` is true.
- **Summary lifecycle fields can be approximate above the hydration cap.** The
  extent fields are exact; lifecycle precision needs a future indexed terminal
  event design.

## Acceptance

- OpenSpec validates strictly.
- Reference typecheck and lint pass.
- The wrapper and query registry tests pass.
- The `_ref` timeline endpoints return bounded envelopes with stable cursors.
- Grep confirms remaining direct prepares are known grandfathered sites or
  explicit allowlist files, not accidental new call sites.
