# reference-implementation-architecture Specification

## Purpose
Define the durable architecture and boundary rules for the PDPP reference implementation in this repository without competing with the normative PDPP protocol specs.
## Requirements
### Requirement: The reference implementation remains a forkable substrate
The forkable implementation substrate SHALL live in `reference-implementation/` and SHALL remain usable without the website runtime.

#### Scenario: An implementer evaluates the reference
- **WHEN** an implementer clones the repository to study or fork the reference implementation
- **THEN** they SHALL be able to run and understand the core reference substrate from `reference-implementation/` without depending on `apps/web`

#### Scenario: The website changes independently
- **WHEN** the website or docs application changes its internal implementation
- **THEN** the forkable reference substrate SHALL remain the authoritative runnable implementation artifact rather than becoming coupled to website-only code paths

### Requirement: The website is a downstream consumer
`apps/web` SHALL act as a downstream consumer of the reference implementation and SHALL not define the primary reference contract.

#### Scenario: A bridge route exists for the website
- **WHEN** `apps/web` exposes a bridge route to the reference implementation
- **THEN** that bridge SHALL reflect the current reference contract honestly and SHALL not invent a stronger or different protocol contract than the underlying reference implementation exposes

#### Scenario: The website needs traces or examples
- **WHEN** the website renders traces, examples, or demos derived from the reference implementation
- **THEN** those artifacts SHALL be treated as derived explanatory surfaces rather than as the implementation boundary itself

### Requirement: Native and polyfill realizations stay honest
The reference implementation SHALL support both native-provider and polyfill realizations over one engine substrate while keeping their public source identity honest.

#### Scenario: A native provider request is staged
- **WHEN** a client requests data from a native provider realization
- **THEN** the public request and public artifacts SHALL identify that source with `provider_id` rather than with a public `connector_id`

#### Scenario: A polyfill request is staged
- **WHEN** a client requests data from a connector-based or collected realization
- **THEN** the public request and public artifacts SHALL identify that source with `connector_id`

#### Scenario: Internal storage remains connector-shaped
- **WHEN** the implementation needs connector-shaped or storage-specific internal identifiers
- **THEN** those identifiers MAY remain internal implementation details, but they SHALL not leak into native-provider public artifacts unless explicitly documented as reference-only internals

#### Scenario: Native mode is configured
- **WHEN** the reference implementation starts in native-provider mode
- **THEN** the native manifest SHALL include explicit `provider_id` and structured `storage_binding`
- **AND** startup SHALL derive native provider identity and storage binding from that manifest rather than from separate native override flags

### Requirement: CLI and tests are first-class consumers
The CLI and executable tests SHALL consume the real public or reference-designated surfaces of the implementation rather than private database shortcuts or website-only glue.

#### Scenario: The CLI needs to inspect a reference object
- **WHEN** the CLI needs trace, grant, run, owner, or provider information
- **THEN** it SHALL use the relevant public or explicitly reference-designated HTTP surface rather than bypassing the server through direct database access

#### Scenario: The test suite verifies behavior
- **WHEN** executable tests prove reference behavior
- **THEN** those tests SHALL prefer black-box interaction with the running reference surfaces unless a narrower white-box test is intentionally justified for implementation internals

### Requirement: Reference-only surfaces are explicit
Debugging, replay, trace, and operator-control surfaces that are useful for the reference implementation but are not part of core PDPP SHALL be explicitly marked as reference-only.

#### Scenario: A trace or timeline endpoint is exposed
- **WHEN** the implementation exposes trace, timeline, or similar introspection surfaces
- **THEN** those surfaces SHALL be clearly described as reference-only artifacts rather than as core PDPP protocol requirements

#### Scenario: The current `_ref` read surface is treated as stable substrate
- **WHEN** the implementation exposes the current reference-designated event-spine readers
- **THEN** the durable `_ref` read surface SHALL stay limited to:
  - `GET /_ref/traces/:traceId`
  - `GET /_ref/grants/:grantId/timeline`
  - `GET /_ref/runs/:runId/timeline`
  - `GET /_ref/traces` (list, filter, paginate)
  - `GET /_ref/grants` (list, filter, paginate)
  - `GET /_ref/runs` (list, filter, paginate)
  - `GET /_ref/search?q=…` (id-aware read-only jump helper)

#### Scenario: A later control-plane phase widens `_ref` mutation narrowly
- **WHEN** a later control-plane phase needs a truthful operator mutation surface for a live bounded collection run
- **THEN** the reference MAY add an owner-only `_ref` mutation endpoint limited to:
  - `POST /_ref/runs/:runId/interaction`
- **AND** that route SHALL be documented as reference-only control-plane behavior rather than as a public PDPP API
- **AND** the reference SHALL NOT widen `_ref` into broader mutation/control endpoints in the same tranche without a further explicit OpenSpec change

#### Scenario: Run timelines expose checkpoint staging separately from checkpoint commit
- **WHEN** the reference runtime receives `STATE` during a bounded collection run
- **THEN** the `_ref` run timeline SHALL distinguish checkpoint staging from checkpoint commit so the checkpointed-streaming model is visible in reference artifacts rather than implied only by runtime internals

#### Scenario: Runtime validation failures remain inspectable in the reference substrate
- **WHEN** a bounded collection run fails because the runtime rejects connector output or an interaction handler response before `DONE`
- **THEN** the durable `_ref` run timeline SHALL still record `run.failed` with an explicit machine-readable reason instead of leaving that failure visible only as a thrown local error

#### Scenario: A future control plane is introduced
- **WHEN** a control plane, dashboard, or replay surface is built on top of the reference implementation
- **THEN** it SHALL consume the same public or reference-designated surfaces rather than becoming a hidden control path that the CLI or other consumers cannot use

### Requirement: Reference control-plane mutations require owner session when enabled
The reference implementation SHALL require the placeholder owner session on reference-only `_ref` mutation routes when owner auth is enabled. When owner auth is disabled, the reference implementation SHALL preserve the current open local-dev behavior for those routes.

#### Scenario: Owner auth is enabled and a mutation has no session
- **WHEN** a caller submits a `_ref` mutation request without a valid owner-session cookie while `PDPP_OWNER_PASSWORD` is configured
- **THEN** the reference SHALL reject the request with `401 owner_session_required`
- **AND** the route handler SHALL NOT perform the requested mutation

#### Scenario: Owner auth is enabled and a mutation has a session
- **WHEN** a caller submits a `_ref` mutation request with a valid owner-session cookie while `PDPP_OWNER_PASSWORD` is configured
- **THEN** the reference SHALL process the mutation according to the route's existing behavior

#### Scenario: Owner auth is disabled
- **WHEN** a caller submits a `_ref` mutation request while placeholder owner auth is disabled
- **THEN** the reference SHALL preserve the open local-dev behavior for that mutation route

#### Scenario: Reference read routes remain inspection surfaces
- **WHEN** a caller requests an existing `_ref` read route
- **THEN** this change SHALL NOT require owner-session authentication for that read route

### Requirement: Run interaction control is owner-only and ephemeral
The reference implementation SHALL treat dashboard-submitted responses to live run interactions as owner-only, reference-only control-plane actions for the current active run. Submitted values SHALL satisfy the current pending interaction only and SHALL NOT become durable credential storage.

