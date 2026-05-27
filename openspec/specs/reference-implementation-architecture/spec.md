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
The reference implementation SHALL support both native-provider and polyfill realizations over one engine substrate while keeping their public source identity honest. Public artifacts SHALL identify the data source with a single discriminated **source object** of shape `{ kind: 'connector' | 'provider_native', id: string }` rather than with parallel top-level `connector_id` and `provider_id` scalars. The kind discriminator names the realization; the `id` field carries the kind-keyed identifier (a registered connector id when `kind = 'connector'`, a registered native provider id when `kind = 'provider_native'`).

#### Scenario: A native provider request is staged
- **WHEN** a client requests data from a native provider realization
- **THEN** the public request and public artifacts SHALL identify that source with a source object whose `kind` is `provider_native` and whose `id` is the configured native provider id
- **AND** the public artifacts SHALL NOT carry a top-level `provider_id` scalar or a top-level `connector_id` scalar alongside the source object

#### Scenario: A polyfill request is staged
- **WHEN** a client requests data from a connector-based or collected realization
- **THEN** the public request and public artifacts SHALL identify that source with a source object whose `kind` is `connector` and whose `id` is the registered connector identifier
- **AND** the public artifacts SHALL NOT carry a top-level `provider_id` scalar or a top-level `connector_id` scalar alongside the source object

#### Scenario: Source object rejects mixed shapes
- **WHEN** a public request body, grant, or spine event payload presents both a top-level `connector_id` scalar and a top-level `provider_id` scalar, or presents either of those scalars alongside a source object
- **THEN** the reference SHALL reject the artifact with an `invalid_request` (for staged requests) or `grant_invalid` (for grants) error whose message names the canonical source-object shape

#### Scenario: Internal storage remains connector-shaped
- **WHEN** the implementation needs connector-shaped or storage-specific internal identifiers
- **THEN** those identifiers MAY remain internal implementation details, but they SHALL not leak into native-provider public artifacts unless explicitly documented as reference-only internals

#### Scenario: Native mode is configured
- **WHEN** the reference implementation starts in native-provider mode
- **THEN** the native manifest SHALL include explicit native provider identity and structured `storage_binding`
- **AND** startup SHALL derive the public source-object identity (`kind = 'provider_native'`, `id = <native provider id>`) and the internal storage binding from that manifest rather than from separate native override flags

#### Scenario: Reference-only event-spine rows expose the source object
- **WHEN** a reference-only spine reader returns spine event rows
- **THEN** each row SHALL carry the source object as `source_kind` and `source_id` columns whose values match the source object inside the row's payload
- **AND** the legacy top-level `provider_id` column SHALL NOT appear in the row shape

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
  - `GET /_ref/search?q=...` (id-aware read-only jump helper)
  - `GET /_ref/dataset/summary` (dashboard overview dataset summary)

#### Scenario: The dashboard summarizes dataset credibility
- **WHEN** the reference dashboard renders a dataset summary or credibility overview
- **THEN** it MAY consume `GET /_ref/dataset/summary`
- **AND** that route SHALL remain documented as a reference-only read surface rather than as a public PDPP API

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

### Requirement: Public aggregations SHALL be single-stream and grant-safe
The reference implementation SHALL expose public aggregation only for one stream at a time. Aggregation input fields, grouping fields, and filters SHALL be authorized under the caller's grant or owner scope before evaluation.

#### Scenario: Client counts granted records
- **WHEN** a client token authorized for `<stream>` requests a count aggregation for `<stream>`
- **THEN** the response SHALL count only records visible under that grant
- **AND** fields outside the grant SHALL NOT influence the result

#### Scenario: Cross-stream aggregation is requested
- **WHEN** a client requests an aggregation across multiple streams
- **THEN** the reference SHALL reject the request unless a later accepted change defines cross-stream semantics

### Requirement: Public aggregations SHALL be manifest-declared
The reference implementation SHALL evaluate only aggregation operations and fields declared by the stream manifest. Undeclared fields, non-scalar fields, arrays, objects, blobs, and high-cardinality fields that are not explicitly declared SHALL be rejected.

#### Scenario: Declared numeric sum is accepted
- **WHEN** a stream declares a numeric field as summable
- **AND** the caller is authorized for that field
- **THEN** the client MAY request a sum aggregation over that field

#### Scenario: Undeclared field is rejected
- **WHEN** a client requests an aggregation over a field absent from the stream's aggregation declaration
- **THEN** the reference SHALL reject the request with a clear query error

### Requirement: Public aggregations SHALL reuse record-list filter semantics
Aggregation requests SHALL use the same exact and declared range filter validation as record-list requests. Unsupported, unauthorized, or malformed filters SHALL fail with the same error class as record-list filtering.

#### Scenario: Date-windowed aggregation
- **WHEN** a client requests an aggregation with `filter[date][gte]=...`
- **AND** the field and operator are declared under `query.range_filters`
- **THEN** the aggregation SHALL apply the same coercion and comparison semantics as record-list filtering

### Requirement: Grouped aggregation results SHALL be bounded and deterministic
Grouped aggregation responses SHALL enforce a maximum bucket limit and deterministic ordering. If the request exceeds the allowed limit or requests grouping by an unsupported field, the reference SHALL reject it.

#### Scenario: Grouped count with limit
- **WHEN** a client requests `group_by=<field>&limit=N`
- **AND** `<field>` is declared groupable
- **THEN** the response SHALL contain at most `N` group buckets
- **AND** the ordering SHALL be documented and deterministic

### Requirement: The reference SHALL hydrate Gmail attachments as content-addressed blobs

When the Gmail `attachments` stream is requested, the reference Gmail connector SHALL fetch each attachment's MIME part bytes from IMAP, compute a SHA-256 content hash over the exact bytes to be served, upload the bytes through the reference blob upload surface, and emit the attachment record with a visible `blob_ref` that resolves through `GET /v1/blobs/{blob_id}`. Successful hydrated attachment records SHALL include `content_sha256` matching the blob hash, byte size, MIME type, and `hydration_status: "hydrated"`.

The connector SHALL NOT inline attachment bytes into the attachment record or the `message_bodies` stream. Attachment primary keys SHALL remain stable across hydration backfills.

#### Scenario: A requested Gmail attachment is hydrated
- **WHEN** the Gmail connector processes a message with an attachment and the `attachments` stream is requested
- **THEN** it SHALL download the attachment MIME part bytes
- **AND** it SHALL compute `content_sha256` over those bytes
- **AND** it SHALL upload the bytes as a content-addressed blob
- **AND** it SHALL emit an `attachments` record whose visible `blob_ref.blob_id` resolves to those bytes

#### Scenario: A Gmail attachment cannot be hydrated
- **WHEN** the Gmail connector can emit attachment metadata but cannot download or upload the attachment bytes for a bounded per-attachment reason
- **THEN** it MAY emit the attachment metadata with `hydration_status` set to `"failed"` or `"deferred"`
- **AND** it SHALL NOT emit a fake `blob_id`, fake `content_sha256`, or fetchable `blob_ref`
- **AND** it SHALL continue processing other attachments and messages when doing so is safe

