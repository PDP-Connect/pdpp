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
Debugging, replay, and trace surfaces that are useful for the reference implementation but are not part of core PDPP SHALL be explicitly marked as reference-only.

#### Scenario: A trace or timeline endpoint is exposed
- **WHEN** the implementation exposes trace, timeline, or similar introspection surfaces
- **THEN** those surfaces SHALL be clearly described as reference-only artifacts rather than as core PDPP protocol requirements

#### Scenario: The current `_ref` surface is treated as stable substrate
- **WHEN** the implementation exposes the current reference-designated event-spine readers
- **THEN** the durable `_ref` read surface SHALL stay limited to:
  - `GET /_ref/traces/:traceId`
  - `GET /_ref/grants/:grantId/timeline`
  - `GET /_ref/runs/:runId/timeline`
  - `GET /_ref/traces` (list, filter, paginate)
  - `GET /_ref/grants` (list, filter, paginate)
  - `GET /_ref/runs` (list, filter, paginate)
  - `GET /_ref/search?q=…` (id-aware read-only jump helper)
- **AND** the reference SHALL NOT add mutation/control `_ref` endpoints until a later control-plane phase explicitly widens that boundary

#### Scenario: Run timelines expose checkpoint staging separately from checkpoint commit
- **WHEN** the reference runtime receives `STATE` during a bounded collection run
- **THEN** the `_ref` run timeline SHALL distinguish checkpoint staging from checkpoint commit so the checkpointed-streaming model is visible in reference artifacts rather than implied only by runtime internals

#### Scenario: Runtime validation failures remain inspectable in the reference substrate
- **WHEN** a bounded collection run fails because the runtime rejects connector output or an interaction handler response before `DONE`
- **THEN** the durable `_ref` run timeline SHALL still record `run.failed` with an explicit machine-readable reason instead of leaving that failure visible only as a thrown local error

#### Scenario: A future control plane is introduced
- **WHEN** a control plane, dashboard, or replay surface is built on top of the reference implementation
- **THEN** it SHALL consume the same public or reference-designated surfaces rather than becoming a hidden control path that the CLI or other consumers cannot use

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

