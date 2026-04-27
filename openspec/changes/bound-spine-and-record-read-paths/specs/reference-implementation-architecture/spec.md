## MODIFIED Requirements

### Requirement: Reference RS read paths SHALL be bounded by construction

Every database read in the reference resource server SHALL be bounded by construction, not by reviewer discipline. The bound SHALL be one of:

- An explicit caller-supplied `limit` enforced by the storage layer (SQL `LIMIT ?` plus driver cap).
- A single-row primary-key lookup (`WHERE pk = ?` returning at most one row).
- A streaming iterator (`Statement.iterate()` in `better-sqlite3`) that consumes row-by-row and breaks once a bounded page is assembled.
- An explicit, named, grep-able opt-in (`allowUnboundedReadAcknowledged`) used only for reads of small enumeration tables whose maximum row count is documented at the call site and validated by the registry.

Every SQL string executed against the reference database SHALL live in a registered `.sql` query artifact. The registry SHALL validate at server startup that every multi-row read query (`terminator: 'many'`) contains a `LIMIT ?` placeholder OR is annotated as `bounded_by: 'small_enumeration_table'` with a declared maximum row count. Direct invocation of `db.prepare(...)` outside the wrapper module SHALL be prevented by a pre-commit gate.

For all RS read paths, including but not limited to:

- `GET /v1/streams/:stream/records` (including `expand=…`)
- `GET /v1/streams/:stream/records/:id` (including `expand=…`)
- `GET /_ref/runs`, `GET /_ref/grants`, `GET /_ref/traces`, `GET /_ref/search`
- `GET /_ref/records/timeline`
- `GET /_ref/runs/:runId/timeline`
- `GET /_ref/grants/:grantId/timeline`
- `GET /_ref/traces/:traceId`

the following constraints apply:

- Access-control filters (`time_range`, `resources`) SHALL be expressed as SQL `WHERE` clauses that constrain the scan at the storage layer.
- Pagination (`limit`, `cursor`, and per-parent limits in `expand`) SHALL be applied at the SQL layer via `ORDER BY` + `LIMIT` or window functions, not by loading the full set and `slice`-ing in application code.
- When a handler needs to iterate results, it SHALL stream via the driver's iterator API (e.g. `Statement.iterate()` in `better-sqlite3`) and stop as soon as the bounded page is assembled.
- Child-stream expansion SHALL filter the child scan by the parent page's foreign-key values **in SQL**, not fetch the whole child stream and group in application code.

Handlers MAY parse JSON columns into objects for the rows that survive into the response, but SHALL NOT parse JSON for rows that would be filtered out by access control.

#### Scenario: A grant narrows visibility via time_range

- **WHEN** a client queries `/v1/streams/<s>/records` under a grant that declares `time_range: { since, until }` on stream `<s>`
- **THEN** the SQL query the RS issues SHALL include a predicate that compares the row's `consent_time_field` against `since`/`until`
- **AND** rows outside the window SHALL NOT be parsed, materialized, or allocated in application memory

#### Scenario: A grant narrows visibility via resources

- **WHEN** a client queries `/v1/streams/<s>/records` under a grant that declares a non-empty `resources` allowlist on stream `<s>`
- **THEN** the SQL query SHALL include an `IN` predicate against the allowed record keys
- **AND** rows whose keys are not in the allowlist SHALL NOT be parsed or materialized

#### Scenario: Pagination is pushed into SQL

- **WHEN** a client queries `/v1/streams/<s>/records` with `limit=N` and optionally `cursor`
- **THEN** the SQL query SHALL emit `ORDER BY <cursor_field, primary_key>` and `LIMIT N+1`
- **AND** the RS SHALL read at most `N+1` rows from the driver, not the full filtered set

#### Scenario: Expansion pushes child-stream narrowing into SQL

- **WHEN** a client queries `/v1/streams/<s>/records?expand=<relation>&expand_limit[<relation>]=K` with a page of N parent rows
- **THEN** the SQL query over the child stream SHALL filter by `WHERE child.foreign_key IN (…N parent keys…)` plus the child grant's `time_range`/`resources` constraints
- **AND** the child query SHALL fetch at most `N × (K + 1)` rows for `has_many` expansions (via window function) or `N` rows for `has_one` expansions
- **AND** the RS SHALL NOT scan the child stream's full table

#### Scenario: Correlation-key listing pages in SQL

- **WHEN** a client lists `/_ref/runs`, `/_ref/grants`, or `/_ref/traces` with a page size
- **THEN** the SQL query SHALL aggregate in-SQL via `GROUP BY` and paginate in-SQL via `ORDER BY` + `LIMIT` + cursor
- **AND** the RS SHALL NOT materialize the full `spine_events` table to group in application code

#### Scenario: Records timeline applies time window in SQL

- **WHEN** a client queries `/_ref/records/timeline?since=A&until=B`
- **THEN** for each `(connector, stream)` pair it scans, the SQL query SHALL include a predicate against `COALESCE(NULLIF(json_extract(record_json, '$.<semantic_field>'), ''), emitted_at)` (native mode) or `emitted_at` (emitted mode) between the normalized `A`/`B` boundaries
- **AND** the query SHALL apply a per-pair SQL `LIMIT`
- **AND** the RS SHALL NOT scan and JSON-parse rows outside the window

#### Scenario: Run timeline pages in SQL