#### Scenario: Message bodies are queried separately
- **WHEN** a caller requests Gmail `message_bodies`
- **THEN** the response SHALL expose email body text/HTML according to the `message_bodies` stream contract
- **AND** it SHALL NOT include Gmail attachment bytes
- **AND** attachment byte retrieval SHALL require the caller to read the relevant `attachments` record and its visible `blob_ref`

### Requirement: The reference SHALL expose connector-facing blob upload without weakening blob fetch authorization

The reference SHALL provide a connector-facing blob upload path that allows authorized connector/runtime code to upload bytes for a specific `connector_id`, `stream`, and `record_key`. The upload path SHALL return the canonical `blob_id`, `sha256`, `size_bytes`, and `mime_type` that records can expose through `blob_ref`. Uploading the same bytes for the same record binding SHALL be idempotent.

The reference SHALL continue to authorize `GET /v1/blobs/{blob_id}` by resolving the blob's bound record and requiring that record to be visible under the caller's grant with a matching visible `data.blob_ref.blob_id`. A caller SHALL NOT gain blob access by guessing a `blob_id`, by reading attachment metadata without `blob_ref`, or by holding access to a different record that does not reference the blob.

#### Scenario: A connector uploads the same attachment twice
- **WHEN** connector/runtime code uploads identical attachment bytes for the same Gmail attachment record more than once
- **THEN** the reference SHALL return the same canonical blob identity
- **AND** it SHALL NOT create duplicate logical blobs for that record binding

#### Scenario: A caller can see the attachment blob reference
- **WHEN** a caller is authorized to read a Gmail `attachments` record including its `blob_ref` field
- **AND** that `blob_ref.blob_id` points at an uploaded blob
- **THEN** record-list and record-detail responses SHALL decorate the visible `blob_ref` with a fetch URL for `/v1/blobs/{blob_id}`
- **AND** `GET /v1/blobs/{blob_id}` SHALL return the blob bytes with truthful content metadata

#### Scenario: A caller cannot see the attachment blob reference
- **WHEN** a caller is authorized to read Gmail attachment metadata but is not authorized to read the `blob_ref` field
- **THEN** the caller SHALL NOT receive a blob fetch URL in record-list, record-detail, or expanded-record responses
- **AND** `GET /v1/blobs/{blob_id}` for that blob SHALL fail as `blob_not_found`

### Requirement: The reference SHALL backfill Gmail attachment blob linkage idempotently

The Gmail connector SHALL treat metadata ingestion and byte hydration as separate completion facts. A message or attachment that has already been seen in an incremental run SHALL still be eligible for hydration if its attachment record lacks a hydrated `blob_ref`. Backfill runs SHALL re-emit the same attachment primary key with blob linkage once bytes are available.

#### Scenario: Existing metadata-only attachments are backfilled
- **WHEN** the reference contains Gmail `attachments` records emitted before blob hydration existed
- **AND** a later Gmail connector run can download and upload the attachment bytes
- **THEN** the connector SHALL emit updated records with the same primary keys
- **AND** those records SHALL gain hydrated `blob_ref` and `content_sha256` fields

#### Scenario: Already-hydrated attachments are seen again
- **WHEN** an incremental Gmail run encounters an attachment whose bytes were already uploaded
- **THEN** the connector SHALL preserve the attachment primary key
- **AND** the blob upload/read path SHALL behave idempotently
- **AND** the run SHALL NOT create duplicate attachment records or duplicate logical blob identities

### Requirement: Stream metadata SHALL expose normalized field-level query capabilities
The reference implementation SHALL expose a `field_capabilities` object on stream metadata. Each entry SHALL be keyed by a top-level schema field name and SHALL describe the field schema, grant usability, exact-filter support, range-filter operators, lexical-search participation, and semantic-search participation derived from the stream manifest and active bearer context.

#### Scenario: Owner discovers queryable fields
- **WHEN** an owner token requests `GET /v1/streams/<stream>`
- **THEN** the response SHALL include `field_capabilities`
- **AND** fields declared under `query.range_filters` SHALL list their supported range operators
- **AND** fields declared under `query.search.lexical_fields` or `query.search.semantic_fields` SHALL identify their retrieval participation

#### Scenario: Client grant limits usable fields
- **WHEN** a client token requests `GET /v1/streams/<stream>`
- **AND** the stream manifest declares a query capability on a field outside the client's grant projection
- **THEN** the field capability entry SHALL NOT mark that capability as usable under the current token
- **AND** the response SHALL preserve enough reason information for the client to avoid issuing a doomed query

### Requirement: Stream metadata SHALL expose normalized expansion capabilities
The reference implementation SHALL expose an `expand_capabilities` list on stream metadata derived from `query.expand[]` and matching `relationships[]`. Each expansion entry SHALL include relation name, related stream, cardinality, and declared limit metadata when present.

#### Scenario: Expandable relation is discoverable
- **WHEN** a stream declares a relation in both `relationships[]` and `query.expand[]`
- **THEN** stream metadata SHALL include that relation in `expand_capabilities`
- **AND** the entry SHALL identify the related stream and whether the relation is `has_one` or `has_many`

#### Scenario: Descriptive relationship is not public expansion
- **WHEN** a stream has a `relationships[]` entry that is absent from `query.expand[]`
- **THEN** the relation MAY remain visible as descriptive metadata
- **AND** it SHALL NOT be listed as an enabled expansion capability

### Requirement: Public record expansion SHALL be declaration-gated and one-hop
The reference implementation SHALL expose `expand[]` only for relations that the parent stream declares in both `relationships[]` and `query.expand[]`. Expansion SHALL support only one relation hop in this change. Unknown relation names, undeclared relation names, nested relation paths, malformed `expand` values, and `expand_limit` entries without a matching requested relation SHALL fail with `invalid_expand`.

#### Scenario: Declared relation is accepted
- **WHEN** a client queries `GET /v1/streams/<parent>/records?expand=<relation>` and `<parent>` declares `<relation>` in both `relationships[]` and `query.expand[]`
- **THEN** the reference SHALL attempt to hydrate `<relation>` using the declared related stream and foreign key

#### Scenario: Unknown or undeclared relation is rejected
- **WHEN** a client queries `GET /v1/streams/<parent>/records?expand=<relation>` and `<relation>` is absent from either `relationships[]` or `query.expand[]` on `<parent>`
- **THEN** the reference SHALL reject the request with `invalid_expand`

#### Scenario: Nested expansion is rejected
- **WHEN** a client queries `GET /v1/streams/<parent>/records?expand=child.grandchild`
- **THEN** the reference SHALL reject the request with `invalid_expand`

### Requirement: Public record expansion SHALL be grant-safe
The reference implementation SHALL authorize and project expanded records using the related stream's grant entry. If the caller can read the parent stream but lacks grant access to the related stream, the request SHALL fail with `insufficient_scope`. Expanded child records SHALL expose only fields visible under the child stream grant.

#### Scenario: Related stream is outside the grant
- **WHEN** a client queries a granted parent stream with `expand=<relation>`
- **AND** `<relation>` points to a related stream that is not present in the caller's grant
- **THEN** the reference SHALL reject the request with `insufficient_scope`

