## ADDED Requirements

### Requirement: The RS read-path for enumerated routes SHALL not materialize unbounded result arrays

The resource-server SHALL NOT execute a query whose result is an unbounded scan of a JSON-column table on the read paths covered by this change, which are:

- `GET /v1/streams/:stream/records` (including `expand=…`)
- `GET /v1/streams/:stream/records/:id` (including `expand=…`)
- `GET /v1/streams` (record_count per granted stream)
- `GET /_ref/runs`, `GET /_ref/grants`, `GET /_ref/traces`, `GET /_ref/search`
- `GET /_ref/records/timeline`

For these paths:

- Access-control filters (`time_range`, `resources`) SHALL be expressed as SQL `WHERE` clauses that constrain the scan at the storage layer.
- Pagination (`limit`, `cursor`, and per-parent limits in `expand`) SHALL be applied at the SQL layer via `ORDER BY` + `LIMIT` or window functions, not by loading the full set and `slice`-ing in application code.
- When a handler needs to iterate results, it SHALL stream via the driver's iterator API (e.g. `Statement.iterate()` in `better-sqlite3`) and stop as soon as the bounded page is assembled.
- Child-stream expansion SHALL filter the child scan by the parent page's foreign-key values **in SQL**, not fetch the whole child stream and group in application code.

Handlers MAY parse JSON columns into objects for the rows that survive into the response, but SHALL NOT parse JSON for rows that would be filtered out by access control.

This Requirement applies to the read paths enumerated above. Other read paths (if any) are out of scope for this change; bringing them under the same invariant is a follow-up.

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
- **THEN** the SQL query SHALL include `WHERE json_extract(record_json, '$.<consent_time_field>') BETWEEN A AND B` for each (connector, stream) pair it scans
- **AND** the query SHALL apply the handler's `limit` at the SQL layer
- **AND** the RS SHALL NOT scan and JSON-parse rows outside the window

### Requirement: The reference implementation SHALL cap per-route in-flight requests with coordinated client backpressure

The reference implementation SHALL enforce a configurable cap on concurrent in-flight requests per route. When the cap is reached, further requests to that route SHALL receive a `503 Service Unavailable` response until one of the in-flight requests completes.

The dashboard client (`apps/web/src/app/dashboard/**`) SHALL coordinate with this cap by (a) bounding its own parallel fan-out below the server cap, (b) retrying 503 responses with exponential backoff up to a bounded retry count, and (c) surfacing per-target failures as explicit partial-failure state rather than silently converting them to empty result sets.

#### Scenario: Dashboard fan-out exceeds the route cap

- **WHEN** more requests are made to a single route than `PDPP_MAX_INFLIGHT_PER_ROUTE` (default 4) while earlier requests are still processing
- **THEN** the excess requests SHALL receive `503 Service Unavailable` with a structured error envelope
- **AND** the server SHALL NOT enqueue an unbounded number of in-flight handlers

#### Scenario: Dashboard search receives a 503

- **WHEN** the dashboard search page fans out per-stream queries and one target returns `503`
- **THEN** the client SHALL retry that target up to twice with bounded backoff before considering it failed
- **AND** if retries are exhausted the client SHALL surface the failure as explicit partial-failure state (e.g. a `{records, failures}` return shape)
- **AND** the page SHALL render a visible indicator that some streams could not be queried — **not** treat the failure as "zero matching records"

### Requirement: The reference implementation SHALL enforce a response-size budget

The reference implementation SHALL enforce a configurable maximum response body size for non-blob routes. When a handler assembles a response larger than the configured limit, the RS SHALL emit a structured log record and return an error envelope rather than serialize the oversized body.

#### Scenario: Handler accidentally assembles a huge response

- **WHEN** an RS handler produces a response body whose JSON serialization would exceed `PDPP_MAX_RESPONSE_BYTES` (default 20 MB)
- **THEN** the RS SHALL emit a `warn`/`error` log record naming the route and estimated size
- **AND** the RS SHALL return a `500` with `error.code = 'response_too_large'` instead of serializing the body

### Requirement: The reference implementation SHALL be deployed under a supervisor

When the reference implementation runs as a long-lived service, the deployment SHALL wrap the Node process in a supervisor that restarts it on non-zero exit (including uncatchable native-level crashes such as SIGSEGV). A reference systemd unit and a reference PM2 ecosystem file SHALL be provided alongside the reference implementation.

#### Scenario: Native-level crash in production

- **WHEN** the reference implementation process exits non-zero (whether via a clean `process.exit(1)` from a fatal handler or an uncatchable SIGSEGV from a native addon)
- **THEN** the supervisor SHALL restart the process within seconds
- **AND** the previous crash's final structured log record SHALL be preserved in the deployment's log sink