- **WHEN** a client queries `GET /_ref/runs/:runId/timeline` with optional `limit` and `cursor`
- **THEN** the SQL query SHALL apply a SQL `LIMIT ?` against `spine_events` filtered by `WHERE run_id = ?`
- **AND** the response envelope SHALL include `truncated: boolean` and `next_cursor: string | null`
- **AND** the RS SHALL NOT load the full spine-event list for the run into application memory

#### Scenario: Grant timeline pages in SQL

- **WHEN** a client queries `GET /_ref/grants/:grantId/timeline` with optional `limit` and `cursor`
- **THEN** the SQL query SHALL apply a SQL `LIMIT ?` against `spine_events` filtered by `WHERE grant_id = ?`
- **AND** the response envelope SHALL include `truncated: boolean` and `next_cursor: string | null`

#### Scenario: Trace timeline pages in SQL

- **WHEN** a client queries `GET /_ref/traces/:traceId` with optional `limit` and `cursor`
- **THEN** the SQL query SHALL apply a SQL `LIMIT ?` against `spine_events` filtered by `WHERE trace_id = ?`
- **AND** the response envelope SHALL include `truncated: boolean` and `next_cursor: string | null`

#### Scenario: Correlation per-row hydration uses indexed terminal-event lookup

- **WHEN** the runtime aggregates spine correlations for `_ref/runs`, `_ref/grants`, or `_ref/traces` list responses
- **THEN** for each correlation row in the page, the runtime SHALL fetch only the terminal event(s) it needs via an indexed `db.getOne(...)` call against `spine_events`
- **AND** the runtime SHALL NOT call an unbounded list-by-correlation function (e.g. an unbounded `listSpineEvents`/`listSpineEventsSync`) per page row

#### Scenario: A read query reaches the wrapper with no limit

- **WHEN** any RS code path attempts a multi-row read by calling `db.getMany(query, params, opts)` without a positive `limit`
- **THEN** the wrapper SHALL throw a typed error before issuing the SQL
- **AND** the response handler that propagates the error SHALL surface it as a 500 with `error.code = "internal_unbounded_read"`

#### Scenario: A SQL artifact lacks a LIMIT placeholder at startup

- **WHEN** the reference server starts and the registry loader processes a `.sql` artifact whose registered `terminator` is `'many'`
- **AND** the SQL text contains no `LIMIT ?` placeholder
- **AND** the artifact is not annotated as `bounded_by: 'small_enumeration_table'`
- **THEN** the loader SHALL throw at startup with an error naming the offending artifact path
- **AND** the server SHALL fail to bind, surfacing the error in the structured startup completion log

#### Scenario: A small-enumeration read uses the named escape hatch

- **WHEN** a read path needs to scan a small enumeration table (e.g. `connectors`, `oauth_clients`, `version_counter`, `connector_state`, `grant_connector_state`, `lexical_search_meta`, `semantic_search_meta`)
- **THEN** the call site SHALL invoke `db.allowUnboundedReadAcknowledged(query, params)` rather than `db.getMany(...)`
- **AND** the SQL artifact SHALL be annotated as `bounded_by: 'small_enumeration_table'` with a declared maximum row count
- **AND** the call site SHALL carry an adjacent `// REVIEWED-BOUNDED: <reason>` comment naming the bound

#### Scenario: A pre-commit attempts to introduce direct .prepare() use

- **WHEN** a contributor stages a change to a file under `reference-implementation/{lib,server,runtime,cli}/` that introduces `db.prepare(` or `getDb().prepare(`
- **AND** the file is not `reference-implementation/lib/db.ts`
- **THEN** the lefthook pre-commit gate SHALL fail with a message naming the offending file:line and pointing the contributor at the wrapper API

#### Scenario: A pre-commit attempts to use the escape hatch without justification

- **WHEN** a contributor stages a change that introduces a call to `allowUnboundedReadAcknowledged`
- **AND** the call site lacks an adjacent `// REVIEWED-BOUNDED: <reason>` comment
- **THEN** the lefthook pre-commit gate SHALL fail with a message requiring the comment

#### Scenario: A read path requires dynamic SQL composed at call time

- **WHEN** a read path needs to compose its SQL string at call time (e.g. WHERE clauses that vary with the caller's grant, request filters, or query plan) and cannot be expressed as a static `.sql` artifact
- **THEN** the call site SHALL invoke `iterateDynamicSqlAcknowledged(sql, params)` exported from `lib/db.ts` rather than `db.prepare(sql)` directly
- **AND** the composed SQL SHALL include a `LIMIT ?` clause bound from a wrapper-validated value
- **AND** the call site SHALL carry an adjacent `// REVIEWED-DYNAMIC: <reason>` comment naming why static SQL does not fit
- **AND** the lefthook pre-commit gate SHALL fail any commit that introduces a call to `iterateDynamicSqlAcknowledged` without the `REVIEWED-DYNAMIC` comment or without a `LIMIT` placeholder in the dynamic SQL

Note — deferred standing defenses: additional runtime defenses (per-route in-flight concurrency cap with coupled dashboard 503 retry + partial-failure coordination, response-size budget hook, process-supervisor mandate) were considered and deferred because the read-path rewrite above resolved the measured crash pathology on its own. They remain open follow-ups, to be taken up only when a measured remaining problem justifies the scope. See `openspec/changes/archive/2026-04-24-fix-rs-query-memory-pressure/` (`proposal.md` §Follow-ups and `tasks.md` §6) for the full rationale, intended shapes, and implementation notes.