#### Scenario: Child projection is narrower than child schema
- **WHEN** a client queries a granted parent stream with `expand=<relation>`
- **AND** the caller's grant for the related stream includes only a subset of child fields
- **THEN** each expanded child record SHALL include only the granted child fields plus the record envelope fields required by the record response shape

### Requirement: Public record expansion SHALL have list and detail parity
The reference implementation SHALL apply the same declared expansion semantics to record-list and record-detail reads. A relation that is expandable on `GET /v1/streams/<stream>/records` SHALL also be expandable on `GET /v1/streams/<stream>/records/<id>` with the same grant, projection, missing-child, and limit behavior.

#### Scenario: List read expands a declared relation
- **WHEN** a client queries `GET /v1/streams/<stream>/records?expand=<relation>`
- **THEN** each returned parent record SHALL include the expanded relation under `expanded.<relation>` when the request is otherwise valid

#### Scenario: Detail read expands a declared relation
- **WHEN** a client queries `GET /v1/streams/<stream>/records/<id>?expand=<relation>`
- **THEN** the returned parent record SHALL include the expanded relation under `expanded.<relation>` when the request is otherwise valid

### Requirement: Public record expansion SHALL bound has-many children with expand_limit
For a `has_many` relation, the reference implementation SHALL apply the relation's declared `default_limit` when the caller omits `expand_limit[<relation>]`, SHALL reject non-positive or over-maximum limits with `invalid_expand`, and SHALL return a list object containing `data` and `has_more`. `expand_limit` SHALL NOT apply to non-`has_many` relations.

#### Scenario: Default limit applies
- **WHEN** a client expands a `has_many` relation without `expand_limit[<relation>]`
- **THEN** the reference SHALL use the relation's declared `default_limit`

#### Scenario: Caller requests a valid lower limit
- **WHEN** a client expands a `has_many` relation with `expand_limit[<relation>]=N`
- **AND** `N` is positive and does not exceed the relation's declared `max_limit`
- **THEN** the expanded relation SHALL contain at most `N` child records
- **AND** `has_more` SHALL indicate whether additional matching child records exist beyond `N`

#### Scenario: Caller requests an invalid limit
- **WHEN** a client expands a relation with a non-positive limit, an over-maximum limit, or a limit on a non-`has_many` relation
- **THEN** the reference SHALL reject the request with `invalid_expand`

### Requirement: Public record expansion SHALL represent missing children without failing
The reference implementation SHALL treat missing related records as data absence, not as a query error. For `has_one` relations, a parent with no matching child SHALL expose `expanded.<relation>` as `null`. For `has_many` relations, a parent with no matching children SHALL expose an empty list object with `has_more: false`.

#### Scenario: Missing has-one child
- **WHEN** a parent record is returned for a valid `has_one` expansion
- **AND** no related child record matches the parent key
- **THEN** the parent record SHALL include `expanded.<relation>: null`

#### Scenario: Missing has-many children
- **WHEN** a parent record is returned for a valid `has_many` expansion
- **AND** no related child records match the parent key
- **THEN** the parent record SHALL include `expanded.<relation>` as a list object with an empty `data` array and `has_more: false`

### Requirement: Manifest validation SHALL reject unsafe query.expand declarations
The reference implementation SHALL reject or fail validation for manifests that declare `query.expand[]` entries that cannot be safely served by the reference expansion engine. Each enabled expansion SHALL match a `relationships[]` entry on the same parent stream, reference an existing child stream, use a top-level child schema property as the declared `foreign_key`, and declare positive integer limits with `default_limit <= max_limit` when limits are present.

#### Scenario: query.expand does not match a relationship
- **WHEN** a manifest stream declares `query.expand: [{ "name": "attachments" }]`
- **AND** the same stream has no `relationships[]` entry named `attachments`
- **THEN** manifest validation SHALL fail

#### Scenario: Foreign key is absent from the child stream
- **WHEN** a manifest stream enables expansion for a relationship whose declared related stream lacks the relationship's `foreign_key` in its top-level schema properties
- **THEN** manifest validation SHALL fail

#### Scenario: Expansion limits are invalid
- **WHEN** a manifest stream enables expansion with a non-positive `default_limit`, a non-positive `max_limit`, or a `default_limit` greater than `max_limit`
- **THEN** manifest validation SHALL fail

### Requirement: Gmail parent-child expansions SHALL cover message body and attachment metadata
The first-party Gmail manifest SHALL enable safe parent-to-child expansion from `messages` to `message_bodies` and from `messages` to `attachments` when the related streams are granted. Gmail attachment expansion under this change SHALL expose attachment metadata records only and SHALL NOT imply attachment byte hydration, `blob_ref` availability, extracted text, or blob fetch authorization.

#### Scenario: Message expands body content when granted
- **WHEN** a client with grants for Gmail `messages` and `message_bodies` queries `GET /v1/streams/messages/records?expand=message_bodies`
- **THEN** each returned message record SHALL include its granted message body record under `expanded.message_bodies` when present
- **AND** the expanded body record SHALL be projected according to the `message_bodies` grant

#### Scenario: Message expands attachment metadata when granted
- **WHEN** a client with grants for Gmail `messages` and `attachments` queries `GET /v1/streams/messages/records?expand=attachments`
- **THEN** each returned message record SHALL include granted attachment metadata records under `expanded.attachments`
- **AND** the response SHALL NOT include attachment bytes unless a separate blob-hydration change later defines and grants them

#### Scenario: Message-to-thread reverse expansion remains out of scope
- **WHEN** a client queries Gmail `messages` with `expand=thread`
- **THEN** the reference SHALL reject the request with `invalid_expand` unless a later accepted change defines reverse or belongs-to expansion semantics

#### Scenario: Thread expands messages in the safe direction
- **WHEN** the Gmail manifest declares a parent-to-child `threads` relation to `messages` using `messages.thread_id` as the child foreign key
- **AND** a client with grants for Gmail `threads` and `messages` queries `GET /v1/streams/threads/records?expand=messages`
- **THEN** each returned thread record SHALL include granted message records under `expanded.messages`

### Requirement: Reference semantic retrieval readiness SHALL distinguish backend readiness from corpus participation

The reference implementation SHALL treat semantic backend/index readiness and semantic corpus participation as separate operational facts. A ready embedding backend and built vector index SHALL NOT by themselves imply that the first-party corpus has any searchable semantic coverage.

#### Scenario: Backend is ready but no stream participates
- **WHEN** the reference has an available semantic embedding backend and a built vector index
- **AND** zero loaded first-party streams declare usable `query.search.semantic_fields`
- **THEN** reference diagnostics SHALL report zero semantic participation explicitly
- **AND** the dashboard SHALL surface that as a warning rather than presenting semantic retrieval as a useful corpus feature

#### Scenario: Streams participate
- **WHEN** loaded manifests declare usable semantic fields
- **THEN** reference diagnostics SHALL report participating connectors, streams, and fields
- **AND** the reported participation SHALL be derived from loaded manifests and validator-accepted top-level string fields

