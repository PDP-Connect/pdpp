## MODIFIED Requirements

### Requirement: Reference spine timelines SHALL page in SQL

Reference-only spine timeline endpoints SHALL NOT materialize every event for a correlation before responding. The run, grant, and trace timeline endpoints SHALL read spine events through SQL-paginated queries, with caller-visible `limit`, `cursor`, `truncated`, and `next_cursor` fields.

This requirement applies to:

- `GET /_ref/runs/:runId/timeline`
- `GET /_ref/grants/:grantId/timeline`
- `GET /_ref/traces/:traceId`

The default limit MAY be implementation-defined, but the handler SHALL enforce a maximum page size. Pagination cursors MAY be reference-internal and opaque to callers.

#### Scenario: Run timeline pages in SQL
- **WHEN** a client queries `GET /_ref/runs/:runId/timeline` with optional `limit` and `cursor`
- **THEN** the SQL query SHALL apply a SQL `LIMIT ?` against `spine_events` filtered by `WHERE run_id = ?`
- **AND** the response envelope SHALL include `truncated: boolean` and `next_cursor: string | null`
- **AND** the RS SHALL NOT load the full spine-event list for the run into application memory

#### Scenario: Grant timeline pages in SQL
- **WHEN** a client queries `GET /_ref/grants/:grantId/timeline` with optional `limit` and `cursor`
- **THEN** the SQL query SHALL apply a SQL `LIMIT ?` against `spine_events` filtered by `WHERE grant_id = ?`
- **AND** the response envelope SHALL include `truncated: boolean` and `next_cursor: string | null`
- **AND** the RS SHALL NOT load the full spine-event list for the grant into application memory

#### Scenario: Trace timeline pages in SQL
- **WHEN** a client queries `GET /_ref/traces/:traceId` with optional `limit` and `cursor`
- **THEN** the SQL query SHALL apply a SQL `LIMIT ?` against `spine_events` filtered by `WHERE trace_id = ?`
- **AND** the response envelope SHALL include `truncated: boolean` and `next_cursor: string | null`
- **AND** the RS SHALL NOT load the full spine-event list for the trace into application memory

### Requirement: Reference SQL wrapper SHALL make bounded reads explicit

The reference implementation SHALL provide a typed SQL wrapper above the existing SQLite engine. The wrapper SHALL expose explicit primitives for:

- single-row reads,
- bounded multi-row reads with a caller-supplied limit,
- streaming iterators,
- mutations,
- transactions,
- and explicitly acknowledged small-enumeration scans.

Registered multi-row query artifacts SHALL declare their terminator and cursor metadata. At startup, the registry SHALL validate registered query artifacts against the live database schema and reject malformed registered query artifacts before serving requests.

Application-level reference code SHALL route static SQL through registered query artifacts and wrapper primitives. Genuinely dynamic SQL SHALL route through explicitly acknowledged dynamic wrapper primitives. Direct `db.prepare(...)` usage SHALL be limited to the engine, wrapper, and query-registry allowlist.

#### Scenario: A bounded multi-row read reaches the wrapper with no limit
- **WHEN** RS code attempts a multi-row read by calling `getMany(query, params, { limit })` with `limit <= 0`
- **THEN** the wrapper SHALL throw a typed unbounded-read error before issuing SQL

#### Scenario: A registered SQL artifact lacks a LIMIT placeholder at startup
- **WHEN** the reference server starts and the registry loader processes a `.sql` artifact whose registered `terminator` is `'many'`
- **AND** the SQL text contains no `LIMIT ?` placeholder
- **AND** the artifact is not annotated as `bounded_by: 'small_enumeration_table'`
- **THEN** the loader SHALL throw at startup with an error naming the offending artifact path

#### Scenario: A small-enumeration scan exceeds its declared bound
- **WHEN** a call site invokes the small-enumeration escape hatch for a registered query annotated with `@max_rows`
- **AND** the query returns more rows than the declared bound
- **THEN** the wrapper SHALL throw before returning the rows to the caller

### Requirement: New direct DB prepare usage SHALL be blocked at the staged-file boundary

The reference repository SHALL include a pre-commit gate that rejects newly-staged direct `db.prepare(...)` or `getDb().prepare(...)` usage under production reference code, except in the explicit engine/wrapper/registry files that are responsible for preparing SQL.

This gate is a staged-file prevention mechanism. Closeout validation SHALL pair it with a production-reference grep so direct prepare usage remains confined to the engine, wrapper, and query-registry allowlist.

#### Scenario: A pre-commit attempts to introduce direct prepare usage
- **WHEN** a contributor stages a change to a production reference file that introduces `db.prepare(` or `getDb().prepare(`
- **AND** the file is not part of the engine, wrapper, or query-registry allowlist
- **THEN** the pre-commit gate SHALL fail with a message pointing the contributor at the wrapper API

### Requirement: Correlation list summaries SHALL not underreport aggregate extent when hydration is capped

Reference correlation list surfaces MAY hydrate only a bounded event sample per row to derive display fields, but they SHALL use SQL aggregate values for the full correlation's `first_at`, `last_at`, and `event_count`.

Run lifecycle display fields that depend on terminal event payloads SHALL use an indexed terminal-event lookup rather than relying on the bounded hydration sample.

#### Scenario: A correlation has more events than the hydration cap
- **WHEN** the reference builds a run, grant, or trace summary for a correlation whose event count exceeds the hydration cap
- **THEN** `event_count` SHALL report the SQL aggregate count for the full correlation
- **AND** `first_at` and `last_at` SHALL report the SQL aggregate timestamps for the full correlation
- **AND** the implementation SHALL NOT report the hydration-sample length as the correlation's total event count

#### Scenario: A run terminal event is beyond the hydration cap
- **WHEN** the reference builds a run summary whose terminal event is not present in the bounded hydration sample
- **THEN** terminal payload fields used for lifecycle display SHALL be hydrated through an indexed run-terminal-event lookup
- **AND** the implementation SHALL NOT scan the full run timeline to recover those fields