#### Scenario: A pending interaction is answered successfully
- **WHEN** an owner submits `POST /_ref/runs/:runId/interaction` for the current pending interaction with `status: "success"` and any required `data`
- **THEN** the reference SHALL deliver a matching `INTERACTION_RESPONSE` back to the live run
- **AND** the run timeline SHALL continue to expose only the existing safe `run.interaction_completed` metadata rather than the submitted secret values

#### Scenario: A pending interaction is cancelled
- **WHEN** an owner submits `POST /_ref/runs/:runId/interaction` for the current pending interaction with `status: "cancelled"`
- **THEN** the reference SHALL deliver a matching cancelled `INTERACTION_RESPONSE` back to the live run
- **AND** the runtime SHALL remain the authority for any resulting run failure or completion behavior

#### Scenario: A stale or non-current interaction response is submitted
- **WHEN** a caller submits an interaction response for an unknown run, a non-active run, a run with no current pending interaction, or an `interaction_id` that no longer matches the current pending interaction
- **THEN** the reference SHALL reject the request honestly instead of fabricating an interaction completion

#### Scenario: A dashboard-submitted credential is processed
- **WHEN** an owner submits credentials or OTP data through the run interaction control endpoint
- **THEN** the reference SHALL use those values only to satisfy the current pending interaction
- **AND** it SHALL NOT write those values to `.env.local`, durable SQLite state, or other long-lived reference configuration as part of this control-plane action

### Requirement: The Collection boundary stays explicit
The reference implementation SHALL keep the Collection boundary explicit across core semantics, Collection Profile semantics, and runtime-only behavior.

#### Scenario: Shared collection semantics are classified
- **WHEN** behavior concerns RECORD envelopes, streams, scope, tombstones, or state/checkpoint semantics shared across collection and disclosure paths
- **THEN** those semantics SHALL be treated as core/shared semantics rather than as ad hoc runtime details

#### Scenario: Bounded-run collection behavior is classified
- **WHEN** behavior concerns START, INTERACTION, RECORD, STATE, DONE, binding matching, or run-scoped lifecycle rules for collected/polyfill sources
- **THEN** that behavior SHALL be treated as Collection Profile behavior rather than as native-provider contract surface

#### Scenario: Orchestrator behavior is classified
- **WHEN** behavior concerns scheduling, retry, credential storage, webhook adaptation, batch import, or multi-connector coordination
- **THEN** it SHALL be treated as runtime/orchestrator behavior unless and until a concrete interoperability need justifies a new profile

#### Scenario: The reference makes an optimistic collection choice before the spec is fully frozen
- **WHEN** the reference implementation enforces a strong Collection Profile behavior before the PDPP spec is fully settled
- **THEN** that behavior SHALL be labeled as either an interoperability requirement to be pushed into the Collection Profile spec or as a reference-only choice that does not yet claim normative status

### Requirement: Open design questions stay explicit
The reference implementation SHALL keep unresolved design questions explicit in OpenSpec whenever implementation work materially narrows the plausible design space without fully settling the normative PDPP answer.

#### Scenario: Collection run durability semantics are still unsettled
- **WHEN** the reference implementation behaves like a checkpointed streaming system where writes may become durable before checkpoint commit
- **THEN** OpenSpec SHALL record that open question explicitly rather than implying that the Collection Profile already guarantees atomic run semantics

#### Scenario: Cross-stream checkpoint flush semantics are still unsettled
- **WHEN** the reference runtime flushes and stages checkpoint input only for the stream named in a `STATE` message while leaving other buffered streams untouched
- **THEN** OpenSpec SHALL record whether that per-stream checkpoint boundary is intended to become Collection Profile normativity or remain a reference/runtime choice

#### Scenario: Failed DONE checkpoint semantics are still unsettled
- **WHEN** the reference runtime receives `DONE` with `status: "failed"` after one or more streams have already staged checkpoint input
- **THEN** OpenSpec SHALL record whether that failed terminal status is intended to become a normative no-checkpoint-commit boundary or remain a reference/runtime choice

#### Scenario: Cross-stream checkpoint commit failures after successful DONE remain unsettled
- **WHEN** the reference runtime reaches `DONE(status="succeeded")` but a later checkpoint persistence write fails after one or more earlier stream checkpoints have already committed
- **THEN** OpenSpec SHALL record whether partial cross-stream checkpoint commit is an acceptable reference/runtime outcome or whether successful terminal runs are expected to provide stronger atomic checkpoint guarantees

#### Scenario: Post-DONE protocol violations still interact with checkpointed streaming
- **WHEN** a connector emits additional messages after `DONE` and the reference runtime invalidates the run as a protocol violation after some writes may already be durable
- **THEN** OpenSpec SHALL record whether that terminal violation is intended to preserve already-flushed writes under the checkpointed-streaming model or whether stronger atomic rollback guarantees should exist

#### Scenario: Connector-reported terminal counters are validated before the spec is fully settled
- **WHEN** the reference runtime rejects a run because connector-reported terminal counters such as `DONE.records_emitted` do not match the runtime-observed run output
- **THEN** OpenSpec SHALL record whether those counter validations are intended to become Collection Profile normativity or remain a strong reference/runtime validation choice

#### Scenario: Interaction terminal-status semantics are still unsettled
- **WHEN** the reference runtime auto-responds to an `INTERACTION` request with terminal statuses such as `timeout` or `cancelled`
- **THEN** OpenSpec SHALL record whether those terminal-status semantics are intended to become Collection Profile normativity or remain reference/runtime-only choices

#### Scenario: Progress and skip lifecycle artifacts narrow the event-spine boundary without settling profile normativity
- **WHEN** the reference runtime turns connector `PROGRESS` and `SKIP_RESULT` messages into durable `_ref` run events
- **THEN** OpenSpec SHALL record whether those messages are intended to remain reference/runtime observability artifacts only or eventually become part of a stronger Collection Profile or sibling-profile contract

#### Scenario: Connector-declared terminal error details narrow the collection/runtime boundary without settling profile normativity
- **WHEN** the reference runtime preserves validated connector-declared `DONE.error` details only for failed or cancelled terminal states, rejects contradictory success terminals, and rejects unsupported terminal-error fields beyond the current minimal shape
- **THEN** OpenSpec SHALL record whether those terminal error details are intended to become Collection Profile normativity, including whether they are failure-only, or remain reference/runtime-only observability fields

#### Scenario: Provider-connect launch scope is intentionally broader than a single trust path
- **WHEN** the reference implementation supports multiple provider-connect paths such as owner self-export, pre-registered clients, and protected DCR
- **THEN** OpenSpec SHALL record which trust/bootstrap paths are part of the launch reference target and which remain open design questions

#### Scenario: Pending-consent manifest pinning remains explicit
- **WHEN** the reference implementation pins staged pending-consent requests to the manifest version resolved at `/oauth/par`
- **THEN** OpenSpec SHALL record whether that manifest-version pinning is intended to become part of the provider-connect contract or remain a stronger reference-only hardening choice