### Requirement: First-party polyfill manifests SHALL provide honest semantic field coverage where natural-language fields exist

The reference implementation SHALL declare `query.search.semantic_fields` in first-party polyfill manifests for top-level string fields that are suitable for semantic retrieval. The declaration SHALL remain independent from lexical fields and SHALL NOT include nested paths, arrays, blobs, non-string scalars, or fields absent from the stream schema.

#### Scenario: A natural-language top-level string field exists
- **WHEN** a first-party polyfill stream contains a top-level string field whose value is natural-language record content
- **THEN** the implementation SHALL either declare that field in `query.search.semantic_fields` or document why the field is intentionally excluded

#### Scenario: A field is not safe for semantic embedding
- **WHEN** a stream field is nested, array-shaped, blob-backed, non-string, identifier-like, or otherwise unsuitable for semantic matching
- **THEN** the implementation SHALL NOT declare that field in `query.search.semantic_fields`

### Requirement: Reference semantic retrieval SHALL offer an operational local embedding backend and a deterministic test backend

The reference implementation SHALL support a production-like local embedding backend for operational semantic retrieval while preserving the deterministic stub backend for tests, CI, and exact-match contract checks. The operational backend SHALL require no hosted API key by default.

#### Scenario: Operational semantic retrieval is enabled
- **WHEN** the reference is configured to use the operational local embedding backend
- **THEN** the semantic capability metadata and deployment diagnostics SHALL identify the configured model, dimensions, distance metric, and language bias
- **AND** semantic index drift SHALL be detected when any of those backend identity fields change

#### Scenario: Tests use the deterministic stub
- **WHEN** tests or CI configure the deterministic stub backend
- **THEN** the reference SHALL preserve deterministic exact-match behavior for stable assertions
- **AND** tests SHALL NOT rely on paraphrase, synonym, multilingual, or conceptual-similarity behavior from the stub

### Requirement: Reference semantic retrieval SHALL support operator-configured multilingual embedding profiles

The reference implementation SHALL allow an operator to configure one active semantic embedding profile, including a documented multilingual profile suitable for Italian-language data. The public semantic retrieval API SHALL remain server-configured and SHALL NOT expose caller-selected model parameters.

#### Scenario: Operator configures a multilingual profile
- **WHEN** an operator configures a multilingual embedding profile
- **THEN** semantic capability metadata and deployment diagnostics SHALL identify the active profile and its language bias
- **AND** existing semantic index coverage SHALL be marked stale until rebuilt with that profile

#### Scenario: Caller requests a model directly
- **WHEN** a caller passes a model selector to `GET /v1/search/semantic`
- **THEN** the public endpoint SHALL continue rejecting the request according to the semantic retrieval contract
- **AND** the configured model SHALL remain an operator/server decision

#### Scenario: Multiple simultaneous profiles are desired
- **WHEN** an operator wants concurrent indexes for multiple embedding profiles
- **THEN** this reference change SHALL NOT claim support for query-time model fan-out
- **AND** that requirement SHALL be handled by a future OpenSpec change because it affects index identity, cursor validity, and ranking/merge semantics

### Requirement: Reference deployment diagnostics SHALL expose semantic retrieval health without leaking secrets

The reference dashboard SHALL provide a read-only deployment diagnostics surface that makes semantic retrieval readiness inspectable by an operator. The diagnostics SHALL include semantic backend status, vector index status, active semantic backfill progress when present, model/profile identity, language bias, participating semantic fields, manifest provenance, database/index topology, and relevant environment configuration with secret values redacted.

#### Scenario: Operator opens deployment diagnostics
- **WHEN** an operator opens the deployment diagnostics page
- **THEN** the page SHALL show whether semantic retrieval is enabled, which backend/index are active, the current index state, and which connectors/streams/fields participate
- **AND** the page SHALL show warnings for zero participation, stale index, unavailable backend, missing model cache, disabled model download, and vector-index fallback when applicable

#### Scenario: Semantic backfill is active
- **WHEN** the reference is rebuilding the semantic index in the background
- **THEN** deployment diagnostics SHALL report the active connector and stream when known
- **AND** the dashboard SHALL show bounded progress such as records scanned, total records for the current stream when known, indexed vectors, stream-check counts, and last update time

#### Scenario: Diagnostics include environment configuration
- **WHEN** diagnostics display environment-derived configuration
- **THEN** secret values SHALL be redacted
- **AND** the page SHALL distinguish present, absent, defaulted, and redacted values where that provenance is known

### Requirement: Existing first-party local databases SHALL reconcile semantic coverage changes

The reference implementation SHALL reconcile first-party manifest semantic-field changes into existing local polyfill databases and SHALL rebuild semantic index coverage from stored records without requiring connector re-ingest.

#### Scenario: A first-party manifest gains semantic fields
- **WHEN** an existing local database starts with a first-party manifest that now declares additional `semantic_fields`
- **THEN** the reference SHALL update the persisted first-party manifest according to the existing reconcile rules
- **AND** semantic backfill SHALL index existing stored records for the new declared fields

#### Scenario: The embedding profile changes
- **WHEN** the configured embedding profile changes for an existing local database
- **THEN** semantic index metadata SHALL mark affected coverage stale
- **AND** rebuild SHALL derive replacement embeddings from stored records rather than from connector re-ingest

#### Scenario: Semantic backfill is interrupted
- **WHEN** a semantic stream rebuild is interrupted after persisting some record-field vectors but before completion metadata is written
- **AND** the next rebuild sees matching semantic fields and backend storage identity
- **THEN** the reference SHALL resume without deleting matching partial vectors
- **AND** the rebuild SHALL embed only missing record-field pairs before writing completed index metadata
- **AND** incomplete progress without an active backfill SHALL NOT advertise the semantic index as built

### Requirement: The public query surface SHALL expose a minimal connector discovery floor

The reference Resource Server SHALL expose `GET /v1/connectors` as a bearer-authenticated public query endpoint for discovering source boundaries visible under the caller's token. The endpoint SHALL return a list envelope whose items identify each visible source by a source object of shape `{ kind, id }` and include stream summaries plus coarse capability hints. Polyfill-source items MAY additionally carry the legacy `connector_id` field as a kind-keyed alias of `source.id` for migration ergonomics, but SHALL always carry the canonical source object. The endpoint SHALL NOT inline full stream schemas; callers SHALL use `GET /v1/streams/{stream}` for full source-level stream metadata.

#### Scenario: Owner discovers polyfill connectors

- **WHEN** an owner-token caller in polyfill mode requests `GET /v1/connectors`
- **THEN** the response SHALL include connector-backed sources visible to that owner token without requiring a `connector_id` query parameter
- **AND** each connector-backed item SHALL include a source object whose `kind` is `connector` and whose `id` is the connector identifier
- **AND** declared streams with no stored records SHALL remain discoverable with zero record count and unknown freshness

#### Scenario: Client discovers its granted source

- **WHEN** a client-token caller requests `GET /v1/connectors`
- **THEN** the response SHALL include only the source bound to that active grant, identified by the canonical source object
- **AND** the response SHALL include only grant-authorized stream names for that source
- **AND** the response SHALL NOT expose unrelated registered sources or streams outside the grant