#### Scenario: Pending-consent client registration re-resolution remains explicit
- **WHEN** the reference implementation re-resolves the registered client during consent display and approval instead of trusting the staged pending-consent client snapshot
- **THEN** OpenSpec SHALL record whether consent-time client re-resolution is intended to become part of the provider-connect contract or remain a stronger reference-only hardening choice

#### Scenario: Internal/native honesty is not fully settled
- **WHEN** the reference implementation keeps connector-shaped internal seams while presenting a provider-first native public contract
- **THEN** OpenSpec SHALL record whether that split is considered an acceptable long-term implementation detail or an area for future internal realignment

#### Scenario: Grant persistence uses structured storage binding only
- **WHEN** the reference implementation persists grant storage bindings
- **THEN** it SHALL use the explicit structured `storage_binding_json` model rather than a second scalar compatibility column

#### Scenario: Pending consent and grant reads require current structured bindings
- **WHEN** the reference implementation reads persisted pending-consent requests or grant-bound disclosure state
- **THEN** it SHALL require explicit structured `source_binding`, `storage_binding`, and `grant.source` data rather than self-healing malformed persisted rows from ambient native configuration

#### Scenario: Reference-only observability surfaces may grow into a control plane
- **WHEN** trace, timeline, replay, or other `_ref` surfaces exist before a full control plane is designed
- **THEN** OpenSpec SHALL record which of those surfaces are durable reference-only boundaries and which future operator/control-plane questions remain unresolved

### Requirement: OpenSpec architecture stays project-scoped
This architecture specification SHALL define repository-level implementation boundaries and SHALL not become a second normative PDPP protocol specification.

#### Scenario: Root PDPP stream metadata semantics are settled
- **WHEN** the root PDPP specifications define `GET /v1/streams/{stream}` as returning full source stream metadata rather than a grant-projected view
- **THEN** the reference implementation SHALL keep `stream_metadata` source-level
- **AND** it SHALL enforce grants through authorization, queries, and record disclosure rather than by projecting the stream metadata document itself

#### Scenario: A protocol semantic changes
- **WHEN** a change alters normative PDPP protocol semantics
- **THEN** the relevant root PDPP spec file SHALL be updated and this architecture spec MAY only describe the resulting implementation impact at a project boundary level

#### Scenario: Architecture guidance needs protocol context
- **WHEN** this architecture spec depends on protocol concepts such as grants, `authorization_details`, collection runs, or owner tokens
- **THEN** it SHALL rely on the root PDPP specs as the normative source for those concepts rather than redefining them here

### Requirement: The RS read-path for enumerated routes SHALL not materialize unbounded result arrays

The resource-server SHALL NOT execute a query whose result is an unbounded scan of a JSON-column table on the read paths covered by this change, which are:

- `GET /v1/streams/:stream/records` (including `expand=…`)
- `GET /v1/streams/:stream/records/:id` (including `expand=…`)
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
- **THEN** for each `(connector, stream)` pair it scans, the SQL query SHALL include a predicate against `COALESCE(NULLIF(json_extract(record_json, '$.<semantic_field>'), ''), emitted_at)` (native mode) or `emitted_at` (emitted mode) between the normalized `A`/`B` boundaries
- **AND** the query SHALL apply a per-pair SQL `LIMIT`
- **AND** the RS SHALL NOT scan and JSON-parse rows outside the window

Note — deferred standing defenses: additional runtime defenses (per-route in-flight concurrency cap with coupled dashboard 503 retry + partial-failure coordination, response-size budget hook, process-supervisor mandate) were considered and deferred because the read-path rewrite above resolved the measured crash pathology on its own (5/5 repro runs survived post-fix; old-space peak dropped from 600–730 MB to ~14 MB). They remain open follow-ups, to be taken up only when a measured remaining problem justifies the scope. See `openspec/changes/archive/2026-04-24-fix-rs-query-memory-pressure/` (`proposal.md` §Follow-ups and `tasks.md` §6) for the full rationale, intended shapes, and implementation notes.

### Requirement: The reference implementation SHALL emit a structured completion log for every request

When the reference implementation is running as a server (whether as a CLI entrypoint or as a library-embedded instance), every inbound HTTP request SHALL produce a single completion log record containing `req_id`, HTTP method, path, `statusCode`, and `responseTime` in milliseconds. The record SHALL be emitted at `info` level. The record's structured field set SHALL be identical across all environments; only terminal formatting MAY differ between development and production.

#### Scenario: Successful request produces a completion record
- **WHEN** a client calls an AS or RS endpoint
- **THEN** exactly one request-completion log record SHALL be emitted
- **AND** that record SHALL include `req_id`, method, path, `statusCode`, and `responseTime`

#### Scenario: Completion record shape is environment-independent
- **WHEN** the same request is served under `NODE_ENV=production` and under non-production
- **THEN** the set of structured fields in the completion record SHALL be identical across both environments

### Requirement: Request-scoped logs SHALL carry protocol trace correlation

The reference implementation SHALL rebind the Fastify request-scoped logger to include `trace_id`, `scenario_id`, `actor_type`, and `actor_id` as child-logger fields once those values are resolved for the request. Any log record emitted by handler code after that rebind SHALL carry those fields when they are present for the request. Requests for which no `trace_id` is established (e.g. static metadata endpoints that do not participate in the event spine) SHALL NOT have a synthetic `trace_id` fabricated.

#### Scenario: Handler log line inherits trace correlation
- **WHEN** a handler resolves a `trace_id` for a request and then calls `request.log.info(...)`
- **THEN** the emitted record SHALL include both `req_id` and `trace_id`

#### Scenario: No trace resolved means no trace_id field
- **WHEN** a request completes without the reference implementation establishing a `trace_id` for it
- **THEN** the completion record SHALL NOT include a `trace_id` field

### Requirement: The reference implementation SHALL redact known secret paths in log output

Structured log output SHALL NOT contain the plaintext of access tokens, refresh tokens, device codes, user codes, the `Authorization` header value, or the `interaction_response` payload used in hosted-UI flows. Redaction SHALL be configured declaratively at the logger, not performed per call site.

#### Scenario: A handler logs an object containing a token
- **WHEN** a handler passes an object with `access_token` or `refresh_token` into a log call
- **THEN** the emitted record SHALL show the token value as `<redacted>` (or equivalent censor value), not the plaintext

#### Scenario: An Authorization header is captured by the default request serializer
- **WHEN** the logger's request serializer records request headers
- **THEN** the `Authorization` header value SHALL appear redacted, not in plaintext

### Requirement: The CLI entrypoint SHALL produce a final structured log record on crash or signal

When `reference-implementation/server/index.js` is run as a CLI entrypoint, it SHALL install process-level handlers for `uncaughtException`, `unhandledRejection`, `SIGTERM`, and `SIGINT`. Each handler SHALL emit exactly one log record before the process exits. These handlers SHALL NOT be installed when `server/index.js` is imported as a library (for example, from a test harness); the reference implementation SHALL NOT register global `process.on` listeners from any code path other than the CLI entrypoint block.

#### Scenario: Uncaught exception at the CLI entrypoint
- **WHEN** the CLI is running and code in a request handler or background task throws and the error is not otherwise caught
- **THEN** exactly one `fatal` log record SHALL be emitted on stdout with the error name, message, and stack before the process exits with a non-zero code

#### Scenario: Unhandled promise rejection at the CLI entrypoint
- **WHEN** the CLI is running and a promise rejection propagates to the top level
- **THEN** exactly one `fatal` log record SHALL be emitted on stdout with the rejection reason and stack before the process exits with a non-zero code

#### Scenario: Termination signal at the CLI entrypoint
- **WHEN** the CLI process receives `SIGTERM` or `SIGINT`
- **THEN** exactly one `info` log record SHALL be emitted on stdout naming the signal before the process performs graceful shutdown and exits

#### Scenario: Library import does not pollute the process
- **WHEN** a test or another Node program imports `startServer` from `server/index.js` and calls it one or more times
- **THEN** the reference implementation SHALL NOT add any listeners to `process` for `uncaughtException`, `unhandledRejection`, `SIGTERM`, or `SIGINT`

### Requirement: Log shape SHALL be JSON; development output MAY be pretty-printed for the terminal only

The reference implementation SHALL produce log records as JSON objects at the point of emission. In production (`NODE_ENV === 'production'`) those JSON objects SHALL be written to stdout verbatim as one JSON line per record. In all other environments a terminal-local transform MAY reformat records for human reading. The transform SHALL NOT add, remove, or rename structured fields in the underlying record.

#### Scenario: Production deployment emits JSON lines
- **WHEN** the reference implementation starts with `NODE_ENV=production`
- **THEN** every log line on stdout SHALL be a single JSON object consumable by a downstream log aggregator without further parsing

#### Scenario: Local dev emits pretty-printed lines carrying the same structured fields
- **WHEN** the reference implementation starts without `NODE_ENV=production`
- **THEN** log output MAY be pretty-printed for the terminal
- **AND** every structured field present in the production JSON form SHALL remain observable in the pretty form

### Requirement: Log field names SHALL be compatible with the OpenTelemetry log data model

The reference implementation's log records SHALL use `trace_id` (not `traceId`, `trace`, or `traceID`) for the protocol event-spine identifier. The field `span_id` SHALL be reserved for future OpenTelemetry alignment and SHALL NOT be repurposed for other concepts. Request identifiers SHALL be named `req_id`.

#### Scenario: A reviewer inspects log output for OTel compatibility
- **WHEN** a reviewer reads log records produced by the reference implementation
- **THEN** trace identifiers SHALL appear under the field name `trace_id`
- **AND** the field name `span_id` SHALL NOT be used for anything other than an OTel-shaped span identifier if emitted

### Requirement: The reference SHALL realize the lexical-retrieval extension over a single internal enforcement path

The reference implementation SHALL realize the public `lexical-retrieval` extension defined in the `lexical-retrieval` capability through one internal helper that performs grant resolution, plan construction, and grant-safe snippet generation in the same code path. The public `GET /v1/search` route handler SHALL delegate to that helper. Reference-internal callers (including the website dashboard) SHALL reach lexical retrieval through the same public route over HTTP, not through a parallel direct-database path. The reference SHALL NOT define a second lexical retrieval contract.

#### Scenario: The dashboard searches owner records
- **WHEN** the website dashboard search page renders results for an owner
- **THEN** it SHALL obtain those results by calling the public `GET /v1/search` endpoint of the resource server with the dashboard's owner-bound bearer token
- **AND** it SHALL NOT compute results by fanning out per-stream record-list calls and substring-matching their JSON payloads in application code

#### Scenario: A second internal callsite is proposed
- **WHEN** any reference-side caller (CLI, dashboard, future operator surface) needs lexical retrieval over authorized records
- **THEN** that caller SHALL go through `GET /v1/search` (or, in-process, the single internal helper that the route delegates to)
- **AND** SHALL NOT reach into the FTS5 index, manifest validator, or grant resolver to assemble its own lexical retrieval contract

### Requirement: The reference's manifest validator SHALL enforce the v1 `lexical_fields` shape

When a connector manifest declares `query.search.lexical_fields` on any stream, the reference's manifest validator SHALL enforce the v1 shape constraints. The validator SHALL reject manifests whose declarations would let the public extension search anything other than top-level scalar string fields named in the stream's schema.

#### Scenario: A manifest declares a nested path as a lexical field
- **WHEN** a manifest declares `query.search.lexical_fields: ["data.body"]` (a nested path) on a stream
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

#### Scenario: A manifest declares an array-typed schema field as a lexical field
- **WHEN** a manifest declares `query.search.lexical_fields: ["tags"]` and the stream's schema lists `tags` as `type: "array"`
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

#### Scenario: A manifest declares a non-existent field as a lexical field
- **WHEN** a manifest declares `query.search.lexical_fields: ["nonexistent"]` and `nonexistent` is not in `schema.properties`
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

#### Scenario: A manifest declares an empty lexical_fields array
- **WHEN** a manifest declares `query.search.lexical_fields: []`
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

### Requirement: The reference SHALL publish the `capabilities.lexical_retrieval` advertisement on its existing protected-resource metadata document

When the reference exposes the lexical-retrieval extension, the existing RFC 9728 protected-resource metadata document the reference already serves SHALL include a `capabilities.lexical_retrieval` object carrying all six required keys. The reference SHALL NOT introduce a new metadata document for this advertisement, and SHALL NOT publish the advertisement on the authorization-server metadata document.

#### Scenario: The advertisement is co-located with existing RS metadata
- **WHEN** a client retrieves the reference's protected-resource metadata document
- **THEN** the response SHALL include `capabilities.lexical_retrieval` with `supported`, `endpoint`, `cross_stream`, `snippets`, `default_limit`, and `max_limit`
- **AND** the reference SHALL NOT serve the advertisement from a separately discoverable metadata document

#### Scenario: A reference fork wishes to publish the extension as unsupported
- **WHEN** a reference fork or test harness configures the reference to omit the extension
- **THEN** the protected-resource metadata document SHALL either omit `capabilities.lexical_retrieval` entirely or include it with `supported: false`

### Requirement: The reference's lexical retrieval index SHALL index only declared `lexical_fields`

The reference's local search backing (a SQLite FTS5 virtual table) SHALL contain entries only for `(stream, record_key, field)` tuples where `field` appears in the corresponding stream's `query.search.lexical_fields` declaration. Records of streams that do not declare `lexical_fields` SHALL NOT contribute index rows. Non-declared fields of records of streams that do declare `lexical_fields` SHALL NOT contribute index rows.

#### Scenario: A non-participating stream has new records
- **WHEN** new records arrive for a stream whose manifest does not declare `query.search.lexical_fields`
- **THEN** the FTS5 lexical search index SHALL NOT receive new rows for that stream

#### Scenario: A participating stream has new records
- **WHEN** new records arrive for a stream whose manifest declares `lexical_fields: ["a", "b"]`
- **THEN** the FTS5 lexical search index SHALL receive exactly two rows for each record (one per declared field)
- **AND** SHALL NOT receive rows for any other field of that record

#### Scenario: The index drifts from the records table
- **WHEN** the reference starts and detects a mismatch between the records table and the FTS5 index for one or more participating streams
- **THEN** the reference SHALL rebuild the index from the records table for the affected streams

### Requirement: The reference SHALL realize owner-token lexical retrieval through cross-connector fan-out