#### Scenario: Discovery does not leak grant internals

- **WHEN** a client-token caller's grant narrows fields, resources, or time range
- **THEN** `GET /v1/connectors` SHALL NOT expose the grant's field list, resource list, time range, client claims, or grant identifier in the response body
- **AND** record counts and freshness SHALL remain computed under existing grant enforcement rules

#### Scenario: Discovery points to existing metadata authority

- **WHEN** a caller needs a stream schema, primary key, cursor field, relationships, views, or field-level query declarations
- **THEN** `GET /v1/connectors` SHALL provide enough source identity and capability hints for the caller to request existing per-stream metadata
- **AND** the full metadata authority SHALL remain `GET /v1/streams/{stream}` rather than the connector discovery response

#### Scenario: Native discovery names the provider source
- **WHEN** an owner-token or client-token caller queries `GET /v1/connectors` against a resource server configured with a native manifest
- **THEN** the response item for the native source SHALL carry a source object whose `kind` is `provider_native` and whose `id` is the configured native provider id
- **AND** the response SHALL NOT carry a top-level `connector_id` field for that item

### Requirement: The reference record-list query SHALL expose an initial changes bookmark sentinel

The reference implementation SHALL accept `changes_since=beginning` on `GET /v1/streams/{stream}/records` as a public initial changes bookmark sentinel. The sentinel SHALL behave like an opaque changes cursor positioned at the beginning of retained history and SHALL return the normal changes response shape, including `next_changes_since`.

Clients SHALL NOT need to construct internal version-0 cursor payloads to start incremental sync.

#### Scenario: A client starts incremental sync from the beginning

- **WHEN** a client queries `/v1/streams/<s>/records?changes_since=beginning`
- **THEN** the reference SHALL return records whose grant-authorized projections changed since the beginning of retained history
- **AND** the response SHALL include `next_changes_since` when the request succeeds
- **AND** the response SHALL NOT expose or require construction of the internal version-0 cursor representation

#### Scenario: The initial changes response is paginated

- **WHEN** a client queries `/v1/streams/<s>/records?changes_since=beginning&limit=N` and additional visible changes remain
- **THEN** the reference SHALL include `next_cursor` only as a page-continuation cursor for the same changes session
- **AND** the response SHALL include `next_changes_since` as the opaque bookmark for a future changes session

#### Scenario: A client sends a raw timestamp

- **WHEN** a client queries `/v1/streams/<s>/records?changes_since=2026-04-24T00:00:00Z`
- **THEN** the reference SHALL reject the request as an invalid changes cursor
- **AND** timestamp-based changes semantics SHALL remain unsupported unless a separate change defines them

### Requirement: Changes bookmark documentation SHALL distinguish page cursors from changes cursors

The public documentation for `GET /v1/streams/{stream}/records` SHALL distinguish record-list page cursors from changes bookmarks. Documentation SHALL tell clients to use `next_cursor` only with the `cursor` query parameter and `next_changes_since` only with the `changes_since` query parameter.

#### Scenario: A client reads change-tracking guidance

- **WHEN** documentation explains how to continue a paginated record or changes response
- **THEN** it SHALL identify `next_cursor` as a page-continuation token for the `cursor` parameter
- **AND** it SHALL NOT tell clients to use `next_cursor` as `changes_since`

#### Scenario: A client reads incremental sync guidance

- **WHEN** documentation explains how to continue a later incremental sync session
- **THEN** it SHALL identify `next_changes_since` as the opaque token to pass as `changes_since`

### Requirement: The reference implementation SHALL implement filtered retrieval through the public search surfaces

The reference implementation SHALL implement stream-scoped filters on `GET /v1/search` and `GET /v1/search/semantic` through the public endpoints, reusing the same filter validation semantics as record listing. Filtered retrieval SHALL remain grant-safe and SHALL NOT introduce a second filter grammar.

#### Scenario: Lexical retrieval applies a declared range filter
- **WHEN** a caller invokes `GET /v1/search` with `q`, exactly one `streams[]` value, and a declared `filter[field][gte|gt|lte|lt]`
- **THEN** the reference SHALL validate the filter against the stream metadata and caller authorization
- **AND** every returned result SHALL hydrate to a visible record satisfying that filter

#### Scenario: Semantic retrieval applies a declared range filter
- **WHEN** a caller invokes `GET /v1/search/semantic` with `q`, exactly one `streams[]` value, and a declared `filter[field][gte|gt|lte|lt]`
- **THEN** the reference SHALL validate the filter against the stream metadata and caller authorization
- **AND** every returned result SHALL hydrate to a visible record satisfying that filter

#### Scenario: Filter validation fails
- **WHEN** a search request contains a filter without exactly one `streams[]` value, an unauthorized field, an undeclared range field, an unsupported range operator, or a malformed filter value
- **THEN** the reference SHALL reject the request before returning retrieval results
- **AND** the reference SHALL NOT return partial results from streams or connectors where the filter happened to be valid

#### Scenario: Forbidden retrieval controls remain rejected
- **WHEN** a caller passes expansion, sort, ranking knobs, connector-specific query parameters, model selectors, raw vectors, score/debug parameters, or DSL-shaped parameters to a retrieval endpoint
- **THEN** the reference SHALL reject those parameters according to the relevant retrieval contract
- **AND** filtered retrieval SHALL NOT be used as a backdoor to widen the public query surface

### Requirement: Docker support SHALL provide an opt-in development hot-reload mode
The reference Docker support SHALL provide an opt-in Compose development mode
that supports iterative source edits without rebuilding production images for
each change.

#### Scenario: Docker dev mode starts
- **WHEN** an operator starts the Docker development override
- **THEN** the web service SHALL run a development server with source hot reload
- **AND** the reference service SHALL restart or reload when server source files
  change
- **AND** the composed public/internal URL topology SHALL remain the same as the
  default Docker stack

#### Scenario: Docker dev mode is accessed through another host
- **WHEN** an operator accesses Docker development mode through a LAN IP,
  hostname, or reverse proxy
- **THEN** the web service SHALL provide a documented configuration knob for
  additional Next development origins
- **AND** Docker development documentation SHALL state that reverse proxies must
  forward WebSocket upgrade traffic for Next HMR

#### Scenario: Docker dev mode runs connector flows
- **WHEN** the reference service runs inside the Docker development override
- **THEN** it SHALL load the repo-root local development env file when present
- **AND** connector credentials from that file SHALL be available to
  controller-managed connector runs without requiring production images to load
  `.env.local`

#### Scenario: Docker smoke mode remains reproducible
- **WHEN** an operator runs the default Docker smoke validation
- **THEN** it SHALL continue to build and run the production-style Docker stack
- **AND** it SHALL NOT require the development override

### Requirement: Public Docker images SHALL be built and published from CI
The reference implementation SHALL provide a CI workflow that builds public
Docker images for the supported Docker runtime targets and publishes them only
from trusted refs.

#### Scenario: A pull request changes Docker-relevant files
- **WHEN** CI runs for a pull request that changes Docker-relevant files
- **THEN** CI SHALL build the supported Docker image targets
- **AND** CI SHALL NOT push images to a public registry from the pull request