The reference scopes owner reads of records and stream metadata per connector. The reference SHALL realize owner-token lexical retrieval by fanning out across every owner-visible connector internally and merging results, so that the public `GET /v1/search` request shape stays identical for owner-token and client-token callers (no public `connector_id` query parameter). Each `search_result` returned to an owner-token caller SHALL carry the originating connector via `connector_id` so the caller can hydrate the record under the correct per-connector owner read scope. The reference SHALL emit a `record_url` that includes the canonical owner-mode `connector_id` query parameter for owner-token callers.

#### Scenario: An owner searches across two connectors that both expose the same stream name
- **WHEN** an owner-token caller invokes `GET /v1/search?q=alpha` on a reference instance with two owner-visible connectors `C1` and `C2`, both of which expose a `messages` stream that declares `lexical_fields: ["text"]` and both of which contain a record matching `alpha`
- **THEN** the response SHALL include hits from BOTH connectors
- **AND** each hit SHALL carry its originating `connector_id` (`"C1"` for hits from `C1`, `"C2"` for hits from `C2`)
- **AND** the response SHALL NOT silently scope to a single connector

#### Scenario: An owner request includes `connector_id`
- **WHEN** an owner-token caller invokes `GET /v1/search?q=alpha&connector_id=C1`
- **THEN** the reference SHALL reject the request with `invalid_request_error` identifying `connector_id` as the rejected parameter
- **AND** SHALL NOT silently use `connector_id` to scope the search

#### Scenario: An owner-mode `record_url` is hydrated
- **WHEN** an owner-token caller takes the `record_url` from a `/v1/search` hit and issues a GET against it under the same owner token
- **THEN** the reference SHALL return the canonical record envelope at `GET /v1/streams/{stream}/records/{record_key}` for the connector identified by the URL's `connector_id` query parameter

### Requirement: The reference's lexical retrieval index SHALL include connector identity in every row

Because the reference's owner reads are per-connector, the lexical retrieval index SHALL include the originating `connector_id` on every indexed row so that owner-mode hits can be attributed to a connector for hydration. Insert/update/delete maintenance for a record SHALL include that record's `connector_id`. Reference search results SHALL carry the indexed `connector_id` through to the `search_result.connector_id` field of the public response.

#### Scenario: Records for two connectors are indexed
- **WHEN** records arrive for stream `messages` from connectors `C1` and `C2`, both of which declare `lexical_fields: ["text"]`
- **THEN** the FTS5 lexical search index SHALL contain rows attributed to `C1` for `C1`'s records and rows attributed to `C2` for `C2`'s records
- **AND** SHALL NOT silently merge rows under a single shared connector identity

#### Scenario: A search result is attributed to its originating connector
- **WHEN** the reference returns a `search_result` to a caller
- **THEN** that result's `connector_id` SHALL be the `connector_id` recorded on the matching index row at insert time
- **AND** the reference SHALL NOT fabricate `connector_id` from configuration or from the caller's identity

### Requirement: The reference SHALL keep `/_ref/search` distinct from `/v1/search`

The reference SHALL NOT alias `/_ref/search` to `/v1/search`, SHALL NOT serve the public lexical retrieval contract from `/_ref/search`, and SHALL NOT advertise `/_ref/search` as the public lexical retrieval endpoint. The reference's source code SHALL note `/_ref/search`'s reference-only status near its handler so future readers cannot mistake it for the public surface.

#### Scenario: A client requests `/_ref/search`
- **WHEN** a client calls `/_ref/search?q=...`
- **THEN** the response SHALL be the existing reference-only spine artifact-and-id-jump shape
- **AND** the response SHALL NOT match the public `search_result` list envelope returned by `/v1/search`

#### Scenario: A reader inspects the reference source
- **WHEN** a reader reads the source for `/_ref/search` in `reference-implementation/server/index.js`
- **THEN** an inline comment SHALL identify the route as reference-only and SHALL point readers to `GET /v1/search` for the public lexical retrieval surface

### Requirement: The reference SHALL realize the semantic-retrieval experimental extension over a single internal enforcement path

The reference implementation SHALL realize the public `semantic-retrieval` extension defined in the `semantic-retrieval` capability through one internal helper that performs grant resolution, plan construction, embedding invocation, vector-index lookup, and grant-safe snippet generation in the same code path. The public `GET /v1/search/semantic` route handler SHALL delegate to that helper. Reference-internal callers (including the website dashboard) SHALL reach semantic retrieval through the same public route over HTTP, not through a parallel direct-database path. The reference SHALL NOT define a second semantic retrieval contract.

#### Scenario: The dashboard helper reaches semantic retrieval through the public route
- **WHEN** a reference-side caller in `apps/web/src/app/dashboard/lib/rs-client.ts` requests semantic retrieval over owner records
- **THEN** it SHALL obtain those results by calling the public `GET /v1/search/semantic` endpoint with an owner-bound bearer token
- **AND** it SHALL NOT compute semantic results by reaching into the vector index or the embedding backend directly

#### Scenario: A second internal callsite is proposed
- **WHEN** any reference-side caller (CLI, dashboard, future operator surface) needs semantic retrieval over authorized records
- **THEN** that caller SHALL go through `GET /v1/search/semantic` (or, in-process, the single internal helper that the route delegates to)
- **AND** SHALL NOT reach into the vector index, the embedding backend, the manifest validator, or the grant resolver to assemble its own semantic retrieval contract

### Requirement: The reference's manifest validator SHALL enforce the v1 `semantic_fields` shape independently of `lexical_fields`

When a connector manifest declares `query.search.semantic_fields` on any stream, the reference's manifest validator SHALL enforce the v1 shape constraints. The validator SHALL reject manifests whose declarations would let the public extension embed or match anything other than top-level scalar string fields named in the stream's schema. The `semantic_fields` enforcement SHALL run independently of `lexical_fields` enforcement: either, both, or neither MAY be declared on a stream.

#### Scenario: A manifest declares a nested path as a semantic field
- **WHEN** a manifest declares `query.search.semantic_fields: ["data.body"]` on a stream
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

#### Scenario: A manifest declares an array-typed schema field as a semantic field
- **WHEN** a manifest declares `query.search.semantic_fields: ["tags"]` and the stream's schema lists `tags` as `type: "array"`
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

#### Scenario: A manifest declares a blob-typed schema field as a semantic field
- **WHEN** a manifest declares `query.search.semantic_fields: ["attachment"]` and the stream's schema lists `attachment` as a blob reference
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

#### Scenario: A manifest declares a non-existent field as a semantic field
- **WHEN** a manifest declares `query.search.semantic_fields: ["nonexistent"]` and `nonexistent` is not in `schema.properties`
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

#### Scenario: A manifest declares an empty semantic_fields array
- **WHEN** a manifest declares `query.search.semantic_fields: []`
- **THEN** the reference's manifest validator SHALL reject registration of that manifest

#### Scenario: A manifest declares only `semantic_fields` (no `lexical_fields`)
- **WHEN** a manifest declares `query.search.semantic_fields: ["text"]` on a stream and does NOT declare `query.search.lexical_fields` on that stream
- **THEN** the reference's manifest validator SHALL accept the manifest
- **AND** the stream SHALL participate in semantic retrieval but not lexical retrieval

#### Scenario: A manifest declares `lexical_fields` and `semantic_fields` with different contents
- **WHEN** a manifest declares `query.search.lexical_fields: ["title", "subject"]` and `query.search.semantic_fields: ["title", "body"]` on a stream
- **THEN** the reference's manifest validator SHALL accept the manifest
- **AND** lexical retrieval SHALL match only over `["title", "subject"]` on that stream
- **AND** semantic retrieval SHALL match only over `["title", "body"]` on that stream

### Requirement: The reference SHALL publish the `capabilities.semantic_retrieval` advertisement on its existing protected-resource metadata document with truthful experimental stability

When the reference exposes the semantic-retrieval extension, the existing RFC 9728 protected-resource metadata document the reference already serves SHALL include a `capabilities.semantic_retrieval` object carrying all required keys. The `stability` key SHALL be the literal string `"experimental"` in v1. The reference SHALL NOT introduce a new metadata document for this advertisement, and SHALL NOT publish the advertisement on the authorization-server metadata document. The reference SHALL NOT publish `supported: true` unless both an embedding backend and a vector index are configured and available.

#### Scenario: The advertisement is co-located with existing RS metadata
- **WHEN** a client retrieves the reference's protected-resource metadata document
- **THEN** the response SHALL include `capabilities.semantic_retrieval` with the required keys when the extension is exposed
- **AND** the reference SHALL NOT serve the advertisement from a separately discoverable metadata document

#### Scenario: The advertisement carries the experimental stability marker
- **WHEN** the reference publishes `capabilities.semantic_retrieval.supported: true`
- **THEN** the same advertisement SHALL include `stability: "experimental"`
- **AND** the reference SHALL NOT publish `stability: "stable"` on this extension in v1

#### Scenario: The advertisement declares text-only query input
- **WHEN** the reference publishes `capabilities.semantic_retrieval.supported: true`
- **THEN** the same advertisement SHALL include `query_input: "text"` in v1
- **AND** SHALL NOT include `query_input: "vector"` or `query_input: "hybrid"` in v1

#### Scenario: The advertisement declares `lexical_blending: false` in this tranche
- **WHEN** the reference publishes `capabilities.semantic_retrieval.supported: true` in this tranche
- **THEN** the same advertisement SHALL include `lexical_blending: false`
- **AND** every result emitted on `GET /v1/search/semantic` SHALL carry `retrieval_mode: "semantic"`

#### Scenario: The advertisement's `model`, `dimensions`, and `distance_metric` come from the configured backend
- **WHEN** the reference assembles the `capabilities.semantic_retrieval` object
- **THEN** the `model` value SHALL be the server-declared model identifier returned by the configured embedding backend
- **AND** the `dimensions` value SHALL be the integer dimension returned by the configured embedding backend
- **AND** the `distance_metric` value SHALL be one of `"cosine"`, `"dot"`, or `"l2"` returned by the configured embedding backend
- **AND** these values SHALL NOT be set from static configuration unrelated to the backend actually in use

#### Scenario: A reference instance with no embedding backend configured
- **WHEN** the reference is started without an embedding backend or without a vector index
- **THEN** the protected-resource metadata document SHALL either omit `capabilities.semantic_retrieval` entirely or include it with `supported: false`
- **AND** the reference SHALL NOT register the `GET /v1/search/semantic` route
- **AND** requests to `GET /v1/search/semantic` SHALL return `404` or `not_found_error`

#### Scenario: The advertisement is discoverable without a grant
- **WHEN** an unauthenticated client requests the reference's protected-resource metadata document
- **THEN** the `capabilities.semantic_retrieval` advertisement, if present, SHALL be returned without requiring a bearer token

#### Scenario: The advertisement is independent of the lexical retrieval advertisement
- **WHEN** the reference publishes protected-resource metadata
- **THEN** the presence or absence of `capabilities.semantic_retrieval` SHALL be independent of the presence or absence of `capabilities.lexical_retrieval`
- **AND** toggling one SHALL NOT toggle the other

### Requirement: The reference's vector index SHALL embed and store only declared `semantic_fields`

The reference's local vector index SHALL contain entries only for `(stream, record_key, field, connector_id)` tuples where `field` appears in the corresponding stream's `query.search.semantic_fields` declaration. Records of streams that do not declare `semantic_fields` SHALL NOT contribute index rows. Non-declared fields of records of streams that do declare `semantic_fields` SHALL NOT be embedded and SHALL NOT contribute index rows.

#### Scenario: A non-participating stream has new records
- **WHEN** new records arrive for a stream whose manifest does not declare `query.search.semantic_fields`
- **THEN** the reference's vector index SHALL NOT receive new rows for that stream
- **AND** the embedding backend SHALL NOT be invoked for records of that stream

#### Scenario: A participating stream has new records
- **WHEN** new records arrive for a stream whose manifest declares `semantic_fields: ["a", "b"]`
- **THEN** the reference's vector index SHALL receive exactly two rows for each record (one per declared field)
- **AND** SHALL NOT receive rows for any other field of that record

#### Scenario: A stream loses its `semantic_fields` declaration
- **WHEN** a manifest update removes `query.search.semantic_fields` from a stream
- **THEN** the reference SHALL remove all vector-index rows for that stream
- **AND** the stream SHALL contribute zero hits on subsequent semantic searches

### Requirement: The reference's vector index SHALL include connector identity on every row

Because the reference's owner reads are per-connector, the vector index SHALL include the originating `connector_id` on every indexed row so that owner-mode hits can be attributed to a connector for hydration. Insert/update/delete maintenance for a record SHALL include that record's `connector_id`. Reference semantic search results SHALL carry the indexed `connector_id` through to the `search_result.connector_id` field of the public response.

#### Scenario: Records for two connectors are indexed
- **WHEN** records arrive for stream `messages` from connectors `C1` and `C2`, both of which declare `semantic_fields: ["text"]`
- **THEN** the reference's vector index SHALL contain rows attributed to `C1` for `C1`'s records and rows attributed to `C2` for `C2`'s records
- **AND** SHALL NOT silently merge rows under a single shared connector identity

#### Scenario: A search result is attributed to its originating connector
- **WHEN** the reference returns a `search_result` to a caller
- **THEN** that result's `connector_id` SHALL be the `connector_id` recorded on the matching index row at insert time
- **AND** the reference SHALL NOT fabricate `connector_id` from configuration or from the caller's identity

### Requirement: The reference SHALL report `index_state` honestly and rebuild on drift

The reference SHALL persist per-(connector_id, stream) metadata describing the declared `semantic_fields` fingerprint and the backend's `model_id`, `dimensions`, and `distance_metric` at insert time. The reference SHALL detect drift on startup and on every connector registration/update, and SHALL report `index_state` in the capability advertisement honestly.

#### Scenario: `semantic_fields` fingerprint changes
- **WHEN** a manifest update changes the declared `semantic_fields` set for a `(connector_id, stream)` tuple in a way that changes the sorted JSON fingerprint
- **THEN** the reference SHALL report `index_state: "stale"` in the advertisement until a rebuild for that `(connector_id, stream)` restores coverage
- **AND** the reference SHALL rebuild the index for the affected `(connector_id, stream)` and remove stale rows
- **AND** the rebuild SHALL be maintained in JavaScript at the record write/update/delete call sites, not by SQLite triggers