#### Scenario: A trusted ref is built
- **WHEN** CI runs for a trusted publishing ref such as the default branch or a
  version tag
- **THEN** CI SHALL build the supported Docker image targets
- **AND** CI SHALL push the resulting images to the configured public registry

#### Scenario: Image publication runs
- **WHEN** CI publishes Docker images
- **THEN** the workflow SHALL use runtime CI credentials or the platform token
- **AND** it SHALL NOT require committed registry credentials
- **AND** it SHALL NOT bake owner passwords, connector credentials, SQLite data,
  embedding cache contents, or browser profile state into the image layers

### Requirement: Public Docker images SHALL carry useful tags and metadata
Published reference Docker images SHALL include documented tags and metadata
that support both convenient testing and reproducible operation.

#### Scenario: An operator chooses an image tag
- **WHEN** an operator reads the Docker documentation
- **THEN** the documentation SHALL explain which tags are moving tags
- **AND** it SHALL explain which tags or digests are appropriate for
  reproducible self-hosting

#### Scenario: CI publishes image metadata
- **WHEN** CI pushes a Docker image
- **THEN** the image SHALL include OCI metadata that identifies the source
  repository and image role
- **AND** the workflow SHALL request SBOM or provenance metadata when the
  registry and builder support it

### Requirement: Docker documentation SHALL support pull-based self-hosting
The reference documentation SHALL describe how to run the reference stack from
public images without requiring a local source build.

#### Scenario: An operator starts from public images
- **WHEN** an operator follows the Docker documentation for public images
- **THEN** they SHALL be told how to prepare runtime environment configuration
- **AND** they SHALL be told how to pull images and start the Compose stack
- **AND** they SHALL be told where the browser-facing origin is expected to be

#### Scenario: An operator persists state
- **WHEN** an operator follows the Docker documentation for public images
- **THEN** the documentation SHALL identify the persisted SQLite database,
  embedding cache, and browser connector/session state locations
- **AND** it SHALL distinguish persisted runtime state from image contents

#### Scenario: An operator upgrades images
- **WHEN** an operator updates a public-image deployment
- **THEN** the documentation SHALL describe how to pull newer images and restart
  the Compose stack without deleting persisted runtime volumes

#### Scenario: A contributor develops with Docker
- **WHEN** a contributor reads the Docker documentation
- **THEN** the documentation SHALL distinguish public-image operation from local
  image builds, smoke validation, and opt-in Docker hot reload

### Requirement: Deployment diagnostics SHALL surface lexical backfill progress
The reference deployment diagnostics surface SHALL report active lexical index
backfill progress when the reference server is rebuilding lexical search
indexes.

#### Scenario: Lexical backfill is active
- **WHEN** a lexical index backfill is actively scanning or rebuilding records
- **THEN** `/_ref/deployment` SHALL include the current lexical backfill job
- **AND** the report SHALL include enough progress data for the dashboard to
  show the connector, stream, phase, scanned records, total records when known,
  written index rows, and updated timestamp
- **AND** the report SHALL include a warning that lexical search results may be
  partial while the rebuild is active

#### Scenario: Lexical backfill is inactive
- **WHEN** no lexical index backfill is active
- **THEN** `/_ref/deployment` SHALL report no active lexical backfill progress
- **AND** it SHALL NOT emit a lexical rebuilding warning

#### Scenario: Dashboard renders lexical progress
- **WHEN** `/dashboard/deployment` receives lexical backfill progress
- **THEN** it SHALL render browser-visible progress without requiring operators
  to inspect container logs

### Requirement: Docker assembly SHALL preserve reference architecture boundaries
The reference implementation SHALL provide a Docker or Docker Compose path that assembles the live reference stack without redefining PDPP protocol behavior, hiding control-plane behavior, or making the website the implementation boundary.

#### Scenario: Docker starts the live reference stack
- **WHEN** an operator starts the supported Docker assembly
- **THEN** the assembly SHALL run the reference AS/RS process and the browser-facing web app as the current reference architecture defines them
- **AND** the AS SHALL listen on port `7662`
- **AND** the RS SHALL listen on port `7663`
- **AND** the web app SHALL listen on port `3000`

#### Scenario: Docker is used as assembly
- **WHEN** a reviewer evaluates Docker artifacts for the reference implementation
- **THEN** those artifacts SHALL be documented as deployment assembly for the reference stack
- **AND** they SHALL NOT be described as PDPP protocol requirements or as an alternate control-plane contract

### Requirement: Docker builds SHALL use the monorepo toolchain
Docker builds for the supported reference stack SHALL use the repo-root pnpm workspace through Corepack and SHALL use a Debian/Ubuntu-based Node image compatible with the reference's native dependencies.

#### Scenario: Dependencies are installed in Docker
- **WHEN** a Docker image installs JavaScript dependencies
- **THEN** it SHALL install from the repository root using the checked-in pnpm workspace and lockfile
- **AND** it SHALL NOT run package-local `npm install` commands that create a dependency graph different from local development

#### Scenario: Native dependencies are built in Docker
- **WHEN** a Docker image builds or loads native dependencies such as SQLite or browser-automation dependencies
- **THEN** the base image SHALL be Debian/Ubuntu-based Node rather than Alpine
- **AND** the Node version SHALL be compatible with the repo's runtime floor for `node:sqlite`

### Requirement: Docker topology SHALL distinguish public and internal URLs
The Docker assembly SHALL keep browser-facing reference origin configuration separate from container-internal AS/RS service URLs.

#### Scenario: Composed mode is configured in Docker
- **WHEN** the Docker stack runs in composed mode
- **THEN** `PDPP_REFERENCE_ORIGIN` SHALL identify the external browser-facing origin
- **AND** `PDPP_AS_URL` SHALL identify the container-internal AS URL
- **AND** `PDPP_RS_URL` SHALL identify the container-internal RS URL

#### Scenario: Services call each other inside Docker
- **WHEN** one container calls the AS or RS container
- **THEN** it SHALL use Docker service DNS or another explicit internal URL
- **AND** it SHALL NOT rely on `localhost` to mean another container

#### Scenario: Browser-facing metadata is emitted
- **WHEN** the AS or RS emits public metadata, device verification URLs, or pending-consent authorization URLs in composed Docker mode
- **THEN** those URLs SHALL use `PDPP_REFERENCE_ORIGIN`
- **AND** they SHALL NOT leak internal Docker service names as browser-facing URLs

### Requirement: Docker runtime state SHALL be persistent and explicit
The Docker assembly SHALL document and provide persistence for the state required by real reference operation.

#### Scenario: Reference data is written
- **WHEN** the Docker stack writes reference records, grants, runs, or semantic vectors
- **THEN** the configured SQLite database path SHALL be backed by a persisted volume or documented host bind mount

#### Scenario: Semantic embeddings are used
- **WHEN** the Docker stack uses the local semantic embedding backend
- **THEN** the embedding model cache path SHALL be persisted or documented as intentionally ephemeral
- **AND** first-boot model download behavior SHALL be documented