#### Scenario: The configured embedding backend's `model_id` changes
- **WHEN** the configured embedding backend's `model_id` disagrees with the `model_id` persisted in `semantic_search_meta` for any row
- **THEN** the reference SHALL report `index_state: "stale"` in the advertisement until a rebuild restores coverage

#### Scenario: The configured embedding backend's `dimensions` or `distance_metric` changes
- **WHEN** the configured embedding backend's `dimensions` or `distance_metric` disagrees with persisted metadata
- **THEN** the reference SHALL report `index_state: "stale"` in the advertisement until a rebuild restores coverage

#### Scenario: The index is actively rebuilding
- **WHEN** the reference is rebuilding the vector index for any reason
- **THEN** the reference SHALL report `index_state: "building"` in the advertisement until rebuild completes

#### Scenario: Steady state
- **WHEN** no drift signal is active and no rebuild is in progress
- **THEN** the reference SHALL report `index_state: "built"` in the advertisement

### Requirement: The reference's default semantic index SHALL persist across process restarts

The reference's default vector index SHALL store embeddings persistently in the same SQLite database used by the rest of the reference, so that semantic coverage survives process restart. The reference SHALL prefer `sqlite-vec` as the default persistent backend when its SQLite extension can be loaded, and SHALL fall back to a persistent SQLite-BLOB flat backend (same database, `BLOB`-columned table, distance computed in JavaScript) when `sqlite-vec` cannot be loaded. Both backends SHALL implement the same `VectorIndex` interface. Neither backend SHALL require ephemeral in-process state for `capabilities.semantic_retrieval.supported: true`.

#### Scenario: `sqlite-vec` loads successfully at init
- **WHEN** the reference opens its `better-sqlite3` database at startup and `sqliteVec.load(db)` succeeds
- **THEN** the reference SHALL use the `sqlite-vec`-backed `VectorIndex` implementation (a `vec0` virtual table in the same database)
- **AND** the reference SHALL log a startup line identifying the chosen backend as `sqlite-vec`
- **AND** subsequent `upsert`, `delete`, and `query` calls SHALL operate against the `vec0` virtual table

#### Scenario: `sqlite-vec` fails to load at init
- **WHEN** the reference opens its `better-sqlite3` database at startup and `sqliteVec.load(db)` throws (platform has no published binary, the environment forbids loading SQLite extensions, or any other load error)
- **THEN** the reference SHALL NOT crash at startup
- **AND** the reference SHALL log a warning identifying `sqlite-vec` as unavailable and the fallback backend as active
- **AND** the reference SHALL use the persistent SQLite-BLOB flat `VectorIndex` implementation (rows in a standard SQLite table, distance computed in JavaScript)
- **AND** the BLOB-flat backend SHALL expose the same interface and the same persistence semantics as the `sqlite-vec` backend

#### Scenario: Vectors persist across process restart (`sqlite-vec` path)
- **WHEN** the reference ingests records for a participating `(connector_id, stream)` with declared `semantic_fields`, then the process is stopped and a fresh process is started against the same `PDPP_DB_PATH`
- **THEN** the advertisement SHALL report `capabilities.semantic_retrieval.supported: true` with `index_state: "built"` immediately, without running a rebuild
- **AND** `GET /v1/search/semantic` SHALL return hits for previously-ingested records
- **AND** the reference SHALL NOT require re-ingest from the connector to make those records searchable again

#### Scenario: Vectors persist across process restart (BLOB-flat path)
- **WHEN** the reference is forced onto the BLOB-flat fallback and the same stop/start sequence as above is performed
- **THEN** the same end-to-end behavior SHALL hold: `index_state: "built"`, hits return, no re-ingest

#### Scenario: `supported: true` does not depend on ephemeral in-process state
- **WHEN** the reference advertises `capabilities.semantic_retrieval.supported: true`
- **THEN** the advertisement SHALL be backed by a persistent store on disk
- **AND** a clean restart SHALL NOT cause `supported: true` to become `supported: false` absent some other failure

### Requirement: The reference SHALL backfill the semantic index from records on startup without requiring re-ingest

Records are the source of truth for semantic retrieval in the reference. The reference SHALL provide a startup backfill path that detects drift per `(connector_id, stream)` and rebuilds the vector index from records already stored in the `better-sqlite3` database. The backfill SHALL NOT call back into any connector and SHALL NOT require re-ingest of raw data.

#### Scenario: Startup with no drift
- **WHEN** the reference starts and the persisted `semantic_search_meta` fingerprint, `model_id`, `dimensions`, and `distance_metric` all match the currently configured backend, and the row-count band check is satisfied
- **THEN** the reference SHALL advertise `index_state: "built"` immediately
- **AND** the reference SHALL NOT run a rebuild

#### Scenario: Startup after a drift signal
- **WHEN** the reference starts and any drift signal (fingerprint change, backend identity change, or row-count band divergence) is active
- **THEN** the reference SHALL advertise `index_state: "stale"` initially and `index_state: "building"` while the rebuild runs, and SHALL advertise `index_state: "built"` once the rebuild completes
- **AND** the rebuild SHALL read records from the records table and re-embed their declared `semantic_fields` using the currently configured backend
- **AND** the rebuild SHALL NOT call back into the originating connector, re-ingest raw data, or require any network traffic beyond calls to the configured embedding backend for re-embedding

#### Scenario: Historical records become searchable again after restart
- **WHEN** the reference is restarted on a database that already contains records for a participating stream
- **THEN** those historical records SHALL be searchable via `GET /v1/search/semantic` either immediately (no-drift case) or after the startup backfill completes (drift case)
- **AND** the reference SHALL NOT require a connector re-sync to make historical records searchable

### Requirement: The reference SHALL NOT substitute a non-semantic fallback behind `GET /v1/search/semantic`

The reference SHALL NOT produce results on `GET /v1/search/semantic` by invoking lexical retrieval (or any other non-semantic matching path) while emitting `retrieval_mode: "semantic"` or `retrieval_mode: "hybrid"` on those results. When the vector index reports `index_state: "building"` or `"stale"`, or when the embedding backend is otherwise unable to produce honest semantic results, the reference SHALL return zero or partial results rather than substituting a non-semantic fallback. The module `reference-implementation/server/search-semantic.js` SHALL NOT import the lexical retrieval helper.

#### Scenario: The vector index is stale
- **WHEN** `vectorIndex.state()` returns `"stale"`
- **THEN** `GET /v1/search/semantic` SHALL return zero or partial results
- **AND** SHALL NOT invoke the lexical retrieval helper
- **AND** any results returned SHALL still carry `retrieval_mode: "semantic"` (because the reference returns honest semantic results, just fewer of them)

#### Scenario: The vector index is building
- **WHEN** `vectorIndex.state()` returns `"building"`
- **THEN** `GET /v1/search/semantic` SHALL return zero or partial results
- **AND** SHALL NOT invoke the lexical retrieval helper