#### Scenario: Browser connectors are used
- **WHEN** browser-based polyfill connectors run inside or alongside the Docker stack
- **THEN** browser profiles, daemon files, and connector session state SHALL have a persisted volume or documented host bind mount
- **AND** the documentation SHALL state that browser connectors depend on persistent profiles and upstream anti-bot behavior

### Requirement: Docker secrets SHALL be runtime-provided
The Docker assembly SHALL keep owner passwords, connector credentials, tokens, cookies, and other secrets out of built image layers.

#### Scenario: A secret is needed by the Docker stack
- **WHEN** the Docker stack needs `PDPP_OWNER_PASSWORD`, connector credentials, tokens, cookies, or dynamic-client-registration secrets
- **THEN** those values SHALL be supplied at runtime through environment variables, env files, or Docker secrets
- **AND** they SHALL NOT be baked into Dockerfiles, image layers, committed Compose defaults, or generated static assets

#### Scenario: Deployment diagnostics render Docker env
- **WHEN** the dashboard deployment diagnostics render secret-bearing Docker environment variables
- **THEN** secret values SHALL be redacted before reaching the dashboard

### Requirement: Docker support SHALL include a smoke validation path
The supported Docker path SHALL include a reproducible smoke validation that does not require real third-party connector credentials.

#### Scenario: Docker smoke validation runs
- **WHEN** an operator or CI job runs the Docker smoke validation
- **THEN** it SHALL verify that the browser-facing web origin responds
- **AND** it SHALL verify that AS and RS metadata are reachable through the composed origin
- **AND** it SHALL verify that browser-facing metadata does not expose internal Docker service URLs

#### Scenario: Owner auth is configured during Docker smoke validation
- **WHEN** `PDPP_OWNER_PASSWORD` is configured for the Docker smoke validation
- **THEN** dashboard access SHALL either redirect unauthenticated requests to `/owner/login` or pass after a valid owner session is established

### Requirement: The reference implementation SHALL use `better-sqlite3` as its SQLite driver

The reference implementation SHALL access SQLite via `better-sqlite3`. It SHALL
NOT depend on `@databases/sqlite` or the legacy `sqlite3` N-API binding for any
runtime SQLite code path.

#### Scenario: Fresh install includes only the chosen driver
- **WHEN** a developer installs the reference implementation dependencies
- **THEN** `better-sqlite3` SHALL be installed as a direct dependency
- **AND** `@databases/sqlite` SHALL NOT be required for reference runtime SQLite access

#### Scenario: Sustained dashboard workload does not crash the server
- **WHEN** a client issues concurrent requests to `/dashboard/records`, `/dashboard/search?q=...`, and `/planning/changes` for ten or more rounds
- **THEN** the reference server process SHALL remain alive throughout
- **AND** SHALL NOT emit `SIGSEGV`, `SIGABRT`, or `free(): invalid size` abnormal termination

### Requirement: Pre-existing databases SHALL continue to open and operate

The reference implementation SHALL open and operate against SQLite files that
worked with the previous driver. No schema changes, data migration, or
file-format change SHALL be required solely because of the driver swap.

#### Scenario: Existing polyfill substrate continues to serve records
- **WHEN** the reference implementation starts against a pre-existing polyfill SQLite database
- **THEN** it SHALL open the file without a driver-level migration
- **AND** it SHALL serve existing records and spine events from that file via the `/v1` and `/_ref` HTTP surfaces with the same response shapes as before

### Requirement: Partial connector runs SHALL expose known gaps
The reference runtime SHALL expose machine-readable known gaps when a connector run skips streams, records, or source regions that were in requested scope but not collected.

#### Scenario: A stream is skipped because credentials are missing
- **WHEN** a connector cannot collect a requested stream because required credentials or interaction are absent
- **THEN** the run timeline SHALL record the skipped stream and reason
- **AND** the operator surface SHALL distinguish that gap from a successful complete collection

### Requirement: Partial data SHALL NOT be represented as complete
The reference implementation SHALL NOT present records from an incomplete connector run as evidence that the requested scope was fully collected unless the run has no known gaps for that scope.

#### Scenario: A connector flushes records before a later stream fails
- **WHEN** a run flushes records for one stream and then fails or skips another requested stream
- **THEN** the flushed records MAY remain queryable
- **AND** reference diagnostics SHALL preserve that the latest run had known gaps

### Requirement: Recovery hints SHALL be bounded and non-secret
Known-gap and skip diagnostics SHALL include bounded recovery hints when the runtime or connector can identify a next step, but SHALL NOT persist credentials, OTPs, cookies, raw page contents, or other secrets.

#### Scenario: A manual login is required
- **WHEN** a connector requires a manual login or anti-bot resolution before it can continue
- **THEN** the run timeline MAY expose a recovery hint such as `manual_action_required`
- **AND** it SHALL NOT persist submitted credentials or browser session secrets

### Requirement: Client event subscriptions are a discoverable RI extension and grant-scoped

The reference implementation SHALL expose outbound client event subscriptions at the canonical resource-server path `/v1/event-subscriptions`. It SHALL advertise the surface in the resource server's protected-resource metadata document under `capabilities.client_event_subscriptions`, with `supported: true`, `stability: "reference_extension"`, and `scope: "reference_implementation"`. The advertisement SHALL document the endpoint, supported event types, signing algorithm and header names, delivery semantics (at-least-once, after-commit, retry schedule, max attempts), verification handshake, hint cursor field, callback-URL HTTPS requirement, and client-visible byte limits. The reference SHALL NOT widen client grants to enable subscriptions, and SHALL NOT accept owner bearer tokens or local device credentials as authorization for client subscription endpoints.

Subscription create, read, list, update, delete, and test-event operations SHALL require a client bearer whose grant is currently active. The persisted subscription SHALL record the bearer's `(grant_id, client_id, subject_id)` and SHALL refuse any subsequent operation by a bearer whose `(client_id, grant_id)` does not match.

#### Scenario: A client creates a subscription with a valid bearer
- **WHEN** an authorized client posts a subscription create request to `POST /v1/event-subscriptions` with a client bearer token whose grant is active
- **THEN** the reference SHALL persist the subscription with the bearer's `(grant_id, client_id, subject_id)` snapshotted
- **AND** the response SHALL include the freshly generated delivery secret exactly once

#### Scenario: A different client attempts to read another client's subscription
- **WHEN** a client bearer requests `GET /v1/event-subscriptions/:id` for a subscription whose stored `client_id` differs from the bearer's
- **THEN** the reference SHALL return a not-found response without disclosing the subscription's existence

#### Scenario: An owner bearer attempts to use a client subscription endpoint
- **WHEN** an owner bearer token (not a client token) is presented to any `/v1/event-subscriptions[...]` endpoint
- **THEN** the reference SHALL reject the request with HTTP 403

#### Scenario: A client reads the protected-resource metadata
- **WHEN** a client reads `/.well-known/oauth-protected-resource` on the resource server
- **THEN** the response SHALL include `capabilities.client_event_subscriptions` with `supported: true`, `stability: "reference_extension"`, and an `endpoint` of `/v1/event-subscriptions`
- **AND** the advertisement SHALL include the signing algorithm `HMAC-SHA256`, the signature header `PDPP-Event-Signature`, the canonical signed-payload form `<timestamp>.<body>`, the set of supported event types (`pdpp.subscription.verify`, `pdpp.subscription.test`, `pdpp.records.changed`, `pdpp.grant.revoked`), the delivery semantics (at-least-once, after-commit, max-attempts), the verification handshake shape, and the hint cursor location

### Requirement: Subscription delivery is verified before any record-driven events ship

The reference SHALL deliver no record-driven events to a callback URL until the URL has completed a one-shot verification handshake. The handshake SHALL be signed with the subscription secret like all other events, and SHALL require the callback to echo a server-issued challenge.

#### Scenario: A new subscription is created
- **WHEN** a subscription is persisted in state `pending_verification`
- **THEN** the reference SHALL enqueue exactly one `subscription.verify` event carrying a server-issued challenge string
- **AND** record-driven events for that subscription SHALL be held until the handshake succeeds

#### Scenario: The callback echoes the challenge
- **WHEN** the verification callback returns HTTP 2xx with a body containing the same challenge string
- **THEN** the reference SHALL transition the subscription to `active`
- **AND** subsequent record-driven events for that subscription SHALL become eligible for delivery

#### Scenario: The callback fails the handshake
- **WHEN** the verification callback returns a non-2xx response or omits the challenge
- **THEN** the reference SHALL keep retrying the verification event under the configured delivery policy while the subscription remains `pending_verification`
- **AND** SHALL transition the subscription to `disabled_failure` when verification attempts are exhausted
- **AND** SHALL NOT enqueue or deliver record-driven events for the subscription until verification succeeds

### Requirement: Events are projection-safe hints derived from grant scope

The reference SHALL derive client events from `record_changes` and grant scope using a pure derivation step. The derived envelope SHALL NOT contain record bodies, field values, or resource identifiers outside the bound grant. It SHALL include the stream name only when that stream is in the subscription's scope snapshot, and a `changes_since` cursor that can be passed to the existing records-list endpoint to retrieve the notified change. The envelope's `source` SHALL be the canonical dereferenceable path of the subscription on the resource server (`/v1/event-subscriptions/<subscription_id>`).

#### Scenario: A record changes in a stream the grant covers
- **WHEN** `ingestRecord` commits a change for a stream that lies inside an active subscription's scope snapshot
- **THEN** the reference SHALL enqueue a `pdpp.records.changed` envelope referencing that stream
- **AND** the envelope's `data.changes_since` SHALL be an opaque cursor the client can pass to `rs.records.list` to retrieve the change
- **AND** the envelope's `source` SHALL be `/v1/event-subscriptions/<subscription_id>`

#### Scenario: A record changes in a stream the grant does not cover
- **WHEN** `ingestRecord` commits a change for a stream that lies outside every active subscription's scope snapshot
- **THEN** the reference SHALL NOT enqueue an event for any of those subscriptions

#### Scenario: An envelope is constructed
- **WHEN** the derivation step builds an envelope for any event type
- **THEN** the envelope SHALL NOT include record bodies, projected field values, or resource identifiers that are not already declared in the bound grant

### Requirement: Event delivery is signed, after-commit, idempotent, and retried

The reference SHALL enqueue events only after the underlying durable mutation has committed and is readable through the existing read path. Each delivery request SHALL carry an HMAC-SHA256 signature over `<timestamp>.<raw body>` using the per-subscription secret, plus a stable `PDPP-Event-Id` for receiver-side idempotency. Delivery SHALL be at-least-once with exponential backoff retry and a final dead-letter state.

#### Scenario: A record change commits
- **WHEN** `ingestRecord` returns `changed`
- **THEN** the reference SHALL enqueue any derived events only after the durable transaction has committed and the change is readable

#### Scenario: A delivery attempt is made
- **WHEN** the delivery worker posts an event to a subscription callback
- **THEN** the request SHALL include `PDPP-Event-Timestamp`, `PDPP-Event-Id`, `PDPP-Subscription-Id`, and `PDPP-Event-Signature: sha256=<hex>` over `<timestamp>.<raw body>` keyed by the subscription secret
- **AND** the reference SHALL persist an attempt log row recording status code, latency, and a bounded response snippet

#### Scenario: A delivery attempt fails transiently
- **WHEN** a delivery attempt returns a non-2xx response or fails to connect
- **THEN** the reference SHALL reschedule the event for retry using the configured backoff schedule
- **AND** SHALL NOT advance the event past dead-letter until the configured maximum attempts are exhausted

#### Scenario: Delivery exhausts retries
- **WHEN** an event has exhausted the maximum delivery attempts
- **THEN** the reference SHALL mark the event `final_failure`
- **AND** SHALL transition the subscription to `disabled_failure`
- **AND** SHALL stop delivering further events for that subscription until it is re-enabled

### Requirement: Subscription state tracks grant lifecycle

The reference SHALL keep client subscription state coherent with the bound grant. Revocation or expiration of the grant SHALL disable the subscription, drop queued events, and emit at most one `pdpp.grant.revoked` hint if the subscription was previously active.

#### Scenario: A grant is revoked
- **WHEN** a grant bound to one or more subscriptions transitions to revoked
- **THEN** the reference SHALL emit at most one `pdpp.grant.revoked` event per subscription that was previously active
- **AND** SHALL transition those subscriptions to `disabled_revoked`
- **AND** SHALL drop any not-yet-delivered queued events for those subscriptions

### Requirement: Subscription storage parity across SQLite and Postgres backends

The reference SHALL persist subscription, queue, and attempt state with equivalent semantics on both reference storage backends (SQLite and Postgres). The active backend is selected by `isPostgresStorageBackend()`; the host-adapter store resolver SHALL pick the matching implementation, and worker-facing claim/attempt helpers SHALL run against that same backend.

#### Scenario: The reference boots against a Postgres backend
- **WHEN** the reference is configured for the Postgres storage backend
- **THEN** schema bootstrap SHALL create `client_event_subscriptions`, `client_event_queue`, and `client_event_attempts` with the columns, indexes, and check constraints documented in the design
- **AND** the default subscription store SHALL execute writes and reads via the Postgres-backed implementation
- **AND** the delivery worker's queue claim and attempt-log helpers SHALL run against the same Postgres database

#### Scenario: The reference boots against an SQLite backend
- **WHEN** the reference is configured for the SQLite storage backend
- **THEN** the default subscription store SHALL execute via the registered SQL artifacts under `server/queries/client-event-subscriptions/`
- **AND** the operation, worker, and route layers SHALL not require any code changes to swap backends

#### Scenario: A subscription is created, verified, and revoked on Postgres
- **WHEN** the lifecycle (`create → verify → list → rotate secret → enqueue test event → claim queue → log attempt → grant revoke`) runs against a Postgres-backed reference
- **THEN** every step SHALL succeed against the live Postgres backend
- **AND** the queue claim path SHALL return the subscription's callback URL, secret, and current status joined to each queued row, exactly as the SQLite path does