#### Scenario: The no-fallback invariant is visible in source
- **WHEN** a reader inspects `reference-implementation/server/search-semantic.js`
- **THEN** the file SHALL NOT import from `reference-implementation/server/search.js` (the lexical helper)
- **AND** the no-fallback invariant SHALL be verifiable by a static grep

### Requirement: The reference SHALL realize owner-token semantic retrieval through cross-connector fan-out

The reference scopes owner reads of records and stream metadata per connector. The reference SHALL realize owner-token semantic retrieval by fanning out across every owner-visible connector internally and merging results, so that the public `GET /v1/search/semantic` request shape stays identical for owner-token and client-token callers (no public `connector_id` query parameter). Each `search_result` returned to an owner-token caller SHALL carry the originating connector via `connector_id` so the caller can hydrate the record under the correct per-connector owner read scope. The reference SHALL emit a `record_url` that includes the canonical owner-mode `connector_id` query parameter for owner-token callers.

#### Scenario: An owner searches across two connectors that both expose the same stream name
- **WHEN** an owner-token caller invokes `GET /v1/search/semantic?q=alpha` on a reference instance with two owner-visible connectors `C1` and `C2`, both of which expose a `messages` stream that declares `semantic_fields: ["text"]` and both of which contain a matching record
- **THEN** the response SHALL include hits from BOTH connectors
- **AND** each hit SHALL carry its originating `connector_id` (`"C1"` for hits from `C1`, `"C2"` for hits from `C2`)
- **AND** the response SHALL NOT silently scope to a single connector

#### Scenario: An owner request includes `connector_id`
- **WHEN** an owner-token caller invokes `GET /v1/search/semantic?q=alpha&connector_id=C1`
- **THEN** the reference SHALL reject the request with `invalid_request_error` identifying `connector_id` as the rejected parameter
- **AND** SHALL NOT silently use `connector_id` to scope the search

#### Scenario: An owner-mode `record_url` is hydrated
- **WHEN** an owner-token caller takes the `record_url` from a `/v1/search/semantic` hit and issues a GET against it under the same owner token
- **THEN** the reference SHALL return the canonical record envelope at `GET /v1/streams/{stream}/records/{record_key}` for the connector identified by the URL's `connector_id` query parameter

### Requirement: The reference SHALL produce grant-safe verbatim snippets, never model-generated text

When the reference includes a `snippet` on a `search_result`, the snippet's `text` SHALL be a verbatim contiguous substring of the matched field's stored value for the hit record. The reference SHALL NOT produce snippets by summarizing, paraphrasing, translating, or otherwise synthesizing text via the embedding backend or any other model. If a verbatim excerpt cannot be produced for a hit, the reference SHALL omit the `snippet` from that result rather than fabricate one.

#### Scenario: A snippet is a verbatim substring
- **WHEN** the reference emits a `snippet` on a result for a record whose stored `text` field is a given string `S`
- **THEN** the snippet's `text` SHALL be a contiguous substring of `S`
- **AND** the snippet's `text` SHALL NOT be a paraphrase, summary, translation, or synthesized variant of any portion of `S`

#### Scenario: Snippets drawn from ungranted or undeclared fields are omitted
- **WHEN** a candidate snippet's source field is outside the caller's grant projection OR outside the stream's declared `semantic_fields`
- **THEN** the reference SHALL omit the snippet from that result
- **AND** SHALL NOT substitute a snippet derived from that field by any means

### Requirement: The reference SHALL treat embedding and vector-index backends as pluggable implementation details behind a fixed internal interface

The reference SHALL expose pluggable interfaces for the embedding backend and vector index inside `reference-implementation/server/search-semantic.js`. The reference's default embedding backend SHALL be a deterministic local stub that runs without external network access and identifies itself honestly in the advertisement's `model` field. The reference's default vector index SHALL be persistent across process restarts (see the separate "The reference's default semantic index SHALL persist across process restarts" requirement). Hosted embedding providers and alternate persistent vector backends SHALL be supportable as drop-in replacements without any change to the public contract, the spec delta, or the handler shape.

#### Scenario: The reference runs offline without a configured hosted provider
- **WHEN** the reference is started with the default stub embedding backend and the default persistent vector index
- **THEN** the reference SHALL advertise `capabilities.semantic_retrieval.supported: true` with a truthful `model` identifier that names itself as the reference stub
- **AND** the advertised `model` SHALL NOT impersonate the model identifier of a hosted provider
- **AND** the reference SHALL NOT require network access beyond the local `better-sqlite3` database to serve `GET /v1/search/semantic`

#### Scenario: A hosted provider is configured
- **WHEN** an operator configures a hosted embedding backend that implements the `EmbeddingBackend` interface
- **THEN** the reference SHALL advertise that backend's `model`, `dimensions`, and `distance_metric` in `capabilities.semantic_retrieval`
- **AND** the reference SHALL NOT require a change to the handler, the spec delta, or any other public contract

#### Scenario: The reference SHALL NOT bake hosted-provider credentials into source
- **WHEN** a reader inspects the reference source for the embedding backend
- **THEN** no hosted-provider API key, endpoint, or secret SHALL be code-resident
- **AND** any hosted-provider configuration SHALL come from operator-supplied runtime configuration

### Requirement: The reference SHALL mark `GET /v1/search/semantic` as experimental in source

The reference's source for the public semantic retrieval route SHALL include an inline comment band that identifies the surface as experimental and unstable, and SHALL cross-reference the advertisement's `stability` key and the public docs page. This makes the experimental status visible to any reader of the code, not just the advertisement.

#### Scenario: A reader inspects the semantic retrieval route source
- **WHEN** a reader reads the source for `app.get('/v1/search/semantic', …)` in `reference-implementation/server/index.js`
- **THEN** an inline comment SHALL identify the route as experimental and unstable
- **AND** the comment SHALL cross-reference `capabilities.semantic_retrieval.stability` and the public docs page

### Requirement: The reference SHALL keep `GET /v1/search/semantic` distinct from `GET /v1/search` and from reference-only surfaces

The reference SHALL NOT alias `GET /v1/search/semantic` to `GET /v1/search`, SHALL NOT serve the lexical retrieval contract from `GET /v1/search/semantic`, and SHALL NOT serve the semantic retrieval contract from `GET /v1/search` or from any reference-only surface such as `/_ref/search`. The three surfaces SHALL remain independent.

#### Scenario: A client requests `/v1/search`
- **WHEN** a client calls `/v1/search?q=...`
- **THEN** the response SHALL be the lexical retrieval contract defined by the `lexical-retrieval` extension
- **AND** the response SHALL NOT include `retrieval_mode` (which is a semantic-retrieval-specific field)

#### Scenario: A client requests `/v1/search/semantic`
- **WHEN** a client calls `/v1/search/semantic?q=...`
- **THEN** the response SHALL be the semantic retrieval contract defined by the `semantic-retrieval` extension
- **AND** every result SHALL carry `retrieval_mode: "semantic"` (or, if a future tranche enables hybrid blending, `"hybrid"`)

#### Scenario: A client requests `/_ref/search`
- **WHEN** a client calls `/_ref/search?q=...`
- **THEN** the response SHALL be the existing reference-only spine artifact-and-id-jump shape
- **AND** the response SHALL NOT match the public `search_result` list envelope returned by either `/v1/search` or `/v1/search/semantic`

