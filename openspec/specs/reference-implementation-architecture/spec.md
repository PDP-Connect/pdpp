# reference-implementation-architecture Specification

## Purpose
Define the durable architecture and boundary rules for the PDPP reference implementation in this repository without competing with the normative PDPP protocol specs.
## Requirements
### Requirement: The reference implementation remains a forkable substrate

The forkable implementation substrate SHALL live in `reference-implementation/` and SHALL remain usable without either Next deployable runtime (the public-site deployable or the operator-console deployable).

#### Scenario: An implementer evaluates the reference
- **WHEN** an implementer clones the repository to study or fork the reference implementation
- **THEN** they SHALL be able to run and understand the core reference substrate from `reference-implementation/` without depending on the public-site or operator-console deployable

#### Scenario: The website changes independently
- **WHEN** either Next deployable changes its internal implementation
- **THEN** the forkable reference substrate SHALL remain the authoritative runnable implementation artifact rather than becoming coupled to deployable-only code paths

### Requirement: The website is a downstream consumer

The reference implementation's downstream consumer SHALL be split into two Next deployables — a public-site deployable (`apps/site` or its successor) and an operator-console deployable (`apps/console` or its successor) — that consume the reference implementation independently. Neither deployable SHALL define the primary reference contract. The public-site deployable SHALL NOT depend on a running reference-implementation AS/RS. The operator-console deployable SHALL act as the BFF in front of a co-deployed reference-implementation AS/RS for the operator's `/dashboard/**` experience.

#### Scenario: A bridge route exists for the operator console

- **WHEN** the operator-console deployable exposes a bridge route to the reference implementation
- **THEN** that bridge SHALL reflect the current reference contract honestly and SHALL not invent a stronger or different protocol contract than the underlying reference implementation exposes
- **AND** the bridge SHALL be owned by the operator-console deployable rather than by the public-site deployable

#### Scenario: The public site renders documentation and demos

- **WHEN** the public-site deployable renders protocol docs, the reference explainer, the mock sandbox, the OpenSpec viewer, the contributor workbench, or LLM index files
- **THEN** those artifacts SHALL be treated as derived explanatory surfaces rather than as the implementation boundary itself
- **AND** the public-site deployable SHALL build and serve without a running reference-implementation AS/RS process

#### Scenario: A downstream deployable changes independently

- **WHEN** the public-site deployable or the operator-console deployable changes its internal implementation
- **THEN** the forkable reference substrate in `reference-implementation/` SHALL remain the authoritative runnable implementation artifact rather than becoming coupled to deployable-specific code paths
- **AND** the other deployable SHALL be unaffected unless it explicitly shares code through the operator UI workspace package

### Requirement: Native and polyfill realizations stay honest
The reference implementation SHALL support both native-provider and polyfill realizations over one engine substrate while keeping their public source identity honest. Public artifacts SHALL identify the data source with a single discriminated **source object** of shape `{ kind: 'connector' | 'provider_native', id: string }` rather than with parallel top-level `connector_id` and `provider_id` scalars. The kind discriminator names the realization; the `id` field carries the kind-keyed identifier (a registered connector id when `kind = 'connector'`, a registered native provider id when `kind = 'provider_native'`).

#### Scenario: Docker n.eko deployments resolve bundled connector manifests
- **WHEN** the reference Docker deployment runs the n.eko compose overlay for browser-managed polyfill connectors
- **THEN** the deployment SHALL provide an in-network manifest registry for the bundled polyfill connector manifests used by that overlay
- **AND** the in-network registry SHALL preserve the connector manifest's declared public connector identifier rather than inventing a Docker-only connector identity

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

The reference implementation SHALL NOT expose live bearer-token material on any reference-only read surface, even when that surface is otherwise unauthenticated. Every event projected from `spine_events` onto `_ref` timeline responses SHALL satisfy these narrow projection rules before the response is serialized:

1. The top-level `token_id` field SHALL be removed from the event.
2. When the event's `object_type` equals `'token'`, the event's `object_id` SHALL be replaced with the literal string `<redacted-token-id>` (because `token.issued` events use the bearer string as both `token_id` and `object_id`).
3. When the event's `object_type` equals `'pending_consent'` or `'owner_device_auth'`, the event's `object_id` SHALL be replaced with the literal string `<redacted-device-code>` (because those events use the live `device_code` as `object_id`, and the device_code is bearer-equivalent — it redeems for an owner bearer at `POST /oauth/token` and resolves to a request_uri that, when paired with `/consent/approve`, issues a client bearer).
4. The event's top-level `data` object, if present and not an array, SHALL have any of the keys `device_code`, `user_code`, or `request_uri` replaced with the literal string `<redacted-bearer>`. The projection SHALL NOT traverse arrays inside `data` and SHALL NOT recurse into nested objects.

The projection SHALL NOT pattern-match field names beyond the explicit allowlist above, SHALL NOT redact by value shape, and SHALL NOT recurse into nested data objects. Storage of `token_id`, `object_id`, and `data` in `spine_events` is unchanged by this requirement; the projection is a read-time guarantee. A wider name- or shape-based projection, and removal of the bearer from spine storage entirely, are deferred to a separate change.

The operator console projection of pending approvals (`GET /_ref/approvals`) SHALL also satisfy:

1. `approval_id` SHALL be the row's stored opaque `approval_id` (a non-redeemable id minted at row creation), NOT the row's `device_code`.
2. `request_uri` SHALL be `null` for every entry. The canonical `request_uri` (`urn:pdpp:pending-consent:<device_code>`) embeds the live device_code; clients that legitimately need it receive it as the response of `POST /oauth/par` and SHALL NOT pick it up from the operator console.
3. `user_code` SHALL be `null` for every entry. The dashboard's owner approve/deny path SHALL POST `approval_id` (not `user_code`) and the AS SHALL resolve `approval_id` to the matching pending row internally behind the existing owner-session + CSRF gate.

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

#### Scenario: A grant timeline event carries `token_id` in storage
- **WHEN** a caller requests `GET /_ref/grants/:grantId/timeline` for a grant whose stored spine events carry `token_id` values
- **THEN** the response payload SHALL NOT contain a `token_id` field on any event
- **AND** every other documented event field (`event_id`, `event_type`, `occurred_at`, `actor_*`, `subject_*`, `grant_id`, `client_id`, `data`, `trace_id`, etc.) SHALL be returned unchanged

#### Scenario: A grant timeline includes a `token.issued` event
- **WHEN** the timeline includes an event whose `object_type` is `'token'`
- **THEN** that event's `object_id` SHALL be the literal string `<redacted-token-id>`
- **AND** the bearer string the event carried in storage SHALL NOT appear anywhere in the serialized response body

#### Scenario: A run timeline event carries `token_id` in storage
- **WHEN** a caller requests `GET /_ref/runs/:runId/timeline` for a run whose stored spine events carry `token_id` values
- **THEN** the response payload SHALL NOT contain a `token_id` field on any event

#### Scenario: The projection redacts the device_code on pending_consent events
- **WHEN** a caller requests `GET /_ref/traces/:traceId` for a trace whose `request.submitted` event has `object_type === 'pending_consent'` and `object_id` equal to the live `device_code`
- **THEN** the response payload SHALL replace that event's `object_id` with the literal string `<redacted-device-code>`
- **AND** the live device_code value SHALL NOT appear anywhere in the serialized response body

#### Scenario: The projection redacts the device_code on owner_device_auth events
- **WHEN** a caller requests `GET /_ref/traces/:traceId` for a trace whose `request.submitted` event has `object_type === 'owner_device_auth'` and `object_id` equal to the live `device_code`
- **THEN** the response payload SHALL replace that event's `object_id` with the literal string `<redacted-device-code>`
- **AND** the live device_code value SHALL NOT appear anywhere in the serialized response body

#### Scenario: The projection redacts bearer-equivalent keys in event data
- **WHEN** a stored spine event's top-level `data` object contains any of the keys `device_code`, `user_code`, or `request_uri`
- **THEN** the projection SHALL replace each such key's value with the literal string `<redacted-bearer>`
- **AND** other keys inside `data` SHALL pass through unchanged

#### Scenario: `_ref/approvals` does not expose the live device_code
- **WHEN** a caller (with owner session, when owner-auth is enabled, or any caller in open local-dev mode) requests `GET /_ref/approvals` while a `pending_consents` row and an `owner_device_auth` row are pending
- **THEN** the response data array SHALL contain entries whose `approval_id` is the row's stored opaque `approval_id`, NOT the row's `device_code`
- **AND** the live `device_code` value of either row SHALL NOT appear anywhere in the serialized response body
- **AND** every consent entry's `request_uri` SHALL be `null`
- **AND** every entry's `user_code` SHALL be `null`

#### Scenario: The dashboard approves a pending consent by approval_id
- **WHEN** an authenticated owner submits `POST /consent/approve` with `Content-Type: application/json` and a JSON body of `{ "approval_id": "<row-approval-id>", "subject_id": "owner_local" }`
- **THEN** the AS SHALL resolve the `approval_id` to the matching pending consent row, derive the canonical `request_uri` from its `device_code` internally, and complete the approval
- **AND** the response status SHALL be `200`
- **AND** the response body SHALL be the existing `{ grant_id, token, grant }` envelope

#### Scenario: The dashboard approves a pending owner-device flow by approval_id
- **WHEN** an authenticated owner submits `POST /device/approve` with `Content-Type: application/x-www-form-urlencoded` and `approval_id=<row-approval-id>&subject_id=owner_local`
- **THEN** the AS SHALL resolve the `approval_id` to the matching pending owner_device_auth row, derive the `user_code` internally, and complete the approval
- **AND** the response SHALL be the existing rendered "device access approved" hosted page

#### Scenario: The projection does not traverse `data` payloads or match by field-name shape
- **WHEN** a stored spine event carries fields other than the explicitly-redacted set (`token_id`, `object_id` for the listed object_types, and the three top-level `data` keys), for example application-level keys inside `data` or values nested in arrays
- **THEN** the projection SHALL NOT remove or rename those other fields
- **AND** the projection SHALL NOT inspect string values for bearer-like shape
- **AND** the projection SHALL NOT recurse into nested objects or arrays inside `data`

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

#### Scenario: Local collector completeness is classified
- **WHEN** behavior concerns local Claude Code or Codex source-home inventory, privacy classification, coverage diagnostics, auth-adjacent exclusions, or multi-device source-home binding
- **THEN** it SHALL be treated as reference runtime/orchestrator behavior unless and until a concrete interoperability need promotes it into Collection Profile vocabulary
- **AND** the reference SHALL NOT describe 100% local Claude Code or Codex collection as a PDPP Core Resource Server requirement

#### Scenario: Local source homes require connector instances
- **WHEN** the reference accepts local collector data from a Claude Code or Codex source home
- **THEN** the source home SHALL resolve to a connector instance before records, blobs, state, schedules, run leases, diagnostics, or owner actions are written
- **AND** `connector_id` alone SHALL NOT be used as the durable runtime key for local collection from multiple devices or source homes

#### Scenario: Run assistance semantics are classified
- **WHEN** behavior concerns the shape of owner assistance during a bounded connector run, including whether the owner must act elsewhere, provide a value, operate an attachment, or wait for retry
- **THEN** the reference SHALL label the behavior as reference-run-assistance semantics unless and until the Collection Profile explicitly adopts it
- **AND** candidate Collection Profile semantics SHALL be limited to connector-neutral assistance axes, lifecycle, and safety rules rather than reference dashboard implementation details

#### Scenario: Browser surface assistance remains an attachment
- **WHEN** behavior concerns CDP, Playwright, n.eko, WebRTC, stream-token minting, or pointer/keyboard/clipboard control
- **THEN** the reference SHALL treat that behavior as browser-surface attachment implementation
- **AND** it SHALL NOT imply that all owner assistance requires or provides a browser surface

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

When `reference-implementation/server/index.js` is run as a CLI entrypoint, it SHALL install process-level handlers for `uncaughtException`, `unhandledRejection`, `SIGTERM`, and `SIGINT`. Each handler SHALL emit exactly one log record before the process exits, except that the `uncaughtException` handler SHALL downgrade closed-pipe write errors on owned process stdio (`process.stdout` / `process.stderr`) to a single `warn` record and return without exiting. These handlers SHALL NOT be installed when `server/index.js` is imported as a library (for example, from a test harness); the reference implementation SHALL NOT register global `process.on` listeners from any code path other than the CLI entrypoint block.

A "closed-pipe write error" for the purposes of this requirement is an `Error` with `syscall === 'write'` and `code` in the set `{ 'EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END' }`. Any other error SHALL take the existing fatal-log + non-zero-exit path.

#### Scenario: Uncaught exception at the CLI entrypoint
- **WHEN** the CLI is running and code in a request handler or background task throws and the error is not otherwise caught
- **THEN** exactly one `fatal` log record SHALL be emitted on stdout with the error name, message, and stack before the process exits with a non-zero code

#### Scenario: Closed-pipe write error on owned process stdio
- **WHEN** the CLI is running and an `EPIPE` (or equivalent closed-pipe error) is raised by a write to `process.stdout` or `process.stderr` and reaches the `uncaughtException` handler
- **THEN** the handler SHALL emit at most one `warn` log record describing the closed-pipe condition
- **AND** the handler SHALL NOT exit the process
- **AND** subsequent unrelated errors SHALL still be classified by the same handler

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

The reference implementation SHALL realize the public `semantic-retrieval` extension defined in the `semantic-retrieval` capability through one internal helper that performs grant resolution, plan construction, embedding invocation, vector-index lookup, and grant-safe snippet generation in the same code path. The public `GET /v1/search/semantic` route handler SHALL delegate to that helper. Reference-internal callers (including the operator-console dashboard) SHALL reach semantic retrieval through the same public route over HTTP, not through a parallel direct-database path. The reference SHALL NOT define a second semantic retrieval contract.

#### Scenario: The dashboard helper reaches semantic retrieval through the public route
- **WHEN** a reference-side caller in `apps/console/src/app/dashboard/lib/rs-client.ts` requests semantic retrieval over owner records
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
The reference implementation SHALL evaluate only aggregation operations and fields declared by the stream manifest. Undeclared fields, non-scalar fields, arrays, objects, blobs, and high-cardinality fields that are not explicitly declared SHALL be rejected. The declarable operations are `count`, `sum`, `min`, `max`, `group_by` (scalar fields), `group_by_time` (date or date-time fields), and `count_distinct` (scalar fields). A `group_by_time` entry SHALL reference a declared field whose schema is a `string` with `format` `date` or `date-time` (or the nullable variant). A `count_distinct` entry SHALL reference a declared top-level scalar field.

#### Scenario: Declared numeric sum is accepted
- **WHEN** a stream declares a numeric field as summable
- **AND** the caller is authorized for that field
- **THEN** the client MAY request a sum aggregation over that field

#### Scenario: Undeclared field is rejected
- **WHEN** a client requests an aggregation over a field absent from the stream's aggregation declaration
- **THEN** the reference SHALL reject the request with a clear query error

#### Scenario: Declared time-bucket field is accepted
- **WHEN** a stream declares a date or date-time field under `query.aggregations.group_by_time`
- **AND** the caller is authorized for that field
- **THEN** the client MAY request a `group_by_time` aggregation over that field

#### Scenario: Undeclared distinct field is rejected
- **WHEN** a client requests `metric=count_distinct&field=<field>` and `<field>` is absent from `query.aggregations.count_distinct`
- **THEN** the reference SHALL reject the request with a clear query error

### Requirement: Public aggregations SHALL reuse record-list filter semantics
Aggregation requests SHALL use the same exact and declared range filter validation as record-list requests. Unsupported, unauthorized, or malformed filters SHALL fail with the same error class as record-list filtering.

#### Scenario: Date-windowed aggregation
- **WHEN** a client requests an aggregation with `filter[date][gte]=...`
- **AND** the field and operator are declared under `query.range_filters`
- **THEN** the aggregation SHALL apply the same coercion and comparison semantics as record-list filtering

### Requirement: Grouped aggregation results SHALL be bounded and deterministic
Grouped aggregation responses SHALL enforce a maximum bucket limit and deterministic ordering. If the request exceeds the allowed limit or requests grouping by an unsupported field, the reference SHALL reject it. A request SHALL carry at most one grouping dimension: `group_by` and `group_by_time` SHALL NOT be combined. Scalar `group_by` results SHALL be ordered by count descending, then key ascending. `group_by_time` results SHALL be ordered by bucket start ascending, with the null/unparseable bucket sorted last.

#### Scenario: Grouped count with limit
- **WHEN** a client requests `group_by=<field>&limit=N`
- **AND** `<field>` is declared groupable
- **THEN** the response SHALL contain at most `N` group buckets
- **AND** the ordering SHALL be count descending, then key ascending

#### Scenario: Two grouping dimensions are rejected
- **WHEN** a client requests both `group_by` and `group_by_time` in one call
- **THEN** the reference SHALL reject the request with an `invalid_request` query error

#### Scenario: Time-bucket grouping returns an ascending series
- **WHEN** a client requests `group_by_time=<date_field>&granularity=day`
- **AND** `<date_field>` is declared time-bucketable and authorized
- **THEN** the response SHALL contain at most `limit` buckets keyed by ISO bucket start
- **AND** the buckets SHALL be ordered by bucket start ascending

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
The reference implementation SHALL provide CI workflows that validate supported
Docker runtime targets on Docker-relevant changes and publish public Docker
images only from explicit trusted publishing events.

#### Scenario: A pull request changes Docker-relevant files
- **WHEN** CI runs for a pull request that changes Docker-relevant files
- **THEN** CI SHALL build the supported Docker image targets for validation
- **AND** CI SHALL NOT push images to a public registry from the pull request

#### Scenario: A default-branch push changes Docker-relevant files
- **WHEN** CI runs for a default-branch push that changes Docker-relevant files
- **THEN** CI SHALL build the supported Docker image targets for validation
- **AND** CI SHALL NOT push images to a public registry from that ordinary
  default-branch push

#### Scenario: A trusted publishing event runs
- **WHEN** CI runs for an explicit trusted publishing event such as a release tag
  or maintainer-dispatched image publication
- **THEN** CI SHALL build the supported Docker image targets
- **AND** CI SHALL push the resulting images to the configured public registry

#### Scenario: Image publication runs
- **WHEN** CI publishes Docker images
- **THEN** the workflow SHALL use runtime CI credentials or the platform token
- **AND** it SHALL NOT require committed registry credentials
- **AND** it SHALL NOT bake owner passwords, connector credentials, SQLite data,
  embedding cache contents, or browser profile state into the image layers

#### Scenario: Validation-only Docker CI runs
- **WHEN** CI builds Docker image targets only for validation
- **THEN** the workflow MAY use a cheaper single-platform build shape
- **AND** that validation-only build SHALL NOT be treated as the published
  platform set for stable release images

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

### Requirement: Client event subscriptions are a discoverable RI extension with explicit authority scoping

The reference implementation SHALL expose outbound event subscriptions at the canonical resource-server path `/v1/event-subscriptions`. It SHALL advertise the surface in the resource server's protected-resource metadata document under `capabilities.client_event_subscriptions`, with `supported: true`, `stability: "reference_extension"`, `scope: "reference_implementation"`, and `authority_kinds_supported` containing `client_grant` and `trusted_owner_agent`. The advertisement SHALL document the endpoint, supported event types, the signing profile and header names, delivery semantics (at-least-once, after-commit, retry schedule, max attempts), verification handshake, hint cursor field, callback-URL HTTPS requirement, and client-visible byte limits.

Ordinary client subscription create, read, list, update, delete, and test-event operations SHALL require a client bearer whose grant is currently active. The persisted subscription SHALL record authority kind `client_grant`, the bearer's `(grant_id, client_id, subject_id)`, and SHALL refuse any subsequent operation by a bearer whose `(client_id, grant_id)` does not match.

Trusted owner-agent subscription create, read, list, update, delete, and test-event operations SHALL require an owner bearer issued to a registered client. The persisted subscription SHALL record authority kind `trusted_owner_agent`, the bearer's `(client_id, subject_id)`, and SHALL refuse any subsequent operation by a bearer whose `(client_id, subject_id)` does not match. Owner-agent subscriptions SHALL be owner-visible current/future data subscriptions; they SHALL NOT expose record bodies in pushed events; record-change events SHALL carry enough source identity (`connector_id`, stream, `connection_id` where known, and `changes_since`) for the owner agent to pull changed records through the owner REST read path; and they SHALL be disabled when the registered client is deleted.

#### Scenario: A client creates a subscription with a valid bearer
- **WHEN** an authorized client posts a subscription create request to `POST /v1/event-subscriptions` with a client bearer token whose grant is active
- **THEN** the reference SHALL persist the subscription with authority kind `client_grant` and the bearer's `(grant_id, client_id, subject_id)` snapshotted
- **AND** the response SHALL include the freshly generated delivery secret exactly once
- **AND** the secret SHALL carry the Standard Webhooks `whsec_` prefix

#### Scenario: A trusted owner agent creates a subscription with a registered owner bearer
- **WHEN** a trusted owner agent posts a subscription create request to `POST /v1/event-subscriptions` with an owner bearer issued to a registered client
- **THEN** the reference SHALL persist the subscription with authority kind `trusted_owner_agent`
- **AND** the subscription SHALL be scoped to the bearer's `(client_id, subject_id)` rather than to a grant id
- **AND** the response SHALL include the freshly generated delivery secret exactly once

#### Scenario: A different authority attempts to read a subscription
- **WHEN** a bearer requests `GET /v1/event-subscriptions/:id` for a subscription whose stored authority does not match the bearer's authority
- **THEN** the reference SHALL return a not-found response without disclosing the subscription's existence

#### Scenario: An unregistered owner bearer attempts to use subscriptions
- **WHEN** an owner bearer token with no registered `client_id` is presented to any `/v1/event-subscriptions[...]` endpoint
- **THEN** the reference SHALL reject the request with HTTP 403

#### Scenario: A registered owner-agent client is deleted
- **WHEN** the owner deletes the registered client that issued an owner-agent subscription's bearer
- **THEN** the reference SHALL revoke the owner-agent token
- **AND** it SHALL disable that client's pending or active event subscriptions and drop pending queue rows

#### Scenario: A client reads the protected-resource metadata
- **WHEN** a client or owner agent reads `/.well-known/oauth-protected-resource` on the resource server
- **THEN** the response SHALL include `capabilities.client_event_subscriptions` with `supported: true`, `stability: "reference_extension"`, an `endpoint` of `/v1/event-subscriptions`, and `authority_kinds_supported` containing `client_grant` and `trusted_owner_agent`
- **AND** the advertisement SHALL declare the envelope as `format: "cloudevents+json"`, `specversion: "1.0"`, `pdppversion: "1"`, `content_type: "application/cloudevents+json; charset=utf-8"`, and `subscription_id_location: "data.subscription_id"`
- **AND** the advertisement SHALL declare the signing profile as `standard-webhooks` with `algorithm: "HMAC-SHA256"`, `id_header: "webhook-id"`, `timestamp_header: "webhook-timestamp"`, `signature_header: "webhook-signature"`, `signed_payload: "{webhook-id}.{webhook-timestamp}.{body}"`, `signature_encoding: "v1,<base64>"`, and `secret_prefix: "whsec_"`
- **AND** the advertisement SHALL include the set of supported event types (`pdpp.subscription.verify`, `pdpp.subscription.test`, `pdpp.records.changed`, `pdpp.grant.revoked`), the delivery semantics (at-least-once, after-commit, max-attempts), the verification handshake shape, and the hint cursor location

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

The reference SHALL derive client events from `record_changes` and grant scope using a pure derivation step. The derived envelope SHALL conform to CloudEvents 1.0 (`specversion: "1.0"`) JSON structured mode and SHALL carry the PDPP profile version in the `pdppversion` CloudEvents extension attribute. Top-level keys in the emitted envelope SHALL be CloudEvents context attributes only (standard or extension); CloudEvents attribute names SHALL be lowercase alphanumeric, so PDPP fields that would carry an underscore SHALL live inside `data` rather than at the top level. The occurrence time SHALL be emitted as the standard CloudEvents `time` attribute. The subscription identifier SHALL be emitted as `data.subscription_id` (the standard `source` URL also encodes the subscription path). The envelope SHALL NOT contain record bodies, field values, or resource identifiers outside the bound grant. It SHALL include the stream name only when that stream is in the subscription's scope snapshot, and a `changes_since` cursor that can be passed to the existing records-list endpoint to retrieve the notified change. The envelope's `source` SHALL be the canonical dereferenceable path of the subscription on the resource server (`/v1/event-subscriptions/<subscription_id>`).

#### Scenario: A record changes in a stream the grant covers
- **WHEN** `ingestRecord` commits a change for a stream that lies inside an active subscription's scope snapshot
- **THEN** the reference SHALL enqueue a `pdpp.records.changed` envelope referencing that stream
- **AND** the envelope SHALL set `specversion` to `"1.0"` and `pdppversion` to `"1"`
- **AND** the envelope's `data.changes_since` SHALL be an opaque cursor the client can pass to `rs.records.list` to retrieve the change
- **AND** the envelope's `source` SHALL be `/v1/event-subscriptions/<subscription_id>`

#### Scenario: A record changes in a stream the grant does not cover
- **WHEN** `ingestRecord` commits a change for a stream that lies outside every active subscription's scope snapshot
- **THEN** the reference SHALL NOT enqueue an event for any of those subscriptions

#### Scenario: An envelope is constructed
- **WHEN** the derivation step builds an envelope for any event type
- **THEN** the envelope SHALL NOT include record bodies, projected field values, or resource identifiers that are not already declared in the bound grant
- **AND** the envelope SHALL NOT use any value other than `"1.0"` for `specversion`
- **AND** every top-level key in the emitted envelope SHALL be a CloudEvents context attribute conforming to the lowercase-alphanumeric naming rule (no underscores)
- **AND** the occurrence time SHALL be emitted as the standard CloudEvents `time` attribute
- **AND** the subscription identifier SHALL be emitted as `data.subscription_id`

### Requirement: Event delivery is signed, after-commit, idempotent, and retried

The reference SHALL enqueue events only after the underlying durable mutation has committed and is readable through the existing read path. Each delivery request SHALL carry a Standard Webhooks signature constructed as `HMAC-SHA256(secret, "{webhook-id}.{webhook-timestamp}.{raw body}")` and emitted as `webhook-signature: v1,<base64>`, plus a stable `webhook-id` for receiver-side idempotency and a `webhook-timestamp` recording the unix-seconds value used in the signed string. Delivery SHALL be at-least-once with exponential backoff retry and a final dead-letter state.

#### Scenario: A record change commits
- **WHEN** `ingestRecord` returns `changed`
- **THEN** the reference SHALL enqueue any derived events only after the durable transaction has committed and the change is readable

#### Scenario: A delivery attempt is made
- **WHEN** the delivery worker posts an event to a subscription callback
- **THEN** the request SHALL include `webhook-id` (the stable event id), `webhook-timestamp` (the unix-seconds value used in the signed string), and `webhook-signature` (a `v1,<base64>` token computed as `HMAC-SHA256(secret_key, "{webhook-id}.{webhook-timestamp}.{raw body}")`)
- **AND** the request SHALL NOT include any `PDPP-Event-*` headers or any `PDPP-Subscription-Id` header
- **AND** the request `content-type` SHALL be `application/cloudevents+json; charset=utf-8` (CloudEvents JSON structured mode)
- **AND** the signed `{raw body}` SHALL be the exact bytes of the structured-mode envelope that the receiver reads from the request body
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

#### Scenario: A receiver verifies a delivery with a stock Standard Webhooks library
- **WHEN** a receiver verifies the delivery using the secret returned at subscription create, the `webhook-id` and `webhook-timestamp` headers, and the raw request body
- **THEN** any conforming Standard Webhooks library SHALL accept the `webhook-signature` value without PDPP-specific code
- **AND** the subscription secret SHALL be a `whsec_`-prefixed string whose suffix base64-decodes to the HMAC key

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

### Requirement: `rs.connectors.list` SHALL be operation-owned

The reference implementation SHALL serve bearer-scoped connector-discovery list behavior through a canonical `rs.connectors.list` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, and process environment.

#### Scenario: Native connector list route

- **WHEN** the native reference server handles `GET /v1/connectors`
- **THEN** it SHALL execute the canonical `rs.connectors.list` operation for connector-list semantics
- **AND** route-specific code SHALL be limited to authentication, request/header adaptation, manifest/grant resolution, query/disclosure instrumentation, response writing, and capability dependency wiring

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.connectors.list` operation is implemented
- **THEN** it SHALL depend on capability-shaped source-descriptor and connector-item-list dependencies
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, sandbox modules, the Fastify host module (`server/index.js`), the records module (`server/records.js`), or `process` / `process.env`

#### Scenario: Existing connector-list semantics are preserved

- **WHEN** the native `GET /v1/connectors` route is migrated to the operation
- **THEN** the public response envelope SHALL remain `{object: 'list', data: [...connector items]}` with byte-equivalent items
- **AND** the `query.received` data block SHALL retain `query_shape: 'connector_list'`
- **AND** the `disclosure.served` data block SHALL retain `query_shape: 'connector_list'` together with `connector_count` and `stream_count` totals computed from the operation result
- **AND** request id, trace id, and source-descriptor selection SHALL remain equivalent to the previous native route behavior

### Requirement: `rs.streams.aggregate` SHALL be operation-owned

The reference implementation SHALL serve stream-aggregate behavior through a canonical `rs.streams.aggregate` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, and process environment. The operation SHALL forward the time-bucket and distinct request parameters (`group_by_time`, `granularity`, `time_zone`, `metric=count_distinct`) to its aggregate-execution dependency unchanged, and its `query.received` data block SHALL retain `query_shape: 'stream_aggregate'` while additively carrying `group_by_time` and `granularity` alongside the existing `metric`, `field`, `group_by`, and `limit` fields.

#### Scenario: Native stream aggregate route
- **WHEN** the native reference server handles `GET /v1/streams/:stream/aggregate`
- **THEN** it SHALL execute the canonical `rs.streams.aggregate` operation for aggregate semantics

#### Scenario: Operation depends on injected capabilities
- **WHEN** the `rs.streams.aggregate` operation is implemented
- **THEN** it SHALL depend on capability-shaped source-descriptor, request-validator, and aggregate-execution dependencies

#### Scenario: Existing aggregate semantics are preserved
- **WHEN** the native `GET /v1/streams/:stream/aggregate` route is migrated to the operation
- **THEN** the public response SHALL preserve the previous semantic fields for requests that do not use the new parameters, while allowing additive response fields that are `null` or `false`
- **AND** the `query.received` data block SHALL retain `query_shape: 'stream_aggregate'` together with the previously emitted `metric`, `field`, `group_by`, and `limit` fields parsed from the request query
- **AND** the `disclosure.served` data block SHALL retain `query_shape: 'stream_aggregate'` together with `metric`, `field`, `group_by`, `filtered_record_count`, and `group_count` derived from the aggregate result
- **AND** the request validator (`validateRequestedQueryFieldParams`) SHALL continue to run before the aggregate executes

### Requirement: `rs.records.list` SHALL be operation-owned

The reference implementation SHALL serve record-list behavior through a canonical `rs.records.list` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, and process environment.

#### Scenario: Native record list route

- **WHEN** the native reference server handles `GET /v1/streams/:stream/records`
- **THEN** it SHALL execute the canonical `rs.records.list` operation for record-list semantics
- **AND** route-specific code SHALL be limited to authentication, request/header adaptation, query/disclosure instrumentation, response writing, and capability dependency wiring

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.records.list` operation is implemented
- **THEN** it SHALL depend on capability-shaped manifest, grant, source-descriptor, record-query, and record-decoration dependencies
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, sandbox modules, or `process` / `process.env`

#### Scenario: Existing record-read semantics are preserved

- **WHEN** the native `GET /v1/streams/:stream/records` route is migrated to the operation
- **THEN** existing cursor, `changes_since`, projection, range filter, view, `expand[]`, blob-ref decoration, request id, trace id, query-received, and disclosure-served behavior SHALL remain equivalent to the previous native route behavior
- **AND** the migration SHALL NOT change the public JSON shape of the route response

### Requirement: `rs.records.get` SHALL be operation-owned

The reference implementation SHALL serve single-record-read behavior through a canonical `rs.records.get` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, and process environment.

#### Scenario: Native record detail route

- **WHEN** the native reference server handles `GET /v1/streams/:stream/records/:id`
- **THEN** it SHALL execute the canonical `rs.records.get` operation for single-record semantics
- **AND** route-specific code SHALL be limited to authentication, request/header adaptation, query/disclosure instrumentation, response writing, and capability dependency wiring

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.records.get` operation is implemented
- **THEN** it SHALL depend on capability-shaped manifest, grant, source-descriptor, record-fetch, and record-decoration dependencies
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, sandbox modules, or `process` / `process.env`

#### Scenario: Existing single-record-read semantics are preserved

- **WHEN** the native `GET /v1/streams/:stream/records/:id` route is migrated to the operation
- **THEN** existing `expand[]`, `expand_limit`, blob-ref decoration, request id, trace id, query-received, and disclosure-served behavior SHALL remain equivalent to the previous native route behavior
- **AND** the migration SHALL NOT change the public JSON shape of the route response

### Requirement: `rs.schema.get` SHALL be operation-owned

The reference implementation SHALL serve schema-discovery behavior through a canonical `rs.schema.get` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, and process environment.

#### Scenario: Native schema route

- **WHEN** the native reference server handles `GET /v1/schema`
- **THEN** it SHALL execute the canonical `rs.schema.get` operation for schema-discovery semantics
- **AND** route-specific code SHALL be limited to authentication, request/header adaptation, response writing, environment dependency wiring, and reference instrumentation

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.schema.get` operation is implemented
- **THEN** it SHALL depend on capability-shaped manifest/schema/freshness dependencies
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, or `process.env`

#### Scenario: Existing native disclosure behavior is preserved

- **WHEN** the native `GET /v1/schema` route is migrated to the operation
- **THEN** existing request id, trace id, query-received, and disclosure-served behavior SHALL remain equivalent to the previous native route behavior
- **AND** the migration SHALL include regression evidence for bearer projection, connector count, stream count, and source descriptor behavior

### Requirement: `rs.search.hybrid` SHALL be operation-owned

The reference implementation SHALL serve public hybrid search behavior through a canonical `rs.search.hybrid` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, the native lexical helper module, the native semantic helper module, the native hybrid helper module, and process environment.

#### Scenario: Native hybrid search route

- **WHEN** the native reference server handles `GET /v1/search/hybrid`
- **THEN** it SHALL execute the canonical `rs.search.hybrid` operation for public hybrid-search semantics
- **AND** route-specific code SHALL be limited to authentication, request/header adaptation, query/disclosure instrumentation, response writing, advertisement-driven route registration (the route is registered only when both lexical and semantic retrieval are advertised on this server), and capability dependency wiring

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.search.hybrid` operation is implemented
- **THEN** it SHALL depend on `runLexical` and `runSemantic` capability dependencies that return per-source result envelopes already filtered through the caller's grant
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, sandbox modules, the native `server/search.js` lexical helper module, the native `server/search-semantic.js` helper module, the native `server/search-hybrid.js` helper module, or `process` / `process.env`

#### Scenario: Existing public hybrid search semantics are preserved on the native route

- **WHEN** the native `GET /v1/search/hybrid` route is migrated to the operation
- **THEN** the public JSON response shape, error codes, per-hit `retrieval_mode: "hybrid"`, per-hit `retrieval_sources` provenance (subset of `["lexical", "semantic"]`, lexical-first order), per-source `scores` map shape (each entry is the underlying surface's score object verbatim — no normalization across surfaces, no flat `score` field on individual hybrid hits), dedup semantics (`(connector_id, stream, record_key)`), grant filtering behavior (delegated to the underlying lexical and semantic runners), stream/filter query semantics, and `disclosure.served` event shape (`query_shape: "search_hybrid"`, `record_count`, `has_more`, `mode`, `lexical_count`, `semantic_count`) SHALL remain equivalent to the previous native route behavior
- **AND** the migration SHALL NOT broaden, narrow, or otherwise change the v1 query-parameter allowlist (`q`, `limit`, `streams`, `streams[]`, `filter`)
- **AND** the migration SHALL NOT change the explicit `cursor` rejection (any `cursor` parameter on the wire ⇒ `invalid_request` with `param: "cursor"` — v1 hybrid does NOT support cursor pagination)
- **AND** the migration SHALL NOT change the explicit forbidden-parameter list (`vector`, `embedding`, `embed`, `model`, `model_id`, `model_family`, `rank`, `boost`, `weights`, `blend`, `connector_id`, `fields`, `expand`, `expand[]`, `expand_limit`, `expand_limit[]`, `order`, `sort`, `mode`)
- **AND** the migration SHALL NOT introduce hybrid cursor pagination — the response envelope SHALL NOT carry `next_cursor`
- **AND** the migration SHALL NOT introduce a new grant-logic path — grant enforcement (advertisement, grant projection, stream-grant intersection, field-grant intersection, record-level grant constraints) SHALL remain inside the underlying lexical and semantic runners; errors from either runner (e.g. `grant_stream_not_allowed`) SHALL propagate unchanged through the operation
- **AND** the migration SHALL NOT normalize lexical and semantic score values together; per-hit hybrid hits SHALL expose per-source scores under a `scores` map keyed by source name and SHALL NOT carry a flat `score` field

#### Scenario: Hybrid retrieval composes the underlying lexical and semantic surfaces under the same grant

- **WHEN** the operation receives a request
- **THEN** it SHALL invoke the lexical and semantic runner dependencies under the caller's grant, passing the parsed sub-request parameters (`q`, `limit`, `streams`, `filter`) verbatim to each
- **AND** it SHALL merge the two per-source result lists in round-robin order (lexical-first), preserving per-source rank order
- **AND** it SHALL deduplicate by `(connector_id, stream, record_key)`, with the dedup map preserving insertion order so overlapping hits get the best available rank from whichever source surfaced them first
- **AND** on overlap it SHALL union `matched_fields` across sources (lexical-first discovery order, no duplicates), forward the underlying score objects under `scores[source]` verbatim, and keep the first non-empty snippet encountered
- **AND** it SHALL apply the caller-requested `limit` AFTER dedup+merge so hybrid never returns fewer hits than requested purely because of cross-source overlap
- **AND** it SHALL emit `has_more: true` when the merged-and-deduped list exceeded the limit, and `has_more: false` otherwise; v1 hybrid `has_more` is informational only since the response envelope does not carry `next_cursor`

### Requirement: `rs.search.lexical` SHALL be operation-owned

The reference implementation SHALL serve public lexical search behavior through a canonical `rs.search.lexical` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, lexical-index implementation, and process environment.

#### Scenario: Native lexical search route

- **WHEN** the native reference server handles `GET /v1/search`
- **THEN** it SHALL execute the canonical `rs.search.lexical` operation for public lexical-search semantics
- **AND** route-specific code SHALL be limited to authentication, request/header adaptation, query/disclosure instrumentation, response writing, and capability dependency wiring

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.search.lexical` operation is implemented
- **THEN** it SHALL depend on capability-shaped advertisement, manifest, grant, plan-compilation, snapshot-build, snapshot-storage, and record-url-formatting dependencies
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, sandbox modules, the native `server/search.js` helper module, or `process` / `process.env`

#### Scenario: Existing public lexical search semantics are preserved on the native route

- **WHEN** the native `GET /v1/search` route is migrated to the operation
- **THEN** the public JSON response shape, error codes, cursor format, scoring metadata, grant filtering behavior, stream/filter query semantics, and `disclosure.served` event shape SHALL remain equivalent to the previous native route behavior
- **AND** the migration SHALL NOT broaden, narrow, or otherwise change the v1 query-parameter allowlist (`q`, `limit`, `cursor`, `streams`, `streams[]`, `filter`)
- **AND** the migration SHALL NOT change the score-advertisement gate, the cross-stream advertisement gate, or the `filter[...]` requires-exactly-one-`streams[]` rule

### Requirement: `rs.search.semantic` SHALL be operation-owned

The reference implementation SHALL serve public semantic search behavior through a canonical `rs.search.semantic` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, embedding-backend implementation, vector-index implementation, the native `server/search-semantic.js` helper module, and process environment.

#### Scenario: Native semantic search route

- **WHEN** the native reference server handles `GET /v1/search/semantic`
- **THEN** it SHALL execute the canonical `rs.search.semantic` operation for public semantic-search semantics
- **AND** route-specific code SHALL be limited to authentication, request/header adaptation, query/disclosure instrumentation, response writing, and capability dependency wiring

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.search.semantic` operation is implemented
- **THEN** it SHALL depend on capability-shaped advertisement, current-backend-identity, manifest, grant, plan-compilation, snapshot-build, snapshot-storage, result-hydration, and record-url-formatting dependencies
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, sandbox modules, the native `server/search.js` helper module, the native `server/search-semantic.js` helper module, or `process` / `process.env`

#### Scenario: Existing public semantic search semantics are preserved on the native route

- **WHEN** the native `GET /v1/search/semantic` route is migrated to the operation
- **THEN** the public JSON response shape, error codes, cursor format (including the `sem1.` prefix and stale-cursor backend-identity rejection), per-hit score shape on emitted results (exactly `{ kind: "semantic_distance", value, order: "lower_is_better" }` and nothing more), per-hit `retrieval_mode: "semantic"`, grant filtering behavior, stream/filter query semantics, and `disclosure.served` event shape (`query_shape: "search_semantic"`) SHALL remain equivalent to the previous native route behavior
- **AND** the migration SHALL NOT broaden, narrow, or otherwise change the v1 query-parameter allowlist (`q`, `limit`, `cursor`, `streams`, `streams[]`, `filter`)
- **AND** the migration SHALL NOT change the explicit forbidden-parameter list (`vector`, `embedding`, `embed`, `model`, `model_id`, `model_family`, `rank`, `boost`, `weights`, `blend`, `connector_id`, `fields`, `expand`, `expand[]`, `expand_limit`, `expand_limit[]`, `order`, `sort`, `mode`)
- **AND** the migration SHALL NOT change the score-advertisement gate, the cross-stream advertisement gate, the `filter[...]` requires-exactly-one-`streams[]` rule, or the snippet grant-safety property (snippet text is a verbatim contiguous substring of the matched field's stored value)
- **AND** per-hit score objects on `/v1/search/semantic` results SHALL NOT include capability-level metadata fields (`value_semantics`, `comparable_with`, `model`, `dimensions`, `distance_metric`, `profile_id`, `dtype`, `backend_identity`); those remain advertised at `capabilities.semantic_retrieval.score` on `/.well-known/oauth-protected-resource`, not on individual result hits

#### Scenario: Backend identity disclosure stays on the capability surface

- **WHEN** a client reads `/.well-known/oauth-protected-resource`
- **THEN** `capabilities.semantic_retrieval.score` SHALL continue to advertise `value_semantics`, `comparable_with` (backend identity, model, dimensions, distance_metric, and where applicable profile_id/dtype), and the score gate fields (`supported`, `kind`, `order`)
- **AND** the per-hit `score` object on `/v1/search/semantic` results SHALL remain limited to `kind`, `value`, and `order`; backend identity is disclosed once at the capability surface, not repeated on every hit

#### Scenario: No-silent-fallback invariant continues to hold

- **WHEN** the operation module and the native `server/search-semantic.js` helper are read as source
- **THEN** neither SHALL statically import the native lexical helper module `server/search.js`
- **AND** the operation module SHALL NOT statically import `server/search-semantic.js` either, so the operation cannot become a back door around the no-fallback invariant

### Requirement: `rs.streams.detail` SHALL be operation-owned

The reference implementation SHALL serve stream metadata/detail behavior through a canonical `rs.streams.detail` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, and process environment.

#### Scenario: Native stream detail route

- **WHEN** the native reference server handles `GET /v1/streams/:stream`
- **THEN** it SHALL execute the canonical `rs.streams.detail` operation for stream metadata semantics
- **AND** route-specific code SHALL be limited to authentication, path/query adaptation, response writing, and reference instrumentation

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.streams.detail` operation is implemented
- **THEN** it SHALL depend on capability-shaped manifest, stream-summary, grant-visibility, and metadata dependencies
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, or `process.env`

#### Scenario: Existing disclosure behavior is preserved

- **WHEN** the native `GET /v1/streams/:stream` route is migrated to the operation
- **THEN** existing request id, trace id, query-received, query-rejected, and disclosure-served behavior SHALL remain equivalent to the previous native route behavior
- **AND** any intentional difference SHALL be documented in the change design before implementation is accepted

### Requirement: `rs.streams.list` SHALL be operation-owned

The reference implementation SHALL serve stream-list behavior through a canonical `rs.streams.list` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, and process environment.

#### Scenario: Native stream list route

- **WHEN** the native reference server handles `GET /v1/streams`
- **THEN** it SHALL execute the canonical `rs.streams.list` operation for stream-list semantics
- **AND** route-specific code SHALL be limited to authentication, request/header adaptation, response writing, and reference instrumentation

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.streams.list` operation is implemented
- **THEN** it SHALL depend on capability-shaped stream/manifest/grant dependencies
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, or `process.env`

#### Scenario: Existing disclosure behavior is preserved

- **WHEN** the native `GET /v1/streams` route is migrated to the operation
- **THEN** existing request id, trace id, query-received, and disclosure-served behavior SHALL remain equivalent to the previous native route behavior
- **AND** the migration SHALL include regression evidence for that preservation or an explicit owner-reviewed explanation if a specific event is intentionally unchanged outside the operation

### Requirement: Reference Connector And Approval Read Operations

The reference implementation SHALL expose operator connector catalog reads and pending-approval reads through canonical operation modules before host route adapters shape HTTP responses.

#### Scenario: Connector list operation preserves route behavior

**WHEN** the `/_ref/connectors` route serves an owner-authenticated request
**THEN** it SHALL delegate connector catalog response shaping to a boundary-checked operation module
**AND** SHALL preserve the existing response contract.

#### Scenario: Connector detail operation preserves route behavior

**WHEN** the `/_ref/connectors/:connectorId` route serves an owner-authenticated request
**THEN** it SHALL delegate connector detail response shaping to a boundary-checked operation module
**AND** SHALL preserve the existing success and not-found response contracts.

#### Scenario: Approval list operation preserves route behavior

**WHEN** the `/_ref/approvals` route serves an owner-authenticated request
**THEN** it SHALL delegate pending-approval response shaping to a boundary-checked operation module
**AND** SHALL NOT expose redeemable device codes, user codes, request URIs, bearer tokens, or other approval secrets.

### Requirement: `ref.dataset.summary` SHALL be operation-owned

The reference implementation SHALL serve the reference-only `/_ref/dataset/summary` operator-console surface through a canonical `ref.dataset.summary` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, sandbox modules, and process environment.

The operation is reference/operator surface, not PDPP protocol. It SHALL NOT be promoted into PDPP-stable wire semantics by this requirement, and the field-level constraint that `record_json_bytes` is adapter-native operator data (per `define-reference-operation-environments` contract correction (4)) SHALL be preserved by the operation.

#### Scenario: Native dataset-summary route

- **WHEN** the native reference server handles `GET /_ref/dataset/summary`
- **THEN** it SHALL execute the canonical `ref.dataset.summary` operation for envelope assembly
- **AND** route-specific code SHALL be limited to owner authentication, response writing, and capability dependency wiring

#### Scenario: Operation dependency boundary

- **WHEN** the `ref.dataset.summary` operation is implemented
- **THEN** it SHALL depend on capability-shaped count, retained-bytes, record-time-bound, ingest-time-bound, and top-connector-candidate dependencies
- **AND** it SHALL NOT import Fastify, Express, Next, SQLite, Postgres, a raw SQL handle, sandbox modules, `reference-implementation/server/records.js`, `reference-implementation/server/index.js`, or `process` / `process.env`

#### Scenario: Existing dataset-summary semantics are preserved

- **WHEN** the native `GET /_ref/dataset/summary` route is migrated to the operation
- **THEN** the response envelope SHALL preserve `object: 'dataset_summary'`, `connector_count`, `stream_count`, `record_count`, `record_json_bytes`, `record_changes_json_bytes`, `blob_bytes`, `total_retained_bytes`, `earliest_record_time`, `latest_record_time`, `earliest_ingested_at`, `latest_ingested_at`, and `top_connectors` (each `dataset_connector_summary`) bit-for-bit equivalent to the previous native route response
- **AND** the migration SHALL NOT change the public JSON envelope of the route response

#### Scenario: Operation owns top-connector sort and limit

- **WHEN** the operation receives top-connector candidates from its dependency
- **THEN** it SHALL sort the candidates by `record_count` descending with a tiebreak on `connector_id` ascending
- **AND** it SHALL emit at most three entries
- **AND** it SHALL wrap each entry as `{object: 'dataset_connector_summary', connector_id, record_count}`

#### Scenario: Operation owns empty-corpus collapse

- **WHEN** the dependency-supplied `record_count` is `0`
- **THEN** the operation SHALL emit `earliest_record_time`, `latest_record_time`, `earliest_ingested_at`, and `latest_ingested_at` as `null`
- **AND** it SHALL NOT call the time-bound dependencies for those fields

### Requirement: Reference Schedule Read Operations

The reference implementation SHALL expose owner-only schedule reads through canonical operation modules before host route adapters shape HTTP responses.

#### Scenario: Schedule list operation preserves route behavior

**WHEN** the `/_ref/schedules` route serves an owner-authenticated request
**THEN** it SHALL delegate schedule list response shaping to a boundary-checked operation module
**AND** SHALL preserve the existing `{object: "list", data}` response contract.

#### Scenario: Connector schedule operation preserves success projection

**WHEN** the `/_ref/connectors/:connectorId/schedule` route serves an owner-authenticated request and a schedule exists for the connector
**THEN** it SHALL delegate schedule projection to a boundary-checked operation module
**AND** SHALL return the existing `schedule` response body unchanged.

#### Scenario: Connector schedule operation preserves not-found envelope

**WHEN** the `/_ref/connectors/:connectorId/schedule` route serves an owner-authenticated request and no schedule exists for the connector
**THEN** the operation module SHALL surface a typed not-found condition
**AND** the host adapter SHALL respond with the existing PDPP 404 `not_found` error envelope.

#### Scenario: Schedule operations do not import host or storage internals

**WHEN** the operation-boundary gate inspects `operations/ref-schedules-list/` and `operations/ref-connector-schedule-get/`
**THEN** neither module SHALL import Fastify, Next, SQLite, Postgres, the runtime controller, the scheduler store, the server auth module, or `process` / `process.env`.

### Requirement: Reference Spine Operator Read Operations

The reference implementation SHALL expose owner-only operator-console reads of the disclosure spine — correlation lists, per-correlation event timelines, and the spine artifact-jump search — through canonical operation modules before host route adapters shape HTTP responses.

#### Scenario: Spine correlation list operation preserves route behavior

**WHEN** the `/_ref/traces`, `/_ref/grants`, or `/_ref/runs` route serves an owner-authenticated request
**THEN** it SHALL delegate correlation summary envelope assembly to a boundary-checked `ref.spine.correlations.list` operation module
**AND** SHALL preserve the per-kind `trace_summary` / `grant_summary` / `run_summary` discriminator in each `data` entry
**AND** SHALL preserve the `{object: 'list', data, has_more}` envelope with `next_cursor` emitted only when present.

#### Scenario: Spine events page operation preserves route behavior

**WHEN** the `/_ref/traces/:traceId`, `/_ref/grants/:grantId/timeline`, or `/_ref/runs/:runId/timeline` route serves an owner-authenticated request
**THEN** it SHALL delegate timeline envelope assembly to a boundary-checked `ref.spine.events.page` operation module
**AND** SHALL preserve the kind-specific `object` discriminator (`trace` / `grant_timeline` / `run_timeline`), the identifying `*_id` key, the derived `trace_id`, the `event_count`, and the `truncated` / `next_cursor` / `limit` pagination fields
**AND** SHALL NOT echo the live bearer literal `token_id`, the `pending_consent` or `owner_device_auth` `object_id` literal, or the `device_code` / `user_code` / `request_uri` keys inside event `data` — these MUST be stripped or replaced with redaction sentinels by the operation.

#### Scenario: Spine search operation preserves route behavior

**WHEN** the `/_ref/search` route serves an owner-authenticated request
**THEN** it SHALL delegate spine artifact-jump response shaping to a boundary-checked `ref.spine.search` operation module
**AND** SHALL preserve the `{object: 'search_result', exact, traces, grants, runs}` envelope with the per-bucket summary discriminators applied to each entry.

### Requirement: Remaining reference routes SHALL be operation-owned

The reference implementation SHALL serve the remaining inline AS, RS, and `_ref`
route semantics through canonical operation modules or explicit
capability-shaped operation helpers that are independent of the HTTP framework,
sandbox UI, concrete database driver, and process environment.

#### Scenario: Final route adapter boundary

- **WHEN** a covered route is mounted in `reference-implementation/server/index.js`
- **THEN** route-specific code SHALL be limited to HTTP wiring, authentication or
  owner-session checks, request/header adaptation, request id and trace id setup,
  instrumentation dispatch, response writing, and concrete capability wiring
- **AND** protocol/business/storage-shaped semantics SHALL live in the canonical
  operation for that route family

#### Scenario: Operation dependency boundary

- **WHEN** a new operation module is implemented for this change
- **THEN** it SHALL depend on explicit capability-shaped dependencies
- **AND** it SHALL NOT import Fastify, Next, sandbox modules,
  `reference-implementation/server/index.js`, raw SQL handles, concrete database
  drivers, generic repository abstractions, or `process` / `process.env`

#### Scenario: Public behavior preservation

- **WHEN** a route family is migrated to operations under this change
- **THEN** existing public response envelopes, auth gates, error codes, status
  codes, trace/request id behavior, and audit/disclosure event semantics SHALL
  remain equivalent to the previous native route behavior

#### Scenario: Storage-sensitive migrations

- **WHEN** blob, record mutation, ingest, consent, token, or device-code behavior
  is migrated to operations under this change
- **THEN** the migration SHALL preserve existing atomicity, visibility,
  redaction, and secrecy guarantees
- **AND** those guarantees SHALL be pinned by focused tests before merge

### Requirement: Operator oversight surface for client event subscriptions

The reference implementation SHALL expose a reference-only, owner-session-gated oversight surface for client event subscriptions at the operator paths `GET /_ref/event-subscriptions`, `GET /_ref/event-subscriptions/:subscription_id`, and `POST /_ref/event-subscriptions/:subscription_id/disable`. These routes SHALL share the same owner-session middleware as every other `/_ref/*` route. They SHALL NOT accept client bearer tokens. They SHALL NOT modify the protocol-level `/v1/event-subscriptions` surface, and the protected-resource metadata advertisement at `/.well-known/oauth-protected-resource` SHALL NOT advertise them — they are reference-only and discoverable only via the operator console and CLI.

The operator projection returned by `GET /_ref/event-subscriptions` and `GET /_ref/event-subscriptions/:subscription_id` SHALL NOT include the subscription's `secret`, `secret_hash`, or `secret_text`. The detail projection SHALL include the bound grant's scope snapshot, the full callback URL, and at most twenty-five most-recent attempt rows for the subscription.

The operator oversight surface SHALL be read-mostly. The reference SHALL NOT expose operator-initiated subscription creation, re-enable, secret rotation, or attempt replay via these routes. Operator-initiated disable is the only mutating affordance.

#### Scenario: An operator lists subscriptions on the instance
- **WHEN** an operator with a valid owner session reads `GET /_ref/event-subscriptions`
- **THEN** the reference SHALL return a `{object: 'list', data}` envelope containing every non-deleted subscription persisted on the instance
- **AND** each row SHALL include `subscription_id`, `client_id`, `grant_id`, `status`, `disabled_reason`, the callback URL's host component, `created_at`, `updated_at`, `disabled_at`, a pending-queue count, the last attempt's outcome (timestamp, ok flag, HTTP status code), and a final-failure attempt count
- **AND** the response SHALL NOT include `secret`, `secret_hash`, or `secret_text` for any row

#### Scenario: An operator filters the list by client, grant, or status
- **WHEN** the operator passes `?client_id=`, `?grant_id=`, or `?status=` (or any combination)
- **THEN** the reference SHALL return only the subscriptions matching every supplied filter
- **AND** unknown filter values SHALL still return a well-formed empty list rather than a 4xx error

#### Scenario: An operator reads the detail projection
- **WHEN** the operator requests `GET /_ref/event-subscriptions/:subscription_id` for a subscription that exists and is not deleted
- **THEN** the response SHALL include the full callback URL, the bound grant's scope snapshot, the same status fields as the list projection, and a bounded list of at most twenty-five most-recent attempt rows ordered by `attempted_at` descending
- **AND** the response SHALL NOT include the subscription's secret material

#### Scenario: An operator requests a deleted or unknown subscription
- **WHEN** the operator requests `GET /_ref/event-subscriptions/:subscription_id` for a subscription whose status is `deleted` or whose id does not exist
- **THEN** the reference SHALL return HTTP 404 with a standard error envelope

#### Scenario: A request without an owner session is rejected
- **WHEN** any of the three `/_ref/event-subscriptions*` routes is called without a valid owner session
- **THEN** the reference SHALL respond with the standard owner-session-required envelope (HTTP 401) that the rest of the `/_ref/*` surface uses
- **AND** the response SHALL NOT disclose whether the requested subscription exists

#### Scenario: A request with a client bearer is rejected
- **WHEN** any of the three `/_ref/event-subscriptions*` routes is called with an `Authorization: Bearer` header carrying a client token (with or without an owner session cookie)
- **THEN** the reference SHALL still require the owner-session middleware to pass; absent a valid owner session it SHALL return HTTP 401 regardless of bearer presence

### Requirement: Operator-initiated subscription disable is a recoverable safety valve

The reference SHALL expose `POST /_ref/event-subscriptions/:subscription_id/disable` as the operator's safety-valve to stop deliveries to a callback without touching the bound grant or the client's own subscription state machine. The route SHALL accept an optional JSON body `{ reason: string }` whose value (when provided) replaces the default `disabled_reason` value `"operator_disabled"` on the persisted row. The route SHALL be idempotent: invocations on subscriptions already in `disabled`, `disabled_failure`, `disabled_revoked`, or `deleted` SHALL succeed without modifying the row.

A subscription disabled by the operator SHALL remain recoverable through the client's own `PATCH /v1/event-subscriptions/:id { enabled: true }` request. The reference SHALL NOT add an operator-initiated re-enable path; an operator who needs to permanently stop a callback SHALL revoke the bound grant.

#### Scenario: An operator disables an active subscription
- **WHEN** the operator posts to `POST /_ref/event-subscriptions/:subscription_id/disable` for a subscription in `active` or `pending_verification` status
- **THEN** the reference SHALL transition the subscription to `disabled`
- **AND** the persisted `disabled_reason` SHALL be `"operator_disabled"` when no reason was supplied, or the operator-supplied reason string otherwise
- **AND** the reference SHALL drop any pending queued events for that subscription
- **AND** the response SHALL return the operator detail projection for the now-disabled subscription

#### Scenario: A client re-enables an operator-disabled subscription
- **WHEN** the client whose grant binds the subscription sends `PATCH /v1/event-subscriptions/:id { enabled: true }` to a subscription in `disabled` status with `disabled_reason: "operator_disabled"` (or an operator-supplied reason)
- **THEN** the reference SHALL transition the subscription back to `active`
- **AND** subsequent in-scope record changes SHALL again enqueue events for that subscription

#### Scenario: Operator disable on an already-disabled subscription
- **WHEN** the operator posts to `POST /_ref/event-subscriptions/:subscription_id/disable` for a subscription whose status is already `disabled`, `disabled_failure`, `disabled_revoked`, or `deleted`
- **THEN** the reference SHALL return HTTP 200 (idempotent success) with the current detail projection
- **AND** SHALL NOT overwrite the existing `disabled_reason` or `disabled_at` columns

#### Scenario: Operator disable preserves the bound grant
- **WHEN** the operator disables a subscription bound to an active grant
- **THEN** the bound grant SHALL remain `active`
- **AND** other subscriptions bound to the same grant SHALL be unaffected

### Requirement: Operator oversight is mirrored by the reference CLI

The `@pdpp/cli` package SHALL expose `pdpp ref event-subscriptions list`, `pdpp ref event-subscriptions show <subscription-id>`, and `pdpp ref event-subscriptions disable <subscription-id>` subcommands that call the corresponding `_ref` routes using the existing owner-session cookie cache. The CLI SHALL refuse to send the disable POST without explicit confirmation (a `yes`-typed prompt or the `--yes` flag). The CLI SHALL never display or echo subscription secret material, since the `_ref` projection never includes it.

#### Scenario: An operator runs the list command
- **WHEN** the operator invokes `pdpp ref event-subscriptions list --as-url <url>` with a cached owner session
- **THEN** the CLI SHALL fetch `GET /_ref/event-subscriptions` and render the operator projection in the requested format (`table` by default, `json` on `--format json`)
- **AND** the CLI SHALL forward `--client-id`, `--grant-id`, and `--status` flags as query parameters

#### Scenario: An operator runs the disable command without --yes
- **WHEN** the operator invokes `pdpp ref event-subscriptions disable <subscription-id> --as-url <url>` without `--yes`
- **THEN** the CLI SHALL print the subscription summary and prompt for `yes` before posting to `POST /_ref/event-subscriptions/:id/disable`
- **AND** any input other than `yes` (case-insensitive) SHALL abort with exit code 1 and no network call

#### Scenario: An operator runs the disable command with --yes
- **WHEN** the operator invokes `pdpp ref event-subscriptions disable <subscription-id> --as-url <url> --yes --reason loop_suspected`
- **THEN** the CLI SHALL post `{"reason": "loop_suspected"}` to the disable route without prompting
- **AND** the CLI SHALL render the resulting detail projection

### Requirement: Operator oversight is mirrored by the reference dashboard

The reference operator console SHALL expose `/dashboard/event-subscriptions` as a list-with-peek view backed by the `_ref/event-subscriptions*` routes. The dashboard SHALL display only the operator projection (no secret material). The peek pane SHALL include a confirmed Disable affordance that posts to `POST /_ref/event-subscriptions/:id/disable` via a server action. The dashboard SHALL NOT expose any other mutating affordance for client subscriptions.

#### Scenario: An operator visits the dashboard page
- **WHEN** the operator navigates to `/dashboard/event-subscriptions` with a valid owner session
- **THEN** the dashboard SHALL render the list of subscriptions with status badges, callback hosts, last attempt outcomes, and counts
- **AND** SHALL provide filter controls for client, grant, and status

#### Scenario: An operator opens the peek pane and disables a subscription
- **WHEN** the operator opens the peek pane for a subscription in `active` status, confirms the disable dialog, and submits the form
- **THEN** the dashboard SHALL invoke the disable server action, which calls `POST /_ref/event-subscriptions/:id/disable`
- **AND** the dashboard SHALL refresh the page to render the now-disabled status

### Requirement: Grant-scoped state resolution SHALL consult the active storage backend

Grant resolution for the reference's grant-scoped state operations (the `rs.connector-state.get` and `rs.connector-state.put` injection points) SHALL read the persisted grant row from the storage backend selected by `isPostgresStorageBackend()`. The downstream contract — `requirePersistedGrantState` / `requireResolvedPersistedGrantState`, the `access_mode === 'continuous'` check, the connector-id binding check, and the persisted-grant row shape — SHALL remain identical across backends.

#### Scenario: A grant is issued under the Postgres storage backend

- **WHEN** the reference is configured for the Postgres storage backend and a continuous-mode grant has been written to the Postgres `grants` table
- **THEN** the grant-scoped state grant resolver SHALL locate the grant row by reading from Postgres
- **AND** SHALL NOT return `not_found` solely because the SQLite `grants` table is empty
- **AND** SHALL surface `grant_invalid`, `invalid_request`, or `not_found` exactly as it would have for an equivalent SQLite-issued grant under the SQLite backend

#### Scenario: A grant is issued under the SQLite storage backend

- **WHEN** the reference is configured for the SQLite storage backend and a continuous-mode grant has been written to the SQLite `grants` table
- **THEN** the grant-scoped state grant resolver SHALL locate the grant row via the existing `grantsGetScopedStateById` query
- **AND** SHALL NOT issue a Postgres query

#### Scenario: A grant id is absent from the active backend

- **WHEN** the supplied `grantId` does not exist in the active storage backend's `grants` table
- **THEN** the resolver SHALL throw an error with `code = 'not_found'`
- **AND** SHALL NOT fall back to the other backend

### Requirement: Record-delete on the active storage backend SHALL be consistent across stream-wide and connector-wide invalidation

The reference implementation SHALL execute record deletion against the active storage backend selected by `PDPP_STORAGE_BACKEND`. Both the per-stream owner-reset path (`deleteAllRecords(storageTarget, stream)`, called by `rs.records.delete_stream`) and the connector-wide invalidation path (`deleteAllRecordsForConnector(connectorId)`, called by the polyfill manifest reconciler on the seed-fixture → polyfill transition) SHALL run against the same backend, SHALL share the same per-pair durable-tail construction, and SHALL succeed for the same payloads they support on SQLite. Neither path SHALL fail at runtime under the active Postgres storage backend with an error that indicates an internal SQL construction defect (for example, the pg extended-protocol prepared-statement multi-statement restriction).

The per-pair durable tail SHALL clear `record_changes`, `records`, `version_counter`, and the lexical and semantic search tables scoped to that `(connector_instance_id, stream)` pair. The connector-wide path SHALL additionally drop `blob_bindings` for the pair, mirroring the SQLite per-connector path's superset of the SQLite per-stream path. The connector-wide path SHALL NOT depend on a different backend's namespace discovery to enumerate `(connector_instance_id, stream)` pairs in the active backend.

#### Scenario: A Postgres-backed deployment reconciles the seed-fixture → polyfill transition
- **WHEN** `PDPP_STORAGE_BACKEND=postgres` and the reconciler fires the fingerprint-gated transition for a `connector_id` that has live records in the Postgres `records` table
- **THEN** the connector-wide invalidation SHALL delete those Postgres records, record_changes, version_counter, blob_bindings, and lexical/semantic index rows
- **AND** the helper SHALL return a `deletedCount` equal to the number of live (`deleted = FALSE`) Postgres `records` rows it removed
- **AND** the operator log line SHALL report the non-zero invalidation count

#### Scenario: A Postgres-backed owner reset clears one stream and leaves siblings intact
- **WHEN** `PDPP_STORAGE_BACKEND=postgres` and `deleteAllRecords(storageTarget, target_stream)` is invoked for a `(connector_id, connector_instance_id)` that has live records on `target_stream` and on at least one sibling stream
- **THEN** the helper SHALL succeed (no prepared-statement multi-statement runtime error) and SHALL return the count of live records it removed from `target_stream`
- **AND** Postgres `records`, `record_changes`, `version_counter`, and `lexical_search_*` / `semantic_search_*` rows scoped to `target_stream` SHALL be removed
- **AND** the sibling stream's records and `version_counter` row SHALL be untouched

#### Scenario: A SQLite-backed deployment is unaffected by the routing change
- **WHEN** `PDPP_STORAGE_BACKEND` resolves to `sqlite` (the default) and either the per-stream or connector-wide delete path is invoked
- **THEN** the helper SHALL continue to delete from SQLite using the existing `referenceQueries.recordsDelete*` primitives
- **AND** the returned `deletedCount` and `streams` shape SHALL match the prior SQLite-only behavior byte-for-byte

#### Scenario: A backend's namespace contains only history or blob bindings
- **WHEN** the active backend has a connector with no live `records` rows but still has `record_changes` history or surviving `blob_bindings`
- **THEN** the connector-wide helper SHALL discover those `(connector_instance_id, stream)` pairs from the active backend and drop the residual history and bindings

### Requirement: Blob Store Conformance Harness

The reference implementation SHALL maintain a test-only blob-store conformance harness before promoting blob persistence into a production storage interface.

#### Scenario: Multiple drivers prove the blob-store contract

**WHEN** the blob-store conformance suite runs
**THEN** it SHALL exercise at least the production SQLite-backed driver and one non-SQLite memory driver
**AND** both drivers SHALL satisfy the same content-address and binding invariants while advertising their backend identity.

#### Scenario: Broken driver proves falsifiability

**WHEN** a deliberately broken blob-store driver violates content-address dedupe or binding idempotency
**THEN** the conformance suite SHALL fail.

#### Scenario: Harness remains test-only

**WHEN** the harness is introduced
**THEN** it SHALL NOT create a production `BlobStore` interface
**AND** SHALL NOT change public `/v1/blobs` wire behavior
**AND** SHALL NOT move blob bytes out of SQLite.

### Requirement: Connector state and scheduler persistence semantics SHALL be conformance-tested before storage extraction

Before introducing production `ConnectorStateStore` or `SchedulerStore` abstractions, the reference implementation SHALL define reusable test-only conformance scenarios that pin the current connector-state, schedule, and active-run persistence obligations.

#### Scenario: Connector state conformance

- **WHEN** a candidate connector-state persistence driver is evaluated
- **THEN** it SHALL pass conformance scenarios for owner-scoped state upsert/list, overwrite behavior, grant-scoped state isolation, and allowed-stream enforcement where feasible
- **AND** any behavior left to route/runtime tests SHALL be explicitly documented as deferred from the storage conformance harness

#### Scenario: Schedule conformance

- **WHEN** a candidate scheduler persistence driver is evaluated
- **THEN** it SHALL pass conformance scenarios for schedule create, update, list, pause, resume, and delete behavior where feasible
- **AND** schedule policy warnings that are not storage behavior SHALL remain covered by controller tests unless a narrow persistence seam already exists

#### Scenario: Active-run conformance

- **WHEN** a candidate active-run persistence driver is evaluated
- **THEN** it SHALL pass conformance scenarios for one-active-run-per-connector, unique run id, lookup, delete, and abandoned-run cleanup behavior where feasible
- **AND** any controller-only behavior SHALL remain covered by existing route/controller tests

#### Scenario: Harness boundary

- **WHEN** the conformance harness is implemented
- **THEN** it SHALL live under `reference-implementation/test/**`
- **AND** it SHALL expose semantic lifecycle operations rather than raw SQL, table names, generic repositories, or production store interfaces
- **AND** it SHALL include a falsifiability proof that fails on at least one deliberately broken state, schedule, or active-run invariant

### Requirement: Consent and owner-device auth semantics SHALL be conformance-tested before storage extraction

Before introducing production `ConsentStore` or `OwnerDeviceAuthStore` abstractions, the reference implementation SHALL define reusable test-only conformance scenarios that pin the current pending-consent and owner-device-authorization lifecycle/security obligations.

#### Scenario: Pending consent conformance

- **WHEN** a candidate pending-consent storage driver is evaluated
- **THEN** it SHALL pass conformance scenarios for pending lookup, terminal approval/denial behavior, approval-id indirection, and expiry or unavailable-state behavior where feasible
- **AND** any behavior left to route-level tests SHALL be explicitly documented as deferred from the storage conformance harness

#### Scenario: Owner device authorization conformance

- **WHEN** a candidate owner-device-authorization storage driver is evaluated
- **THEN** it SHALL pass conformance scenarios for start, lookup, poll-before-approval, approval/exchange, denied/expired rejection, and polling interval behavior where feasible
- **AND** it SHALL preserve the current reference secret-handling boundary for `device_code`, `user_code`, and approval identifiers

#### Scenario: Harness boundary

- **WHEN** the conformance harness is implemented
- **THEN** it SHALL live under `reference-implementation/test/**`
- **AND** it SHALL expose semantic lifecycle operations rather than raw SQL, table names, generic repositories, or production store interfaces
- **AND** it SHALL include a falsifiability proof that fails on at least one deliberately broken lifecycle or security invariant

### Requirement: Disclosure spine SHALL have a reusable conformance harness

The reference implementation SHALL provide a test-only conformance harness for disclosure-spine semantics before extracting production `DisclosureSpineStore` contracts or claiming alternate storage adapter compatibility for spine behavior.

#### Scenario: Current SQLite reference driver

- **WHEN** the disclosure-spine conformance harness runs against the current SQLite-backed reference implementation
- **THEN** it SHALL prove append order, correlation timeline ordering, pagination cursor behavior where supported, terminal event lookup, and correlation summary aggregate extent through reusable scenarios
- **AND** it SHALL NOT require production code to expose a generic repository, raw SQL handle, route handler, ORM builder, or `DisclosureSpineStore` abstraction

#### Scenario: Harness falsifiability

- **WHEN** the conformance harness is exercised against a deliberately broken test fixture for at least one spine invariant
- **THEN** the test suite SHALL prove that the harness detects the broken behavior
- **AND** the broken fixture SHALL NOT be used as a production adapter or environment profile

#### Scenario: Scope boundary

- **WHEN** the harness is introduced
- **THEN** it SHALL remain limited to disclosure-spine semantics
- **AND** it SHALL NOT claim coverage for record storage, lexical retrieval, semantic retrieval, hybrid retrieval, blob content, or connector runtime behavior

### Requirement: Lexical Retrieval Conformance Harness

The reference implementation SHALL maintain a test-only lexical retrieval conformance harness before promoting lexical indexing into a production storage interface.

#### Scenario: Multiple drivers prove the lexical contract

**WHEN** the lexical conformance suite runs
**THEN** it SHALL exercise at least the production SQLite-backed driver and one non-SQLite memory driver
**AND** both drivers SHALL satisfy the same semantic retrieval invariants while advertising their backend identity and score semantics.

#### Scenario: Broken driver proves falsifiability

**WHEN** a deliberately broken lexical driver drops indexed content or violates deterministic result ordering
**THEN** the conformance suite SHALL fail.

#### Scenario: Harness remains test-only

**WHEN** the harness is introduced
**THEN** it SHALL NOT create a production `LexicalIndex` interface
**AND** SHALL NOT change public `/v1/search` behavior.

### Requirement: Durable record mutation SHALL have a reusable conformance harness

The reference implementation SHALL provide a test-only conformance harness for durable record mutation semantics before extracting a production `RecordStore` or adding a second storage adapter for records.

#### Scenario: Current SQLite reference driver

- **WHEN** the record mutation conformance harness runs against the current SQLite-backed reference implementation
- **THEN** it SHALL prove changed writes, no-op writes, ingest deletes, direct deletes, rollback behavior, and version contiguity through the same reusable scenarios
- **AND** it SHALL NOT require production code to expose a generic repository, SQL handle, ORM builder, or `RecordStore` abstraction

#### Scenario: Harness falsifiability

- **WHEN** the conformance harness is exercised against a deliberately broken test fixture for at least one durable mutation invariant
- **THEN** the test suite SHALL prove that the harness detects the broken behavior
- **AND** the broken fixture SHALL NOT be used as a production adapter or environment profile

#### Scenario: Scope boundary

- **WHEN** the harness is introduced
- **THEN** it SHALL remain limited to durable record mutation semantics
- **AND** it SHALL NOT claim coverage for record read/list cursors, `changes_since`, range filters, `expand[]`, lexical retrieval, semantic retrieval, hybrid retrieval, or disclosure spine conformance

### Requirement: Durable record reads SHALL have a reusable conformance harness

The reference implementation SHALL provide a test-only conformance harness for durable record read semantics before extracting production `RecordStore` read contracts or claiming alternate storage adapter compatibility for record reads.

#### Scenario: Current SQLite reference driver

- **WHEN** the record-read conformance harness runs against the current SQLite-backed reference implementation
- **THEN** it SHALL prove stable record-list pagination, cursor round trips, `changes_since` bootstrap/cursor behavior, field projection, and declared filter behavior through reusable scenarios
- **AND** it SHALL NOT require production code to expose a generic repository, raw SQL handle, route handler, ORM builder, or `RecordStore` abstraction

#### Scenario: Harness falsifiability

- **WHEN** the conformance harness is exercised against a deliberately broken test fixture for at least one record-read invariant
- **THEN** the test suite SHALL prove that the harness detects the broken behavior
- **AND** the broken fixture SHALL NOT be used as a production adapter or environment profile

#### Scenario: Scope boundary

- **WHEN** the harness is introduced
- **THEN** it SHALL remain limited to durable record read/list semantics
- **AND** it SHALL NOT claim coverage for record mutation atomicity, disclosure spine conformance, lexical retrieval, semantic retrieval, hybrid retrieval, blob content, or connector runtime behavior

### Requirement: Connectors SHALL build their `validateRecord` from a shared `makeValidateRecord` helper
The polyfill-connectors package SHALL provide a `makeValidateRecord(schemas)` helper that takes a stream-keyed registry of zod schemas and returns a `ValidateRecord` closure with consistent diagnostic shape (`{ ok: true, data }` on pass; `{ ok: false, issues: [{ path, message }, ...] }` on fail; pass-through `{ ok: true, data }` on unknown stream).

Every connector that ships a `schemas.ts` SHALL build its `validateRecord` from this helper rather than reimplementing the safeParse / unwrap / format-issues loop.

#### Scenario: A new connector author adds shape validation
- **WHEN** a connector author writes a `schemas.ts` for their connector
- **THEN** the file SHALL declare a stream-keyed `SCHEMAS` registry of zod schemas
- **AND** export `validateRecord = makeValidateRecord(SCHEMAS)` as the connector's validator
- **AND** SHALL NOT reimplement the safeParse / format-issues loop inline

#### Scenario: An unknown stream passes through
- **WHEN** the helper is invoked with a stream name not present in the registry
- **THEN** the helper SHALL return `{ ok: true, data }` without further checks
- **AND** the connector runtime SHALL emit the record normally

### Requirement: Connector status SHALL distinguish capability, selection, and outcome
The reference implementation SHALL keep connector stream capability, owner/run stream selection, and run outcome distinct when computing connector health. A stream that is not available in the selected connector mode SHALL NOT by itself imply that a run failed or that selected data was lost.

#### Scenario: Unsupported stream is not selected by default
- **WHEN** a connector manifest marks a stream as unsupported in the active collection mode
- **THEN** the reference SHALL NOT request that stream by default for that mode
- **AND** the connector health state SHALL NOT become degraded solely because that unsupported stream exists in the manifest

#### Scenario: Selected stream cannot be collected
- **WHEN** the owner or runtime explicitly requests a stream and the connector cannot collect that selected stream
- **THEN** the reference SHALL record an actionable or explicitly accepted informational gap
- **AND** it SHALL NOT silently report complete coverage for the selected stream

#### Scenario: Successful run has only informational limitations
- **WHEN** a connector run succeeds and its only gaps are informational capability limitations or user-disabled streams
- **THEN** the reference SHALL treat the run as successful as configured for connector health
- **AND** the dashboard MAY surface the limitations in a detail view without rendering the connector as degraded

### Requirement: Known gaps SHALL carry severity semantics
The reference implementation SHALL classify known gaps by severity or reason class before using them for health projection. Gap severity SHALL distinguish informational limitations, transient/retryable pressure, actionable missing selected data, and recoverable detail backlog.

#### Scenario: Informational gap is recorded
- **WHEN** a connector reports an expected unsupported-in-mode stream, user-disabled stream, or out-of-scope stream
- **THEN** the reference SHALL classify the gap as informational
- **AND** informational gaps SHALL NOT by themselves mark connector health as degraded

#### Scenario: Transient gap is recorded
- **WHEN** a connector reports rate limit, upstream pressure, temporary unavailability, or retry exhaustion for selected data
- **THEN** the reference SHALL classify the gap as transient unless a more specific recovery model applies
- **AND** connector health MAY become degraded or cooling-off according to retry/backoff policy

#### Scenario: Actionable gap is recorded
- **WHEN** selected data was not delivered and the owner, operator, or connector author can take action to recover coverage
- **THEN** the reference SHALL classify the gap as actionable
- **AND** connector health SHALL surface degraded or needs-attention status until a later run resolves the condition

#### Scenario: Recoverable detail backlog is recorded
- **WHEN** missing required detail is represented by the reference detail-gap recovery model
- **THEN** the reference SHALL classify that gap as recoverable
- **AND** connector health SHALL follow the detail-gap recovery policy rather than treating the gap as a generic unknown failure

### Requirement: Connector health SHALL use gap severity rather than gap count
The reference connector-health projection SHALL NOT treat every non-empty known-gap list as degraded. It SHALL evaluate run status, gap severity, auth/setup state, retry/backoff state, and freshness state.

#### Scenario: Slack has only expected slackdump-mode limitations
- **WHEN** Slack runs in slackdump archive mode and the only unavailable streams are `stars`, `user_groups`, `reminders`, or `dm_read_states` marked unsupported in that mode
- **THEN** the reference SHALL NOT mark Slack degraded solely because those streams are unavailable
- **AND** the dashboard SHALL keep the limitation visible as connector detail or coverage information

#### Scenario: Actionable selected-stream gap remains degraded
- **WHEN** a successful run includes an actionable gap for data selected by the owner or runtime
- **THEN** the reference SHALL mark connector health as degraded or needs-attention according to the health classifier

#### Scenario: Historical unclassified gap is read
- **WHEN** the reference reads an older known gap without severity metadata
- **THEN** it SHALL treat the gap conservatively as actionable unless a newer classified run supersedes it

### Requirement: Stream-level read operations SHALL direct callers to `/v1/schema` for field-level filters

The operation summary text published by `@pdpp/reference-contract` for `listStreams` and `getStreamMetadata` SHALL explicitly state that these endpoints return stream-level totals only, and SHALL direct the caller to `GET /v1/schema` first when they need field-level filter capabilities. This turns a class of foreseeable 400-failures (a caller attaches `filter[...]` to a stream-level endpoint that does not accept it) into a self-teaching contract hint. Connection identity on these operations' response items is owned by `expose-connection-identity-on-public-read` and is NOT defined here.

#### Scenario: An LLM caller reads the `listStreams` summary

- **WHEN** an LLM caller or contract-driven tool description renders the `listStreams` operation summary
- **THEN** the summary SHALL state that the endpoint returns stream-level totals
- **AND** the summary SHALL name `/v1/schema` as the endpoint to consult for field-level filter capabilities before constructing a filtered query.

#### Scenario: An LLM caller reads the `getStreamMetadata` summary

- **WHEN** an LLM caller or contract-driven tool description renders the `getStreamMetadata` operation summary
- **THEN** the summary SHALL state that the endpoint returns metadata for a single stream and SHALL NOT advertise field-level filtering
- **AND** the summary SHALL name `/v1/schema` as the endpoint to consult for field-level filter capabilities.

### Requirement: Hybrid pagination unavailability SHALL be advertised and cross-referenced

When the hybrid retrieval extension is advertised on the resource server, the protected-resource discovery hints SHALL include `hybrid_pagination_supported` derived from the same live runtime state that drives the hybrid capability advertisement, and the `searchRecordsHybrid` operation summary SHALL reference that hint and SHALL name lexical search as the cursor-pagination fallback. The agent-facing query cookbook SHALL document the same limitation, so callers learn the boundary from contract or docs before they hit a 400.

#### Scenario: Hybrid is advertised but cursor pagination is not supported

- **WHEN** the resource server advertises the hybrid retrieval extension and the runtime hybrid implementation does not support cursor pagination
- **THEN** `pdpp_discovery_hints.hybrid_pagination_supported` SHALL be present in the protected-resource metadata document with value `false`
- **AND** the `searchRecordsHybrid` operation summary SHALL reference `pdpp_discovery_hints.hybrid_pagination_supported`
- **AND** the operation summary SHALL name lexical search as the recommended fallback when cursor pagination is required.

#### Scenario: Hybrid is not advertised

- **WHEN** the resource server does not advertise the hybrid retrieval extension
- **THEN** `pdpp_discovery_hints.hybrid_pagination_supported` SHALL be omitted from the protected-resource metadata document rather than emitted with a default value
- **AND** the contract for `searchRecordsHybrid` MAY still reference the hint, but consumers SHALL treat an omitted hint as "field not applicable on this resource server."

#### Scenario: The query cookbook documents the same boundary

- **WHEN** an agent reads `docs/agent-skills/pdpp-data-access/references/query-cookbook.md`
- **THEN** the cookbook SHALL state that hybrid does not support `cursor`
- **AND** the cookbook SHALL recommend lexical search as the fallback when the caller needs more than `limit` results.

### Requirement: The `filter` parameter description SHALL point callers at `/v1/schema` `field_capabilities`

The JSON Schema `description` on the `filter` property of `ListRecordsQuerySchema` published by `@pdpp/reference-contract` SHALL describe both the exact-match shape (`filter[field]=value`) and the range shape (`filter[field][op]=value`), and SHALL name `field_capabilities` on `GET /v1/schema` as the source of the legal operator set for `op`. This is a description change only; it SHALL NOT change the parameter's type, format, or runtime validation.

#### Scenario: A caller renders the `filter` parameter description

- **WHEN** an LLM caller or contract-driven tool description renders the `description` of the `filter` parameter on the records-list operation
- **THEN** the description SHALL include both `filter[field]=value` and `filter[field][op]=value` as legal shapes
- **AND** the description SHALL name `field_capabilities` from `GET /v1/schema` as the source of the legal `op` values
- **AND** the parameter's `type`, `format`, and runtime validation SHALL NOT change relative to the pre-change contract.

### Requirement: Reference auth docs SHALL distinguish shipped profile from future OAuth profiles

The reference documentation SHALL distinguish the live reference auth profile from generic OAuth authorization-code profiles that are not currently advertised.

#### Scenario: App token issuance is documented

- **WHEN** documentation explains how clients obtain app tokens
- **THEN** it SHALL NOT imply the current reference exposes a generic authorization-code redirect flow
- **AND** it SHALL describe the shipped PAR plus consent direct-token handoff as the current reference profile.

### Requirement: Authorization-server metadata SHALL declare agent connect endpoint

The reference public contract SHALL include the agent connect endpoint that the authorization server emits.

#### Scenario: AS metadata is fetched

- **WHEN** a caller fetches `/.well-known/oauth-authorization-server`
- **THEN** the metadata SHALL include `agent_connect_endpoint`
- **AND** the public contract schema and generated docs SHALL describe the field as a URI.

### Requirement: Browser-backed polyfill connectors SHALL declare a browser runtime binding

The reference implementation SHALL make browser automation requirements visible in polyfill connector manifests using `runtime_requirements.bindings.browser`.

#### Scenario: Browser-backed connector manifest is inspected

- **WHEN** a polyfill connector uses the reference browser runtime
- **THEN** its manifest SHALL declare `runtime_requirements.bindings.browser.required` equal to `true`
- **AND** the manifest SHALL NOT rely on `network` alone to imply browser automation.

#### Scenario: Reference runtime starts a connector

- **WHEN** the reference runtime sends a `START` envelope to a connector
- **THEN** the available bindings SHALL include `browser`
- **AND** a manifest requiring the `browser` binding SHALL pass binding matching when the runtime can supply browser automation.

#### Scenario: Runtime requirement binding declaration is malformed

- **WHEN** a connector manifest declares an unsupported runtime binding or a non-boolean `required` value
- **THEN** connector registration SHALL reject the manifest with a typed `invalid_request` response that identifies the malformed runtime requirement.

### Requirement: Polyfill connector manifests SHALL expose external subprocess tool dependencies

The reference implementation SHALL support static manifest metadata for external subprocess tools required by polyfill connectors.

#### Scenario: Connector manifest declares an external subprocess tool

- **WHEN** a polyfill connector depends on an external subprocess binary
- **THEN** its manifest SHALL declare the dependency under `runtime_requirements.external_tools`
- **AND** each declaration SHALL include `name`, `license`, and `purpose`.

#### Scenario: Slack connector manifest is inspected

- **WHEN** the Slack connector manifest is inspected
- **THEN** it SHALL declare `slackdump` as an external tool
- **AND** the declaration SHALL include its license and an owner-usable install hint.
- **AND** the declaration MAY include non-executed detection metadata.

#### Scenario: External tool declaration is malformed

- **WHEN** a connector manifest declares malformed `runtime_requirements.external_tools`
- **THEN** connector registration SHALL reject the manifest with a typed `invalid_request` response that identifies the malformed external tool declaration.

### Requirement: Hosted MCP package tokens SHALL enforce through child grants

The reference resource server SHALL resolve hosted MCP package tokens to active child grants and SHALL enforce each read through the selected child grant before returning records, blobs, stream metadata, schema, or search results.

#### Scenario: Package search fans out

- **WHEN** a hosted MCP package token searches across approved sources
- **THEN** the resource server SHALL execute source-local searches under each active child grant
- **AND** returned results SHALL include source identity.

#### Scenario: Package record query names a source

- **WHEN** a hosted MCP package token queries records for a source and stream
- **THEN** the resource server SHALL route the read to the child grant for that source
- **AND** the existing stream, field, time-range, resource, and manifest checks SHALL apply.

#### Scenario: Package record query omits source

- **WHEN** a hosted MCP package token has more than one active child grant and the client calls a source-specific read without a source selector
- **THEN** the resource server SHALL reject the request with an explicit source-disambiguation error.

### Requirement: Hosted MCP package tokens SHALL remain read-only client tokens

Hosted MCP package tokens SHALL be client tokens accepted only by grant-scoped read surfaces and SHALL NOT be treated as owner/admin tokens.

#### Scenario: Package token calls owner route

- **WHEN** a hosted MCP package token calls an owner-only reference route
- **THEN** the server SHALL reject the request as lacking owner authority.

### Requirement: Hosted MCP package adapter SHALL route every read under exactly one child grant

The hosted MCP `/mcp` handler SHALL substitute a package-aware adapter (`PackageRsClient`) for the default single-bearer RS client whenever the inbound token is `pdpp_token_kind=mcp_package`. The adapter SHALL NOT forward a "first active member" token, SHALL NOT widen a single child grant's authority to cover other approved sources, and SHALL run every record/blob/event-subscription read under exactly one child grant's scoped client bearer.

#### Scenario: Schema and list_streams fan out per source

- **WHEN** a package token calls `schema` or `list_streams`
- **THEN** the adapter SHALL fan out across each active child grant and SHALL merge the responses with source identity (`grant_id`, `connector_key`, `connection_id`) attached to every stream and granted connection row
- **AND** the merged envelope SHALL include `meta.package.member_count` so the client can tell it is operating under a package token.

#### Scenario: Search fans out across children and preserves the selected REST search mode

- **WHEN** a package token calls `search` with `mode=lexical`, `mode=semantic`, or `mode=hybrid`
- **THEN** the adapter SHALL forward the call through `/v1/search`, `/v1/search/semantic`, or `/v1/search/hybrid` respectively
- **AND** it SHALL execute one source-local search per active child grant under that child's bearer
- **AND** every merged hit SHALL carry canonical connector key and connection identity.

#### Scenario: Source-specific reads without a selector return typed ambiguous_connection

- **WHEN** a package token with more than one active child grant calls `query_records`, `fetch`, `fetch_blob`, or an event-subscription create operation without `connection_id`
- **THEN** the adapter SHALL return a typed `ambiguous_connection` (409) error envelope including `available_connections` (one entry per active member with `grant_id`, `connector_key`, `connection_id`, optional `display_name`) and `retry_with: "connection_id"`
- **AND** it SHALL NOT call any child grant's RS bearer.

#### Scenario: Unknown selector returns typed not_found

- **WHEN** a package token passes a `connection_id` that does not match any active member
- **THEN** the adapter SHALL return a typed `not_found` (404) error envelope including the candidate list
- **AND** it SHALL NOT fan out to any member.

### Requirement: Hosted MCP package event subscriptions SHALL bind to one child grant

Hosted MCP package tokens SHALL NOT create cross-source event subscriptions. Each persisted event subscription row SHALL belong to exactly one child grant's `grant_id`.

#### Scenario: Create requires a child selector when the package is multi-source

- **WHEN** a package token with more than one active child grant calls `create_event_subscription` without `connection_id`
- **THEN** the adapter SHALL return a typed `ambiguous_connection` (409)
- **AND** SHALL NOT issue any RS write call.

#### Scenario: Create with a single-source package infers the child

- **WHEN** a package token with exactly one active child grant calls `create_event_subscription`
- **THEN** the adapter SHALL forward the request under that one child's bearer
- **AND** the persisted subscription SHALL belong to that child's `grant_id`.

#### Scenario: List and lookups stay package-narrowed

- **WHEN** a package token calls `list_event_subscriptions`
- **THEN** the adapter SHALL fan out across each active child grant under that child's bearer
- **AND** SHALL merge the rows into one envelope with source identity attached
- **AND** SHALL NOT return subscriptions whose `grant_id` is not an active member of the package.

#### Scenario: Get / update / delete / send_test_event locate the owning child

- **WHEN** a package token calls `get_event_subscription`, `update_event_subscription`, `delete_event_subscription`, or `send_test_event` with a `subscription_id`
- **THEN** the adapter SHALL probe each active child's `/v1/event-subscriptions/:id` under that child's bearer
- **AND** SHALL forward the call only under the child whose probe returned 200
- **AND** SHALL return a typed `not_found` (404) when no active member owns the subscription.

### Requirement: Hosted MCP refresh tokens SHALL support package-bound access

The reference OAuth token endpoint SHALL support refresh-token exchange for hosted MCP package-bound access without exposing child-grant bearer tokens to the client.

#### Scenario: Client refreshes package access

- **WHEN** a hosted MCP client exchanges a valid package refresh token
- **THEN** the authorization server SHALL issue a new package-bound access token for the same package
- **AND** SHALL NOT return child-grant tokens.

#### Scenario: Package is revoked before refresh

- **WHEN** a hosted MCP client exchanges a refresh token for a revoked package
- **THEN** the authorization server SHALL reject the exchange.

### Requirement: The reference implementation SHALL expose owner-session-gated `_ref/grant-packages*` endpoints

The reference implementation SHALL mount owner-session-gated routes that let the operator console list grant packages, fetch one package detail, and revoke a package. The endpoints SHALL be read-mostly and SHALL NOT support package creation or membership editing — packages remain a hosted-MCP authorization-flow artifact.

#### Scenario: Owner lists grant packages

- **WHEN** an owner-authenticated request hits the package list endpoint
- **THEN** the response SHALL be a paginated envelope ordered by created-at descending
- **AND** each row SHALL include the package id, subject, client, status, member count, created and revoked timestamps.

#### Scenario: Owner fetches a package detail

- **WHEN** an owner-authenticated request hits the package detail endpoint for an existing package id
- **THEN** the response SHALL include the package metadata, every member child grant with its source and current status, and the bound subject and client identifiers
- **AND** the response SHALL NOT include token hashes, refresh secrets, or any other secret material.

#### Scenario: Owner fetches a missing package

- **WHEN** an owner-authenticated request hits the package detail endpoint with an unknown id
- **THEN** the reference implementation SHALL return a typed `not_found` error envelope with HTTP 404.

#### Scenario: Owner revokes an active package

- **WHEN** an owner-authenticated request hits the package revoke endpoint for an active package
- **THEN** every active package membership SHALL be revoked
- **AND** the package row SHALL flip to `revoked`
- **AND** the package's MCP refresh-token exchange SHALL be rejected on the next attempt.

#### Scenario: Owner revokes an already-revoked package

- **WHEN** an owner-authenticated request hits the package revoke endpoint for a package that is not in `active` status
- **THEN** the reference implementation SHALL return a typed `already_revoked` error envelope with HTTP 409 and SHALL NOT alter child-grant statuses.

#### Scenario: Unauthenticated request hits a package endpoint

- **WHEN** a request without an owner session hits any `/_ref/grant-packages*` route
- **THEN** the reference implementation SHALL reject the request with the same owner-session-required envelope used by other `/_ref/*` routes.

### Requirement: The operator console SHALL mount package list, package detail, and child-grant pivot surfaces

The operator console SHALL surface grant packages as routable pages under the existing `/dashboard/grants/*` subtree, mirroring the `ListWithPeekView` shape used by `/dashboard/grants` so the operator does not have to learn a new layout.

#### Scenario: Operator opens the package list page

- **WHEN** the operator opens `/dashboard/grants/packages`
- **THEN** the page SHALL render the list returned by the package list endpoint
- **AND** every row SHALL link to the package detail route.

#### Scenario: Operator opens a package detail page

- **WHEN** the operator opens `/dashboard/grants/packages/<id>`
- **THEN** the page SHALL render the detail returned by the package detail endpoint
- **AND** the page SHALL render a server-rendered revoke form that requires an explicit `confirm_revoke=yes` field and the existing owner session.

#### Scenario: Operator opens a child grant page

- **WHEN** the operator opens `/dashboard/grants/<grantId>` for a grant whose grant id is present in `grant_package_members`
- **THEN** the page SHALL render a pivot link to the package detail page.

### Requirement: The `_ref/grants` spine envelope SHALL carry `grant_package_id`

The `executeRefSpineCorrelationsList` operation (kind=`grant`) SHALL include `grant_package_id` on every row whose grant id is a member of a grant package. The field SHALL be omitted otherwise. Existing consumers SHALL continue to function because they ignore unknown fields by contract.

#### Scenario: Owner lists grants and one row is package-bound

- **WHEN** the spine correlations list operation runs for grants
- **AND** at least one returned grant id is present in `grant_package_members`
- **THEN** the envelope SHALL surface `grant_package_id` for that row
- **AND** the envelope SHALL omit `grant_package_id` for rows whose grant id is not a package member.

### Requirement: Reference dashboard Explore route SHALL host the time-range lens

The reference dashboard SHALL accept `since` and `until` query parameters on `/dashboard/explore` and render the cross-stream time-anchored feed for that window using existing manifest metadata and per-connection record reads, without introducing any new RS or `_ref` endpoint.

#### Scenario: Explore renders the time-anchored feed when a time window is specified

- **WHEN** an authenticated operator visits `/dashboard/explore` with a `since` and/or `until` query parameter and no `q`
- **THEN** the dashboard SHALL load the time-anchored cross-stream feed by querying each visible connection instance's time-anchored streams with that connection's `connector_instance_id`
- **AND** the rendered feed SHALL interleave records from every stream that declares a `consent_time_field`, sorted by that field's value descending
- **AND** each rendered row SHALL preserve the concrete connection identity used for the read
- **AND** the lens label on the Explore canvas SHALL identify the active lens as the time-range view
- **AND** the page SHALL NOT call any RS or `_ref` endpoint that was not already used by the previous Timeline page or by Explore's existing recency and search lenses

#### Scenario: Explore preserves chip state inside the time-range lens

- **WHEN** an operator has one or more connection or stream chips selected and applies a `since`/`until` window
- **THEN** the time-anchored fan-out SHALL only query selected connection instances and selected streams (when chips are present)
- **AND** the chip URLs SHALL preserve the active `since` and `until` parameters so toggling a chip does not silently drop the window

#### Scenario: Query and time-range do not compose silently

- **WHEN** an operator submits a non-empty `q` while `since` or `until` is present
- **THEN** the dashboard SHALL render the existing record search feed (lexical or hybrid) without applying the time window to the search request
- **AND** the lens label SHALL state explicitly that the time window is not applied to search, so the operator is not misled into believing the result is filtered by both lenses
- **AND** the URL SHALL retain `since`, `until`, and `q` so the operator can clear `q` to fall back to the time-range lens without re-entering dates

### Requirement: Reference dashboard SHALL redirect the legacy Timeline route to Explore

The reference dashboard SHALL redirect `/dashboard/records/timeline` to `/dashboard/explore` with the `since` and `until` query parameters preserved, and SHALL NOT keep the Timeline subpage as a separately-reachable view.

#### Scenario: Legacy Timeline deep links land on Explore

- **WHEN** an operator or external link navigates to `/dashboard/records/timeline` with any combination of `since` and `until`
- **THEN** the dashboard SHALL redirect to `/dashboard/explore` with the same query string
- **AND** the redirect SHALL NOT be permanent so a later IA tranche can retire the records-subtree URL prefix cleanly
- **AND** the rendered Explore page at the redirect destination SHALL behave identically to the previous `/dashboard/records/timeline` for the same `since` / `until` parameters

#### Scenario: The Records subnav no longer surfaces a separate Timeline entry

- **WHEN** an operator is viewing any `/dashboard/records/**` page and the Records subnav is shown
- **THEN** the subnav SHALL NOT contain a `Timeline` link
- **AND** the time-range lens SHALL be reachable only via the top-level `Explore` entry, by typing the `since`/`until` URL directly, or by following the redirect from a stale Timeline link

### Requirement: Reference dashboard Records subnav SHALL use Connections vocabulary

The reference dashboard SHALL relabel the Records subnav header to `Connections` so the operator-visible vocabulary aligns with the canonical noun, without altering the underlying `/dashboard/records/*` URL prefix.

#### Scenario: The Records subnav header reads Connections

- **WHEN** an operator views any `/dashboard/records/**` page
- **THEN** the subnav's header text SHALL be `Connections`, not `Records`
- **AND** the subnav SHALL continue to contain a `Connectors` entry that links to `/dashboard/records` and an `Explorer` entry that links to `/dashboard/explore`

#### Scenario: The Records URL subtree is not renamed in this tranche

- **WHEN** an operator visits the records-index page or any per-connection drilldown
- **THEN** the URL SHALL remain rooted at `/dashboard/records` in this tranche
- **AND** the rename of the Records subtree to `/dashboard/connections` (and the corresponding nav relabel) SHALL be scoped to a subsequent OpenSpec change, not this one

### Requirement: Reference dashboard exposes a records explorer surface

The reference dashboard SHALL expose an owner-only records-explorer surface at `/dashboard/explore` (with the legacy `/dashboard/records/explorer` URL preserved by redirect) that browses owner-visible records through existing public PDPP and existing `_ref` read endpoints, without introducing new RS or `_ref` endpoints. The explorer SHALL render type-aware record cards dispatched from declared field types when present, falling back to a presentation-only heuristic otherwise, and SHALL present Search, Explore, and Timeline as one coherent owner mental model. The explorer SHALL NOT claim any backend behavior that the public read contract or the active token does not support.

#### Scenario: The explorer reads through the existing RS contract
- **WHEN** the records explorer renders results
- **THEN** it SHALL read only through endpoints already exercised by the dashboard: the public `GET /v1/search`, `GET /v1/search/hybrid`, `GET /v1/streams`, `GET /v1/streams/:stream/records`, `GET /v1/streams/:stream/records/:id`, and the existing `_ref/connectors` connection-summary surface
- **AND** it SHALL NOT introduce or require new RS routes, new `_ref` routes, or new owner-token scopes

#### Scenario: The explorer preserves connection identity when known
- **WHEN** the explorer renders facet chips for the visible connections
- **THEN** each chip SHALL key on a concrete `connection_id` and SHALL NOT collapse multiple connections of the same connector type into one chip

#### Scenario: The explorer preserves connection identity on the empty-query feed
- **WHEN** the explorer renders the empty-query recency feed (which derives every row from a known per-connection fan-out)
- **THEN** the row key, the peek URL parameter, the row's full-record link, and the peek-panel record read SHALL all carry the concrete `connection_id` that produced the row
- **AND** two rows from two distinct connections of the same connector type SHALL produce two distinct row keys, peek URLs, and full-record links

#### Scenario: The explorer does not falsely attribute a search hit to a connection
- **WHEN** the explorer renders a search hit and more than one visible connection of the hit's connector type is configured
- **AND** the public search response does not carry a concrete `connection_id` for that hit (which is the current `/v1/search*` contract; the field is additive-optional and a forward-compatible client reads it when present)
- **THEN** the row SHALL NOT attribute the hit to any single connection
- **AND** the row SHALL be rendered as connector-scoped, with no concrete connection display name
- **AND** the row's full-record link SHALL fall back to the connector-scope route rather than guessing a connection
- **AND** the feed's surrounding caption SHALL state that public search results do not yet carry connection identity, so search rows are connector-scoped when multiple connections of that type exist

#### Scenario: The explorer deduces a single visible connection when unambiguous
- **WHEN** the explorer renders a search hit and exactly one visible connection of the hit's connector type is configured
- **THEN** the row MAY attribute the hit to that connection (this is deduction from visibility, not a first-match guess)
- **AND** the row's full-record link SHALL include the concrete `connection_id`

#### Scenario: Selected-connection chips are honest about their search-mode scope
- **WHEN** the owner has selected one or more connection chips AND a query is active
- **AND** the public search response cannot enforce a `connection_id` request filter (the current `/v1/search*` contract)
- **THEN** the resulting feed MAY narrow by the connector types of the selected connections
- **AND** the selected-connection summary SHALL label that constraint as connector-scoped (e.g. "connector (from connection)") rather than claiming a connection filter the request cannot enforce
- **AND** the explorer SHALL NOT pick an arbitrary one of the selected connections to attribute hits to

#### Scenario: Selected-connection chips tighten when hits carry concrete identity
- **WHEN** the owner has selected one or more connection chips AND a query is active
- **AND** a search hit carries a concrete `connection_id` (or its deprecated `connector_instance_id` alias) in the response (forward-compatible with `expose-connection-identity-on-public-read`)
- **THEN** the explorer SHALL drop the hit unless that concrete connection identity matches one of the selected visible connections
- **AND** hits in the same response that do not carry concrete identity SHALL continue to fall through to the connector-scoped post-filter rather than being dropped

#### Scenario: Record reads carry the resolved connection scope
- **WHEN** the explorer issues a record read for the peek panel
- **THEN** the read SHALL include the `connector_id` and, when a concrete `connection_id` (or its deprecated `connector_instance_id` alias) is known for the row, the matching `connector_instance_id` scope used to derive the displayed value
- **AND** the displayed URL SHALL match the URL the typed RS client actually issues

#### Scenario: The explorer is honest about the read URL
- **WHEN** the explorer's peek panel renders a selected record
- **THEN** it SHALL display the exact `GET /v1/streams/<stream>/records/<id>` URL — including any `connector_id` and `connector_instance_id` query parameters — that the dashboard used to read that record
- **AND** the displayed URL SHALL match the URL the typed RS client actually issues

#### Scenario: The explorer degrades gracefully when no query is set
- **WHEN** the explorer renders without a query
- **THEN** it SHALL render a recency-sorted feed sourced from a bounded fan-out over owner-visible connections rather than from a new RS endpoint
- **AND** the fan-out SHALL be bounded by a fixed cap on (connections, streams per connection, records per stream) so the empty-query load remains cheap

#### Scenario: The explorer is the sole owner-token record search surface
- **WHEN** an owner wants to find records by free-text content
- **THEN** the dashboard SHALL surface that query on `/dashboard/explore` only
- **AND** `/dashboard/search` SHALL NOT render an owner-token record-content search section
- **AND** the explorer's search lens SHALL remain reachable via `/dashboard/explore?q=<query>` and via the redirect from `/dashboard/search?q=<query>` (without `jump=0`)

#### Scenario: The explorer does not invent grant or projection chrome the owner token does not have
- **WHEN** the explorer renders under an owner token
- **THEN** it SHALL NOT surface a client-grant chip, field-projection toggle, or any UI element that implies the records are being read under a third-party grant
- **AND** any such affordances SHALL be reserved for a future data-owner-facing surface that holds a real client-scoped grant

#### Scenario: Partial fan-in failures are surfaced, not silently swallowed
- **WHEN** the empty-query recency feed's bounded per-stream fan-out has one or more stream reads fail
- **THEN** the surviving rows SHALL still render
- **AND** the page SHALL surface each failure as a structured warning naming the connection display name and stream
- **AND** the warning surface SHALL state that the rendered rows are partial

#### Scenario: Capability downgrades are surfaced honestly
- **WHEN** the resource server advertises `capabilities.hybrid_retrieval.supported: true` but a hybrid search call fails
- **THEN** the explorer SHALL fall back to lexical retrieval so the owner still gets results
- **AND** the page SHALL surface a structured warning naming the downgrade and the underlying error
- **AND** the warning SHALL NOT be silently swallowed

#### Scenario: Record cards dispatch from declared field types when present
- **WHEN** the explorer renders a row whose record body is in hand (the recency or time-range lens) AND the stream's `field_capabilities` carry a declared presentation `type` for the row's fields
- **THEN** the card SHALL dispatch its layout from the declared `type` (for example a `currency` field renders a money card, a `person` field renders an author, a `timestamp` field renders an event time)
- **AND** the card SHALL NOT invent a field shape the declared `type` does not assert

#### Scenario: Record cards fall back to the heuristic when types are absent
- **WHEN** the explorer renders a row whose stream exposes no declared presentation `type` (a connector that has not yet declared a typed schema) OR whose record body is not in hand (a search hit that carries only a snippet)
- **THEN** the card SHALL fall back to the presentation-only `record-kind` heuristic and the one-line summary
- **AND** the fallback SHALL NOT be presented as a declared type, and SHALL degrade to a generic card rather than guessing a precise shape

#### Scenario: Field projection is represented honestly under the active token
- **WHEN** the explorer renders fields for a stream whose `field_capabilities` mark one or more fields as not usable under the active token's grant projection
- **THEN** the explorer SHALL represent the projected-out fields honestly (for example as withheld) rather than silently omitting them as though they did not exist
- **AND** the explorer SHALL NOT thereby imply a client-scoped grant on the owner-token surface

#### Scenario: Blob-backed records show grant-aware preview affordances
- **WHEN** the explorer renders a record whose stream declares a `blob` field type AND the record carries a `blob_ref`
- **THEN** the card MAY show a preview or download affordance that reads only through the existing blob read path
- **AND** the affordance SHALL respect the active token's grant: a blob outside the token's projection SHALL be represented as unavailable rather than fetched
- **AND** the explorer SHALL NOT introduce a new RS or `_ref` blob route to render the affordance

#### Scenario: Corpus and activity summaries are bounded and honest
- **WHEN** the explorer renders a corpus or activity summary (for example "spans N years" or an activity strip)
- **THEN** it SHALL source the summary from declared aggregate metadata (`meta.window`) when the read provides it
- **AND** when no aggregate metadata is available, the explorer SHALL either omit the summary or label it as derived from the bounded recency sample rather than claiming a full-corpus figure
- **AND** the explorer SHALL NOT compute a full-corpus summary by an unbounded per-stream fan-out scan

#### Scenario: Search, Explore, and Timeline form one coherent model
- **WHEN** an operator navigates between record browsing, free-text query, time-window browsing, and spine artifact lookup
- **THEN** Explore SHALL be the single records canvas hosting the recency, time-window, and query lenses
- **AND** Timeline SHALL be reachable as an Explore lens (a time window), not as a competing top-level records surface
- **AND** `/dashboard/search` SHALL be reserved for spine artifact jumps (trace, grant, run by id) and SHALL route free-text record queries to Explore
- **AND** the navigation labels SHALL NOT present two surfaces that do the same job under different names

### Requirement: Reference dashboard exposes Explore as a top-level operator-console route

The reference dashboard SHALL expose the records explorer as a top-level operator-console route at `/dashboard/explore`, rendering the same query-driven records canvas previously mounted at `/dashboard/records/explorer` with no change to the underlying RS or `_ref` reads.

#### Scenario: The top-level Explore route renders the records explorer

- **WHEN** an authenticated operator visits `/dashboard/explore`
- **THEN** the dashboard SHALL render the records explorer view
- **AND** the page SHALL read only through endpoints already used by `/dashboard/records/explorer` (the public `GET /v1/search`, `GET /v1/search/hybrid`, `GET /v1/streams`, `GET /v1/streams/:stream/records`, `GET /v1/streams/:stream/records/:id`, and the existing `_ref/connectors` connection-summary surface)
- **AND** the page SHALL NOT introduce or require new RS routes, new `_ref` routes, or new owner-token scopes

#### Scenario: The Explore route is reachable from top-level navigation

- **WHEN** an authenticated operator views any `/dashboard/**` page
- **THEN** the top-level navigation SHALL contain an `Explore` entry whose `href` resolves to `/dashboard/explore`
- **AND** the `Explore` entry SHALL be co-equal with the other top-level navigation entries (such as `Search`, `Traces`, `Grants`, and `Runs`), not nested under a `Records` subnav

#### Scenario: The old explorer path redirects to the top-level route while query parameters are preserved

- **WHEN** an operator or external link navigates to `/dashboard/records/explorer` with any combination of query parameters
- **THEN** the dashboard SHALL redirect to `/dashboard/explore` with the same query string
- **AND** the redirect SHALL NOT be permanent so the legacy path can be retired cleanly in a later IA tranche
- **AND** the rendered records explorer at the redirect destination SHALL behave identically to the previous `/dashboard/records/explorer` for the same query parameters

#### Scenario: The Records subnav continues to surface an Explorer entry during the transition

- **WHEN** an operator is viewing any `/dashboard/records/**` page and the Records subnav is shown
- **THEN** the subnav SHALL still expose an `Explorer` link
- **AND** that subnav link's `href` SHALL resolve to `/dashboard/explore`, the same destination as the top-level navigation entry

#### Scenario: Explore preserves the existing explorer's connection-identity and honesty guarantees

- **WHEN** the top-level Explore route renders results
- **THEN** it SHALL satisfy every connection-identity, partial-fan-in, capability-downgrade, peek-URL, and grant-projection scenario already established for the records explorer in this capability
- **AND** the surface SHALL NOT introduce any UI affordance that implies a backend behavior the RS or `_ref` contract does not support

#### Scenario: Explore does not absorb spine artifact jumps in this tranche

- **WHEN** an operator needs to jump to a trace, grant, or run by id
- **THEN** that flow SHALL remain at `/dashboard/search`
- **AND** the top-level Explore route SHALL be records-only in this tranche, with spine artifact search reserved for `/dashboard/search` until a subsequent change relocates it

#### Scenario: Explore does not absorb the timeline view in this tranche

- **WHEN** an operator needs to browse records by an explicit time-range window
- **THEN** that flow SHALL remain at `/dashboard/records/timeline`
- **AND** the top-level Explore route SHALL retain only the existing query + recency lenses in this tranche, with the time-range lens reserved for a subsequent change that absorbs the timeline view into Explore

#### Scenario: The Records subtree rename is deferred to a separate change

- **WHEN** an operator visits the records-index page or any per-connection drilldown
- **THEN** the URL SHALL remain rooted at `/dashboard/records` in this tranche
- **AND** the rename of the Records subtree to `/dashboard/connections` (and the corresponding nav relabel) SHALL be scoped to a subsequent OpenSpec change, not this one

### Requirement: The MCP adapter SHALL expose client event subscription management tools

The reference MCP adapter (`packages/mcp-server`) SHALL register tools that forward the client-facing `/v1/event-subscriptions[...]` REST surface verbatim. Each tool SHALL use the same scoped client bearer the adapter already caches via `pdpp connect`. The adapter SHALL NOT introduce a new authorization mode and SHALL NOT accept owner credentials for these tools — the existing owner-credential refusal in `packages/mcp-server/src/index.js` SHALL still gate startup.

Each subscription tool SHALL forward to exactly one REST endpoint, MUST NOT silently drop or rename a forwarded field, and SHALL surface the RS response (or typed error envelope) under the standard `structuredContent` shape the existing read tools use.

#### Scenario: An MCP client lists the registered tools

- **WHEN** an MCP client connected to the adapter calls `tools/list`
- **THEN** the response SHALL include `create_event_subscription`, `list_event_subscriptions`, `get_event_subscription`, `update_event_subscription`, `delete_event_subscription`, and `send_test_event` in addition to the existing read tools

#### Scenario: A client creates a subscription through MCP

- **WHEN** an MCP client calls `create_event_subscription` with an HTTPS `callback_url`
- **THEN** the adapter SHALL issue `POST /v1/event-subscriptions` to the configured provider with `Authorization: Bearer <scoped-client-token>` and a JSON body containing `callback_url` (and `filters` when supplied)
- **AND** the tool result's `structuredContent.data` SHALL include the RS response body verbatim, including the `whsec_`-prefixed delivery secret returned exactly once

#### Scenario: A client deletes a subscription through MCP

- **WHEN** an MCP client calls `delete_event_subscription` with a `subscription_id`
- **THEN** the adapter SHALL issue `DELETE /v1/event-subscriptions/<id>` with the scoped bearer attached
- **AND** the tool SHALL surface `status: 204` in the structured content without echoing a synthetic body

#### Scenario: The RS rejects a non-HTTPS callback URL

- **WHEN** an MCP client calls `create_event_subscription` with a `callback_url` the RS rejects with a typed `invalid_request` envelope
- **THEN** the tool result SHALL set `isError: true`
- **AND** the structured content SHALL preserve the RS error envelope's `type`, `code`, and `message` rather than masking them

#### Scenario: An owner credential is present in the environment

- **WHEN** the adapter is started with `PDPP_OWNER_TOKEN` or `PDPP_OWNER_SESSION_COOKIE` in the environment
- **THEN** the adapter SHALL refuse to start with the existing exit code, regardless of which tools (read or write) are registered

### Requirement: Subscription tools SHALL annotate their side effects honestly

Each subscription tool SHALL set MCP tool annotations that reflect the underlying REST endpoint's side effect. Read-only tools (`list_event_subscriptions`, `get_event_subscription`) SHALL advertise `readOnlyHint: true` and `idempotentHint: true`. Write tools SHALL advertise `readOnlyHint: false`. `delete_event_subscription` SHALL advertise `destructiveHint: true`. `update_event_subscription` and `send_test_event` SHALL advertise `idempotentHint: false` because they affect server state on each call (secret rotation mints a new secret; test-event enqueue mints a new event id).

All subscription tools SHALL advertise `openWorldHint: false` because their side effects are bounded to the configured PDPP resource server.

#### Scenario: A client harness inspects tool annotations

- **WHEN** an MCP client reads the `annotations` block for `delete_event_subscription`
- **THEN** the annotations SHALL include `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, and `openWorldHint: false`

#### Scenario: A client harness inspects update tool annotations

- **WHEN** an MCP client reads the `annotations` block for `update_event_subscription` or `send_test_event`
- **THEN** the annotations SHALL include `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, and `openWorldHint: false`

### Requirement: The MCP adapter SHALL expose an event-subscription discovery tool

The adapter SHALL register a read-only `discover_event_subscription_capabilities` tool that fetches the resource server's protected-resource metadata at `/.well-known/oauth-protected-resource` and surfaces `capabilities.client_event_subscriptions`. The tool SHALL set `readOnlyHint: true`, `idempotentHint: true`, and `openWorldHint: false`. The endpoint is unauthenticated per RFC 9728; the adapter MAY include the configured bearer in the request but SHALL NOT require authentication for this discovery tool to succeed.

The tool's `structuredContent` SHALL include `supported` (boolean derived from `capability.supported === true`), `capability` (the advertised block verbatim, or `null` when absent), `data` (the full protected-resource metadata body), and the standard `provider_url`, `request_id`, and `http_status` fields.

When the advertisement omits `capabilities.client_event_subscriptions`, the tool SHALL surface `supported: false` and `capability: null` and SHALL NOT set `isError`. RS errors (e.g. untrusted-host envelopes) SHALL propagate as `isError: true` with the typed envelope preserved.

#### Scenario: A client discovers supported event types before subscribing

- **WHEN** an MCP client calls `discover_event_subscription_capabilities` against a reference instance that advertises `client_event_subscriptions`
- **THEN** the adapter SHALL issue `GET /.well-known/oauth-protected-resource` to the configured provider
- **AND** `structuredContent.supported` SHALL be `true`
- **AND** `structuredContent.capability` SHALL contain the `endpoint`, `event_types`, `signing`, `envelope`, and `retry` fields advertised by the RS

#### Scenario: A deployment does not advertise event subscriptions

- **WHEN** the protected-resource metadata omits `capabilities.client_event_subscriptions`
- **THEN** the tool SHALL return `structuredContent.supported: false` and `structuredContent.capability: null`
- **AND** the tool result SHALL NOT set `isError`
- **AND** the prose `content[0].text` SHALL guide the caller toward `query_records` with `changes_since` as the polling alternative

### Requirement: Subscription tool descriptions SHALL explain when to use events versus polling

Every write tool description (`create_event_subscription`, `update_event_subscription`, `send_test_event`) and every read tool description that touches the subscription substrate SHALL state when event subscriptions are appropriate (long-lived receiver, low-latency change notification) and when polling via `query_records` with `changes_since` is the better choice (one-shot reads, short-lived clients, environments without a reachable HTTPS callback). Descriptions SHALL also reference `discover_event_subscription_capabilities` as the authoritative source for supported event types, signing profile, and retry schedule.

#### Scenario: An LLM agent reads a write-tool description

- **WHEN** an MCP client inspects the description of `create_event_subscription`, `update_event_subscription`, or `send_test_event`
- **THEN** the description SHALL mention both event subscriptions and the polling alternative
- **AND** the description SHALL name `discover_event_subscription_capabilities` (directly or via the protected-resource metadata path) as the way to learn supported event types and wire shape

### Requirement: MCP Adapter Remains Outside the Reference Control Plane
The reference implementation SHALL package the MCP adapter as a client-side adapter over the existing PDPP resource-server API, not as a new reference-server control plane or collection runtime. The adapter package SHALL NOT import from `reference-implementation/` server internals and SHALL NOT require a PDPP monorepo checkout to run after publication.

#### Scenario: Package boundary is inspected
- **WHEN** maintainers inspect the MCP adapter package imports and package metadata
- **THEN** the package SHALL depend only on published/workspace packages and public PDPP HTTP surfaces, and SHALL NOT import reference server modules or connector runtime internals

#### Scenario: Reference server behavior is compared before and after adapter installation
- **WHEN** the MCP adapter package is added to the workspace
- **THEN** existing AS, RS, grant, connector, scheduler, and collection-profile routes SHALL remain wire-compatible because the adapter consumes those routes instead of modifying them

### Requirement: Authorization Server Supports Public OAuth Code With PKCE For Hosted MCP
The reference authorization server SHALL support OAuth `authorization_code` with PKCE S256 for public hosted MCP clients. The flow SHALL bridge to existing PDPP pending-consent approval and SHALL issue the same kind of grant-scoped client bearer tokens already enforced by the resource server.

#### Scenario: Public client registers for authorization code
- **WHEN** dynamic client registration receives public-client metadata with `grant_types: ["authorization_code", "refresh_token"]`, `response_types: ["code"]`, redirect URIs, and `token_endpoint_auth_method: "none"`
- **THEN** the reference AS SHALL register the client if all metadata is valid

#### Scenario: Client starts authorization
- **WHEN** a registered public client calls `/oauth/authorize` with `response_type=code`, an exact registered `redirect_uri`, `code_challenge_method=S256`, and a code challenge
- **THEN** the AS SHALL stage or bind a PDPP pending-consent request and present the owner consent flow

#### Scenario: Owner approves hosted MCP consent
- **WHEN** the owner approves a pending authorization-code consent request
- **THEN** the AS SHALL issue a PDPP grant and client token, mint a short-lived single-use authorization code bound to client, redirect URI, and PKCE challenge, and redirect the browser with `code` and optional `state`

#### Scenario: Client exchanges code
- **WHEN** the client posts `/oauth/token` with `grant_type=authorization_code`, the authorization code, matching client id, matching redirect URI, and a valid PKCE verifier
- **THEN** the AS SHALL return the scoped client bearer token, return `expires_in` as a positive integer lifetime hint, return an opaque grant-scoped refresh token when the registered client requested `refresh_token`, and mark the code consumed

#### Scenario: Client refreshes hosted MCP access
- **WHEN** the client posts `/oauth/token` with `grant_type=refresh_token`, the opaque refresh token, and the matching public client id
- **THEN** the AS SHALL issue a new scoped client bearer for the same PDPP grant without widening source, stream, subject, purpose, retention, or storage-binding scope
- **AND** the token response SHALL include `expires_in` as a positive integer lifetime hint

#### Scenario: Refresh token no longer matches an active grant
- **WHEN** the client posts `/oauth/token` with an unknown refresh token, a mismatched client id, or a token tied to a revoked or invalid grant
- **THEN** the AS SHALL reject the exchange and SHALL NOT issue a new bearer

#### Scenario: Code is reused or verifier is wrong
- **WHEN** a client reuses an authorization code or supplies the wrong PKCE verifier
- **THEN** the AS SHALL reject the exchange and SHALL NOT issue a token

### Requirement: Authorization Metadata Advertises Hosted MCP OAuth Capabilities
The authorization server metadata SHALL truthfully advertise OAuth code-flow support needed by hosted MCP clients.

#### Scenario: Client discovers authorization server metadata
- **WHEN** a client fetches `/.well-known/oauth-authorization-server`
- **THEN** the response SHALL include `authorization_endpoint`, `authorization_code` and `refresh_token` in `grant_types_supported`, `code` in `response_types_supported`, and `S256` in `code_challenge_methods_supported`

### Requirement: Hosted MCP OAuth Does Not Leak Bearers
The hosted MCP OAuth approval path SHALL NOT place access tokens in browser-rendered HTML, redirect URLs, logs intended for users, or consent exchange codes.

#### Scenario: Approval redirects to client
- **WHEN** owner approval completes for an authorization-code request
- **THEN** the browser redirect SHALL include only the authorization code and optional state, and SHALL NOT include the access token, refresh token, or grant JSON

#### Scenario: Token endpoint returns bearer
- **WHEN** the registered client exchanges the authorization code successfully
- **THEN** the bearer SHALL be returned only from `/oauth/token` in the JSON response body

### Requirement: Operator console centers configured connections
The reference implementation SHALL treat a configured connection as the primary owner-facing operator-console unit. Connector type, runtime, device, run, schedule, remote surface, and grant identifiers SHALL remain distinct supporting concepts rather than replacing the configured connection as the source row.

#### Scenario: Owner has two accounts for one connector type
- **WHEN** the owner configures two accounts that use the same connector id
- **THEN** the operator console SHALL represent them as separate configured connections
- **AND** each connection SHALL have independent health, coverage, schedules, runs, state, gaps, and attention status

#### Scenario: A connection uses a local device runtime
- **WHEN** a configured connection is collected by a local device or collector runtime
- **THEN** the operator console SHALL present the configured connection as the owner-facing source
- **AND** it SHALL expose the device/runtime health as supporting diagnostic evidence rather than as the source identity itself

### Requirement: Connection health is projected from durable evidence
The reference implementation SHALL compute connection health from durable evidence including run outcomes, committed checkpoints, coverage, gaps, backlog, schedules, active work, runtime health, attention requests, and projection freshness. It SHALL NOT treat the last run terminal status alone as the connection health.

#### Scenario: Last run succeeded with required gaps
- **WHEN** the latest run for a connection succeeds but required requested coverage remains gap-bearing, deferred, stale, or incomplete
- **THEN** the connection health SHALL NOT be reported as healthy
- **AND** the operator console SHALL expose the useful collected data and the remaining coverage condition

#### Scenario: Last run failed after previous useful data
- **WHEN** a connection has prior committed data and a later run fails with a retryable or cooling-off condition
- **THEN** the connection health SHALL distinguish the available prior data from the current retry/cooldown condition
- **AND** it SHALL NOT collapse the connection into an opaque failed state without coverage context

#### Scenario: Server restarts
- **WHEN** the reference server restarts
- **THEN** the operator console SHALL reconstruct connection health from durable evidence
- **AND** it SHALL NOT require in-memory run state to explain pending, retrying, blocked, degraded, or healthy connection states

### Requirement: Connection health states are canonical and evidence-backed
The reference implementation SHALL use a canonical connection health projection that can represent healthy, degraded, needs attention, cooling off, blocked, idle, and unknown states. The projection SHALL be deterministic and SHALL preserve detailed evidence for owner inspection. Activity, freshness, coverage, and outbox/work status SHALL be represented as axes or badges rather than as additional headline health states.

#### Scenario: Required owner action is pending
- **WHEN** a connection has a current required owner attention request that has not expired
- **THEN** the connection SHALL project to a needs-attention state unless a higher-priority fatal blocked condition applies
- **AND** the operator console SHALL show the action target and expiry

#### Scenario: Retry policy is intentionally delaying work
- **WHEN** a connection has retryable failure evidence and schedule/backoff policy is intentionally delaying the next attempt
- **THEN** the connection SHALL project to cooling-off unless a higher-priority blocked or needs-attention condition applies
- **AND** the operator console SHALL show the next eligible attempt when known

#### Scenario: Active work is running
- **WHEN** a run or durable work item is active for a connection
- **THEN** the operator console SHALL expose activity or syncing as a badge or axis
- **AND** it SHALL NOT replace the headline health state with a separate syncing state

#### Scenario: Freshness policy is violated
- **WHEN** a connection has otherwise clean run evidence but the last successful durable progress is older than the configured freshness policy
- **THEN** the operator console SHALL expose stale freshness as an axis or badge
- **AND** it SHALL NOT require a separate stale headline health state

#### Scenario: Projection evidence is unreliable
- **WHEN** required evidence for the connection health projection is missing, stale beyond policy, or failed
- **THEN** the connection SHALL project to unknown
- **AND** the operator console SHALL name which evidence source made the projection unreliable

#### Scenario: Required coverage is current and complete
- **WHEN** a connection has current committed checkpoints, required coverage is complete or explicitly accepted as unavailable, no required backlog or gaps remain, no required attention is active, and projection evidence is fresh enough
- **THEN** the connection MAY project to healthy

### Requirement: Connection coverage is first-class
The reference implementation SHALL preserve coverage by connection and stream or scope boundary where practical. Coverage SHALL distinguish complete, partial, stale, deferred, unsupported, unavailable, retryable gap, terminal gap, inventory-only, and unknown conditions as structured evidence rather than only timeline text.

#### Scenario: A stream is unsupported by implementation
- **WHEN** a requested or manifest-visible stream is not collected because the connector implementation does not support it
- **THEN** the operator console SHALL expose that stream as unsupported or unavailable coverage
- **AND** it SHALL NOT report the connection as fully healthy for that stream unless the policy explicitly accepts that unavailability

#### Scenario: A detail gap is recorded
- **WHEN** a connector records a durable detail gap or backlog item for a connection
- **THEN** the connection coverage SHALL include that gap with retryability and stream or boundary identity
- **AND** future runs or operator diagnostics SHALL be able to target that gap without relying only on prose from the original run timeline

### Requirement: Long-running executors are bounded and durable
The reference implementation SHALL ensure long-running executor paths use bounded memory, bounded concurrency, durable retryable work, active-run or lease fencing, cancellation where practical, resource policy, and restart reconstruction. Executor paths include local collectors, browser/API connector runs, scheduler-dispatched runs, read-model rebuilds, and remote browser surface allocation.

#### Scenario: A local collector emits a large first backfill
- **WHEN** a local collector emits more records than fit comfortably in one in-memory batch
- **THEN** the runner SHALL stream or batch work into durable bounded units
- **AND** it SHALL NOT require holding the full child connector output in memory before upload begins

#### Scenario: Retryable work is prepared before a crash
- **WHEN** retryable work is prepared and the process crashes before destination acknowledgement
- **THEN** a later execution SHALL recover or explain that work from durable evidence
- **AND** it SHALL NOT silently discard the work or advance committed progress beyond acknowledged effects

#### Scenario: Heavy work exceeds policy
- **WHEN** an executor reaches configured CPU, memory, disk, network, duration, concurrency, or backlog policy limits
- **THEN** the reference implementation SHALL pause, defer, cancel, or mark backlog honestly
- **AND** it SHALL NOT continue unbounded work that can destabilize the host

### Requirement: Checkpoints are destination-confirmed for retryable work
The reference implementation SHALL commit connection progress only when the records, gaps, blobs, and other effects that justify that progress have been durably accepted by the destination or represented as durable accepted gaps. Source-observed cursors and connector-emitted state SHALL be staged progress until that condition holds.

#### Scenario: Records are queued but not acknowledged
- **WHEN** records for a connection are queued or emitted but not yet acknowledged by the reference server
- **THEN** the committed checkpoint for the related boundary SHALL NOT advance past those unacknowledged records

#### Scenario: Required detail cannot be collected but gap is durable
- **WHEN** required detail cannot be collected and the connector records a durable retryable gap that is accepted by reference policy
- **THEN** the reference implementation MAY advance the list-level or boundary checkpoint only according to the accepted gap semantics
- **AND** the operator console SHALL continue to show the outstanding gap until recovered, accepted, or terminal

### Requirement: Owner attention is structured and actionable
The reference implementation SHALL represent required owner action as structured attention evidence. Attention evidence SHALL include attention identity, dedupe key, connection identity, run identity when applicable, kind or reason code, action target, owner-facing copy, timeout or expiry, auto-detection capability, privacy classification, notification policy, lifecycle state, and recovery semantics.

#### Scenario: Connector needs an external approval
- **WHEN** a connector cannot continue until the owner approves a push notification, enters an OTP, completes re-consent, or verifies a source challenge
- **THEN** the reference implementation SHALL create structured attention evidence
- **AND** the operator console SHALL show where the owner should act and what happens if the request expires

#### Scenario: Repeated attention has the same dedupe key
- **WHEN** an equivalent owner-action request is raised repeatedly within the configured cooldown window
- **THEN** the reference implementation SHALL deduplicate or supersede the existing attention evidence rather than spamming duplicate prompts
- **AND** the durable timeline SHALL preserve enough evidence to explain the latest active request

#### Scenario: Attention lifecycle changes
- **WHEN** an attention request is opened, acknowledged, entered in progress, resolved, expired, cancelled, or superseded
- **THEN** the reference implementation SHALL persist that lifecycle transition
- **AND** connection health and notification policy SHALL derive from the current lifecycle state

#### Scenario: Attention is satisfied externally
- **WHEN** an attention request can be auto-detected after the owner acts outside the dashboard
- **THEN** the reference implementation SHALL allow the run or connection to recover without requiring a redundant owner confirmation when safe detection evidence exists

#### Scenario: Secret values are submitted
- **WHEN** an owner submits OTP, credential, or interaction values for a run
- **THEN** the reference implementation SHALL use those values only for the current authorized action
- **AND** it SHALL NOT persist the submitted secret values as durable credentials or expose them in diagnostics

### Requirement: Notifications deliver attention without owning state
The reference implementation SHALL treat PWA/Web Push and similar channels as delivery mechanisms for actionable attention or important health transitions. Notification delivery SHALL NOT be the authoritative source of connection, run, schedule, or coverage state.

#### Scenario: A connection enters needs-attention
- **WHEN** a connection enters a needs-attention state with an actionable target and notification policy allows delivery
- **THEN** the reference implementation MAY send a push notification
- **AND** the dashboard SHALL remain able to render the same attention state from durable evidence if the notification is missed

#### Scenario: A non-actionable retry occurs
- **WHEN** a connector enters a retryable cooling-off state that requires no owner action
- **THEN** the notification policy SHALL avoid repeated noisy prompts unless the transition crosses a configured owner-action threshold

### Requirement: Operator read models are derived and freshness-labeled
The reference implementation MAY use derived read models to make the operator console fast, but those read models SHALL be rebuildable from canonical evidence and SHALL expose freshness, stale, rebuilding, or failed states when relevant.

#### Scenario: A projection is stale
- **WHEN** a dashboard read model is stale, rebuilding, or failed
- **THEN** the operator console SHALL show freshness metadata or an honest fallback
- **AND** it SHALL NOT present stale projection values as fresh canonical truth

#### Scenario: A projection rebuild fails
- **WHEN** a read-model rebuild fails
- **THEN** canonical records, runs, gaps, checkpoints, and other durable evidence SHALL remain intact
- **AND** the operator console SHALL expose sanitized failure metadata

### Requirement: The reliability milestone has acceptance evidence
The reference implementation SHALL NOT claim the broader RI/operator-console reliability milestone is complete until executable or documented acceptance checks prove connection health projection, coverage honesty, executor bounds, restart reconstruction, attention handling, notification policy, projection freshness, and secret-safe diagnostics.

#### Scenario: Milestone closeout is attempted
- **WHEN** the owner attempts to close this milestone
- **THEN** the change SHALL include acceptance evidence for healthy, degraded, needs-attention, cooling-off, blocked, syncing, and unknown connection states
- **AND** it SHALL include evidence for local durable-work recovery, read-model stale/failure behavior, scheduler restart reconstruction, and at least one browser/API connector attention path

#### Scenario: Connector-specific work remains incomplete
- **WHEN** some connector-specific streams, selectors, or live-source fixes remain incomplete
- **THEN** the milestone MAY still close only if those conditions are represented as honest connection coverage or connector-specific follow-up work
- **AND** the operator console SHALL NOT report them as fully healthy without evidence

### Requirement: Agent discovery SHALL advertise an installable CLI flow
The reference resource-server metadata SHALL advertise an executable npm CLI
command for delegated access, and related agent-discovery surfaces SHALL use the
same command.

#### Scenario: A client reads protected-resource metadata
- **WHEN** the client fetches `/.well-known/oauth-protected-resource`
- **THEN** `pdpp_agent_discovery` SHALL include the npm package name, bin name, install/run command, recommended connect command, and no-owner-token policy for delegated access
- **AND** the advertised command SHALL be generated from the configured public CLI package metadata

#### Scenario: A protected API request is missing authentication
- **WHEN** a safe resource-server request receives a bearer-token authentication error
- **THEN** the response SHALL continue to expose protected-resource metadata discovery
- **AND** it SHALL include a concise next step that directs agents to the advertised CLI connect flow before retrying `/v1/**`

#### Scenario: The CLI package name changes
- **WHEN** the configured public CLI package name changes
- **THEN** protected-resource metadata, hosted skills, llms files, web copy, and CLI help SHALL all advertise the same package and command

### Requirement: CLI connect SHALL create scoped client access without owner tokens
The public CLI SHALL provide a single-command connect flow that obtains a scoped
client grant approved by the owner and stores it in a project-local cache.

#### Scenario: An agent runs the connect command
- **WHEN** an agent runs `pdpp connect <provider-url>` or the advertised equivalent
- **THEN** the CLI SHALL discover the resource server and authorization server from the provider URL
- **AND** it SHALL request the narrowest owner-approved client grant needed for routine discovery
- **AND** it SHALL store resulting credentials only in the project-local PDPP cache with secret file permissions
- **AND** it SHALL verify the grant by calling `/v1/schema`

#### Scenario: An agent uses the approved credential
- **WHEN** an agent needs to call an authenticated PDPP endpoint after connecting
- **THEN** the CLI SHALL provide a command that reads the project-local cache and prints only the scoped client access token
- **AND** the command SHALL fail with a bounded actionable error when the provider has not been connected or the cached credential is expired

#### Scenario: The agent lacks a valid grant
- **WHEN** the connect flow requires owner approval
- **THEN** the CLI SHALL open or print an owner-facing approval URL
- **AND** it SHALL complete token receipt without asking the agent to paste or persist an owner bearer token

#### Scenario: The connect command is advertised publicly
- **WHEN** protected-resource metadata, hosted docs, or UI copy advertise the connect command
- **THEN** the reference implementation SHALL have a proven-safe token completion path for scoped client grants
- **AND** that path SHALL avoid exposing owner bearer tokens to the agent

#### Scenario: The current grant is insufficient
- **WHEN** the current cached grant cannot cover the requested data operation
- **THEN** the CLI SHALL stop or request an explicit scoped upgrade
- **AND** it SHALL NOT silently broaden access or ask for an owner token

#### Scenario: The CLI cannot complete routine delegated access
- **WHEN** the CLI cannot discover metadata, register or reuse a client, obtain approval, store a token, or verify `/v1/schema`
- **THEN** it SHALL return a bounded actionable error
- **AND** it SHALL NOT recommend an owner-token shortcut as the routine fallback

### Requirement: Public CLI packaging SHALL remain separate from reference-only runtime
The public CLI package SHALL contain client tooling and SHALL NOT require
the reference server, connector runtime, database, or Docker environment to run
routine delegated-access commands.

#### Scenario: A user installs the npm CLI in an empty project
- **WHEN** the user runs the advertised npm command outside this repository
- **THEN** the `pdpp` executable SHALL start, show help, and run discovery/connect commands without importing reference-server-only modules

#### Scenario: A reference-only command remains available
- **WHEN** a command depends on local reference implementation internals
- **THEN** that command SHALL remain repo-local or be clearly marked reference-only
- **AND** it SHALL NOT be required for routine external delegated access

### Requirement: The local collector runner SHALL be distributable as a public npm package distinct from `@pdpp/cli`

The reference implementation SHALL publish the local collector runner as a separate public npm package (`@pdpp/local-collector`) rather than inside `@pdpp/cli`. `@pdpp/cli` SHALL remain the only public package that owns the `pdpp` binary; the collector package SHALL own its own binary (`pdpp-local-collector`) and a programmatic entrypoint. `pdpp collector` SHALL be a shim in `@pdpp/cli` that resolves and execs the collector package without depending on it at install time.

#### Scenario: Operator installs only `@pdpp/cli`

- **WHEN** an operator installs only `@pdpp/cli` from npm
- **THEN** `pdpp` SHALL be available
- **AND** `pdpp collector advertise` SHALL print a single-line install hint pointing at `@pdpp/local-collector` rather than running the runner

#### Scenario: Operator installs `@pdpp/local-collector`

- **WHEN** an operator installs `@pdpp/local-collector` (globally or via `npx`)
- **THEN** `pdpp-local-collector advertise|enroll|run` SHALL be available
- **AND** the package SHALL NOT introduce a second `pdpp` binary

#### Scenario: Both packages are installed

- **WHEN** both `@pdpp/cli` and `@pdpp/local-collector` are installed
- **THEN** `pdpp collector ...` SHALL forward argv to the resolved collector binary
- **AND** the CLI shim SHALL NOT duplicate runner-owned flag definitions

### Requirement: The published collector runner SHALL stay free of browser-runtime dependencies

The published `@pdpp/local-collector` artifact SHALL NOT carry Playwright, Patchright, Chromium downloads, `better-sqlite3`, `pdf-parse`, `imapflow`, or `linkedom`. Filesystem-class connectors (Claude Code, Codex) SHALL be bundled inside the published runner; browser/Patchright-bound connectors SHALL remain in the private workspace package until each has its own publishability review.

#### Scenario: Published tarball is inspected

- **WHEN** CI inspects the published `@pdpp/local-collector` tarball
- **THEN** the artifact SHALL contain no imports from `playwright`, `patchright`, `imapflow`, `pdf-parse`, `better-sqlite3`, or `linkedom`
- **AND** the package SHALL NOT define a `postinstall` script

#### Scenario: A browser-bound connector is requested

- **WHEN** an operator asks `@pdpp/local-collector` to run a browser-bound connector
- **THEN** the runner SHALL refuse the run with a typed error naming the missing capability
- **AND** the runner SHALL point the operator at the monorepo flow for browser connectors until a separate browser-collector publishability decision lands

### Requirement: Connector entrypoints in the published runner SHALL be bundled and resolved by `connector_id`

The published runner SHALL ship Claude Code and Codex entrypoints inside its own distribution and select them by `connector_id`. Arbitrary `--command <bin>` invocation SHALL be disabled in the published runner unless an explicit opt-in environment variable is set, so the device-scoped token is never granted to an unverified binary by default.

#### Scenario: Operator selects a bundled connector

- **WHEN** an operator runs `pdpp-local-collector run --connector codex ...`
- **THEN** the runner SHALL spawn the bundled Codex entrypoint
- **AND** the operator SHALL NOT need to pass a `--command` path

#### Scenario: Operator passes `--command` in the published runner

- **WHEN** an operator passes `--command <bin>` to the published runner without setting the opt-in environment variable
- **THEN** the runner SHALL fail before any child spawn
- **AND** the error SHALL name the opt-in variable and point at this change

### Requirement: Collector / reference-server compatibility SHALL be asserted by an explicit protocol version

The runner package and the reference server SHALL both export a `COLLECTOR_PROTOCOL_VERSION` constant. The runner SHALL include this version on enrollment and on every device-exporter ingest request via an `X-PDPP-Collector-Protocol` header. The reference server SHALL reject incompatible versions with a typed `409 collector_protocol_mismatch` response before persisting records, and SHALL persist the accepted version on the device row at enrollment.

#### Scenario: Compatible runner enrolls

- **WHEN** a runner whose `COLLECTOR_PROTOCOL_VERSION` is in the server's accepted set enrolls
- **THEN** the server SHALL persist the version on the device row
- **AND** subsequent ingest requests carrying the same version SHALL be accepted

#### Scenario: Incompatible runner ingests

- **WHEN** a runner whose protocol version is not in the server's accepted set submits an ingest request
- **THEN** the server SHALL respond `409 collector_protocol_mismatch` with a JSON body listing accepted versions
- **AND** no record SHALL be persisted from the request
- **AND** no device-scoped capability SHALL be widened by the rejected request

### Requirement: The `@pdpp/cli` shim SHALL fail fast with an actionable install hint when the collector package is missing

If `pdpp collector` is invoked without `@pdpp/local-collector` resolvable on the host, the shim SHALL print a single actionable install hint and exit non-zero. It SHALL NOT silently degrade, perform network installs, or expose monorepo-internal paths to the operator.

#### Scenario: Collector package is not installed

- **WHEN** `pdpp collector advertise` is invoked from a host without `@pdpp/local-collector` installed and without a monorepo workspace
- **THEN** the shim SHALL exit non-zero with a one-line install hint naming `@pdpp/local-collector`
- **AND** the hint SHALL NOT include monorepo clone instructions as the primary path

#### Scenario: Collector package is installed

- **WHEN** `pdpp collector advertise` is invoked on a host where `@pdpp/local-collector` is installed
- **THEN** the shim SHALL resolve the runner via `require.resolve('@pdpp/local-collector/package.json')`
- **AND** SHALL forward argv to the resolved binary

### Requirement: Bounded runs SHALL record recoverable detail gaps before committing list progress
The reference implementation SHALL NOT durably advance list-level cursor progress past declared required connector detail whose content is unknown unless the missing detail is durably recorded as an explicit recoverable detail gap or backlog entry. The gap record SHALL include enough safe targeting information for a later run to retry the missing detail without replaying the full committed list tranche.

#### Scenario: Required detail exhausts recoverable pressure
- **WHEN** a connector enumerates a list cursor tranche, declares the listed keys that require detail for that cursor boundary, and a required detail fetch for one listed item exhausts recoverable upstream pressure
- **THEN** the run MAY commit list-level cursor progress only if the missing detail is durably recorded as a pending recoverable detail gap before checkpoint commit
- **AND** the connector SHALL NOT emit a placeholder record that represents the required detail as complete

#### Scenario: Same-bucket detail pressure defers later tranche items
- **WHEN** a connector observes recoverable upstream pressure for one required detail item in a same-bucket list-plus-detail tranche
- **THEN** the connector MAY proactively record later unattempted items in the same tranche as pending recoverable detail gaps without fetching each item
- **AND** the reference-only detail coverage SHALL include every deferred required key in `gap_keys`
- **AND** diagnostics for deferred items SHALL NOT imply that those items were attempted or that they exhausted a retry budget

#### Scenario: Required detail is missing without a durable gap
- **WHEN** a bounded run reaches checkpoint commit with list-level progress whose declared detail coverage includes an item whose required detail was neither hydrated, explicitly optional/skipped, nor durably recorded as a recoverable gap
- **THEN** the runtime SHALL reject the commit or fail the run
- **AND** the main cursor SHALL NOT advance past that item

#### Scenario: Connector does not declare detail coverage
- **WHEN** a connector does not emit the reference-only detail coverage signal for a list cursor boundary
- **THEN** the runtime SHALL NOT infer missing required detail from ordinary record absence alone
- **AND** the connector SHALL NOT use the successful-with-pending-detail cursor semantics for that boundary

#### Scenario: Optional detail is skipped
- **WHEN** a connector skips detail that the stream semantics treat as optional and declares that skip in the reference-only coverage for the cursor boundary
- **THEN** the skip SHALL be explicit in connector output or reference observability
- **AND** the runtime SHALL NOT treat that optional skip as a required-detail recoverable gap

### Requirement: Detail-gap recovery SHALL target backlog before full-tranche replay
The reference implementation SHALL use durable detail-gap backlog entries to recover missing required detail for already-committed list cursor boundaries without requiring ordinary forward collection to replay the entire original list tranche.

#### Scenario: A future run sees pending gaps
- **WHEN** a future run starts for the same source and scope as pending detail gaps
- **THEN** the reference runtime or connector orchestration SHALL make those gaps available for targeted recovery before or alongside ordinary forward list collection
- **AND** recovery SHALL use the connector's normal retry, adaptive lane, pacing, and cancellation controls for that upstream detail bucket

#### Scenario: Gap recovery succeeds
- **WHEN** targeted recovery fetches the missing required detail
- **THEN** the connector SHALL emit the real hydrated record
- **AND** the reference implementation SHALL mark the corresponding gap as recovered only after the record is durably accepted

#### Scenario: Gap recovery exhausts retry again
- **WHEN** targeted recovery again exhausts recoverable upstream pressure
- **THEN** the reference implementation MAY keep the gap pending with updated attempt metadata and a bounded next-attempt time
- **AND** it SHALL NOT fabricate complete data or clear the backlog entry without successful recovery or explicit terminal evidence

### Requirement: Detail-gap state SHALL remain reference-only until promoted
Connector detail-gap backlog storage, recovery scheduling, and observability SHALL be treated as reference-only behavior for the first implementation tranche. This behavior SHALL NOT be presented as a Collection Profile protocol requirement unless a later OpenSpec change and root protocol update promote a standard wire contract.

#### Scenario: Reference observability exposes gaps
- **WHEN** `_ref` timelines, summaries, or diagnostics expose detail-gap state
- **THEN** those artifacts SHALL be labeled reference-only
- **AND** they SHALL distinguish pending, recovered, and terminal gaps from fully collected records

#### Scenario: A protocol reader reviews Collection Profile semantics
- **WHEN** a reviewer asks whether detail-gap backlog entries are required Collection Profile messages or fields
- **THEN** the reference documentation SHALL state that they are not normative Collection Profile protocol in this tranche
- **AND** it SHALL identify any connector/runtime reporting mechanism as internal reference behavior
- **AND** portable connectors and protocol readers SHALL NOT rely on the reference `DETAIL_GAP` signal, detail-coverage signal, backlog schema, or cursor interpretation unless a later root protocol change promotes an explicit wire contract

#### Scenario: Gap metadata is stored or displayed
- **WHEN** the reference stores or displays detail-gap locators, reasons, or errors
- **THEN** it SHALL avoid bearer tokens, cookies, secret-bearing URLs, request bodies, and raw private payloads
- **AND** it SHALL store only the safe targeting information needed for recovery and auditability

### Requirement: Reference connector catalog SHALL hide unproven manifests by default

The reference implementation's operator-only addable connector catalog SHALL exclude any connector whose manifest is not explicitly opted in as a public listing. This requirement governs reference/operator catalog behavior and is not part of the PDPP protocol contract. The legacy `GET /_ref/connectors` route is a configured-connection summary projection and SHALL NOT be used as the catalog-completeness mechanism.

#### Scenario: Manifest is explicitly hidden

- **WHEN** a connector manifest declares
  `capabilities.public_listing.listed: false`
- **THEN** the reference addable connector catalog SHALL NOT include that connector.

#### Scenario: Manifest declares unproven status

- **WHEN** a connector manifest declares
  `capabilities.public_listing.status: "unproven"` without
  `listed: true`
- **THEN** the reference addable connector catalog SHALL NOT include that connector.

#### Scenario: Manifest requires a local-device binding without an explicit opt-in

- **WHEN** a connector manifest declares
  `runtime_requirements.bindings.local_device.required: true` and does
  not declare `capabilities.public_listing.listed: true`
- **THEN** the reference addable connector catalog SHALL NOT include that connector, because the provider Docker deployment cannot satisfy the local-device binding.

#### Scenario: Connector ID matches a known reference stub

- **WHEN** a connector ID contains a known reference test stub
  identifier (such as `manual_action_stub`, `manual-action-stub`, or
  `stream-test-stub`)
- **THEN** the reference addable connector catalog SHALL NOT include that connector,
  regardless of manifest contents.

#### Scenario: Manifest is explicitly listed

- **WHEN** a connector manifest declares
  `capabilities.public_listing.listed: true`
- **THEN** the reference addable connector catalog SHALL include that connector, provided the connector ID does not match a known reference stub identifier.

### Requirement: First-party manifests SHALL declare public listing status

Every first-party reference manifest distributed under `packages/polyfill-connectors/manifests/` SHALL declare `capabilities.public_listing.listed` as a boolean. Manifests SHALL NOT rely on the implicit default-visible fallback.

#### Scenario: First-party manifest omits public_listing

- **WHEN** a first-party reference manifest does not declare
  `capabilities.public_listing.listed`
- **THEN** the manifest set's honesty test SHALL fail and the manifest
  SHALL NOT be shipped.

#### Scenario: First-party manifest declares listed false

- **WHEN** a first-party reference manifest declares
  `capabilities.public_listing.listed: false`
- **THEN** the manifest SHALL also declare
  `capabilities.public_listing.status` as either `"unproven"` (the
  default reason for hiding a not-yet-exercised manifest) or
  `"deprecated_upstream"` (the reason for hiding a manifest whose
  upstream API has been shut down). Both values are absolute
  hidden-by-design reasons; no other status value paired with
  `listed: false` is permitted.

### Requirement: Reference connector catalog SHALL be complete for listed first-party manifests

After the reference implementation's startup `reconcilePolyfillManifests` pass, every first-party manifest under `packages/polyfill-connectors/manifests/` that declares `capabilities.public_listing.listed: true` SHALL be present in the connectors table and SHALL be visible through the reference addable connector catalog, regardless of whether the operator has ever scheduled, run, or connected the connector. Registration through this path is the catalog visibility act; it is NOT schedule enablement and NOT connection creation. Hidden / unproven first-party manifests, manifests outside the shipped first-party set (custom user-authored connectors), and known stub connector IDs SHALL NOT be auto-registered by this path.

#### Scenario: Listed first-party manifest with no prior schedule, run, or connection

- **WHEN** a first-party manifest under
  `packages/polyfill-connectors/manifests/` declares
  `capabilities.public_listing.listed: true`
- **AND** the connectors table contains no row for that manifest's
  `connector_id` (no schedule, no prior run, no connection)
- **THEN** the reference implementation's startup
  `reconcilePolyfillManifests` pass SHALL register the manifest so the
  addable connector catalog includes it
- **AND** that registration SHALL NOT create a `connector_instances` row.

#### Scenario: Hidden first-party manifest with no prior schedule, run, or connection

- **WHEN** a first-party manifest under
  `packages/polyfill-connectors/manifests/` declares
  `capabilities.public_listing.listed: false` (or omits a
  `listed: true` declaration)
- **AND** the connectors table contains no row for that manifest's
  `connector_id`
- **THEN** the reference implementation's startup
  `reconcilePolyfillManifests` pass SHALL NOT register the manifest,
  preserving the hidden-from-catalog state for unproven and
  deprecated-upstream manifests.

### Requirement: Deprecated-upstream manifests SHALL be hidden and manual

A connector manifest whose `capabilities.public_listing.status` is `"deprecated_upstream"` SHALL declare `capabilities.public_listing.listed: false` and SHALL NOT declare `capabilities.refresh_policy.background_safe: true` or `capabilities.refresh_policy.recommended_mode: "automatic"`. A connector whose upstream API has been shut down cannot run, so honesty requires both the catalog hide (so operators do not see a dead connector advertised as ready) and the schedule-eligibility hide (so the reference scheduler does not queue runs against an API that no longer exists).

#### Scenario: Deprecated-upstream manifest declares listed=true

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "deprecated_upstream"`
- **AND** that same manifest declares
  `capabilities.public_listing.listed: true`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.

#### Scenario: Deprecated-upstream manifest with background-safe refresh policy

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "deprecated_upstream"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.background_safe: true`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.

#### Scenario: Deprecated-upstream manifest with automatic recommended mode

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "deprecated_upstream"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.recommended_mode: "automatic"`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.

### Requirement: Hidden manifests SHALL NOT be background-safe

A connector manifest that is not publicly listed in the reference catalog SHALL NOT declare `capabilities.refresh_policy.background_safe: true`. This interlock keeps the reference scheduler from quietly running a connector that the catalog has marked unproven, local-only, or otherwise not ready.

#### Scenario: Hidden manifest with a background-safe refresh policy

- **WHEN** a manifest declares
  `capabilities.public_listing.listed: false` (or omits `listed: true`
  while declaring `status: "unproven"`)
- **AND** that same manifest declares
  `capabilities.refresh_policy.background_safe: true`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.

#### Scenario: Listed manifest with a background-safe refresh policy

- **WHEN** a manifest declares
  `capabilities.public_listing.listed: true`
- **AND** that same manifest declares
  `capabilities.refresh_policy.background_safe: true`
- **THEN** the manifest is eligible for the reference scheduler under
  the existing scheduler eligibility filter.

### Requirement: Broken-in-current-deployment manifests SHALL NOT auto-schedule

A connector manifest whose `capabilities.public_listing.status` is `"broken_in_current_deployment"` SHALL NOT declare `capabilities.refresh_policy.background_safe: true` and SHALL NOT declare `capabilities.refresh_policy.recommended_mode: "automatic"`. A manifest that the reference deployment already knows is broken at the runtime layer MUST NOT advertise itself as automatically schedulable; the operator surfaces SHALL require manual operator action until the underlying breakage is resolved.

#### Scenario: Broken manifest with background-safe refresh policy

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "broken_in_current_deployment"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.background_safe: true`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.

#### Scenario: Broken manifest with automatic recommended mode

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "broken_in_current_deployment"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.recommended_mode: "automatic"`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.

### Requirement: Needs-human-auth manifests SHALL NOT auto-schedule

A connector manifest whose `capabilities.public_listing.status` is `"needs_human_auth"` SHALL NOT declare `capabilities.refresh_policy.background_safe: true` or `capabilities.refresh_policy.recommended_mode: "automatic"` unless the manifest also declares `capabilities.refresh_policy.assisted_after_owner_auth: true`. The assisted-after-owner-auth declaration means the connector still needs owner auth bootstrap or repair, but the reference scheduler may start explicitly configured runs after that auth state exists. This exception SHALL NOT make the connector eligible for boot-time auto-enrollment.

#### Scenario: Needs-human-auth manifest with background-safe refresh policy but no assisted auth posture

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "needs_human_auth"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.background_safe: true`
- **AND** it does not declare
  `capabilities.refresh_policy.assisted_after_owner_auth: true`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.

#### Scenario: Needs-human-auth manifest with automatic recommended mode but no assisted auth posture

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "needs_human_auth"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.recommended_mode: "automatic"`
- **AND** it does not declare
  `capabilities.refresh_policy.assisted_after_owner_auth: true`
- **THEN** the manifest set's honesty test SHALL fail, and the
  reference deployment SHALL treat the manifest as misconfigured.

#### Scenario: Needs-human-auth manifest with assisted-after-owner-auth scheduling

- **WHEN** a manifest declares
  `capabilities.public_listing.status: "needs_human_auth"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.recommended_mode: "automatic"`
- **AND** that same manifest declares
  `capabilities.refresh_policy.background_safe: true`
- **AND** that same manifest declares
  `capabilities.refresh_policy.assisted_after_owner_auth: true`
- **THEN** the manifest set's honesty test SHALL pass for this posture
- **AND** explicit owner schedule creation MAY enable a schedule for a configured connection, subject to the normal schedule interval and runtime readiness gates.

#### Scenario: Assisted scheduled connector is treated as schedulable for freshness health

- **WHEN** a connector with `capabilities.refresh_policy.assisted_after_owner_auth: true` has an enabled schedule
- **AND** the connection's retained data is stale under `capabilities.refresh_policy.maximum_staleness_seconds`
- **THEN** the reference health projection SHALL treat that stale freshness as schedulable stale data rather than as manual-refresh-only advisory staleness
- **AND** any auth-expired or manual-action-needed condition SHALL be surfaced through the existing owner-attention gates before a scheduled run starts.

### Requirement: The reference auto-enrolls eligible connectors when deployment credentials are present
The reference implementation SHALL, on server boot, enroll a default enabled
schedule for every first-party connector whose shipped manifest meets all of
the following facts AND whose declared environment variables are populated in
the running process: `recommended_mode=automatic`,
`background_safe=true` (or absent), `public_listing.listed=true`,
`public_listing.status=proven`, and `capabilities.auth.kind=env` with a
non-empty `capabilities.auth.required` list of environment variable names.

#### Scenario: Eligible connector with deployment env is enrolled on boot
- **WHEN** the reference server starts, manifest reconciliation has completed, and a registered first-party manifest satisfies the five-fact eligibility test
- **AND** every entry of `capabilities.auth.required` is satisfied: a string entry SHALL be satisfied when its named `process.env` value is non-empty, and an alias-array entry SHALL be satisfied when **any** of its listed env names is non-empty in `process.env` (matching the runtime first-set-wins resolution in `packages/polyfill-connectors/src/auth.ts`)
- **AND** no persisted schedule row exists for that connector
- **THEN** the reference SHALL insert a new schedule row with `enabled=true`, `interval_seconds=capabilities.refresh_policy.recommended_interval_seconds` (falling back to 3600 when the manifest omits an interval), and `jitter_seconds=0`
- **AND** the reference SHALL NOT inspect, copy, or log the env variable values

#### Scenario: Missing env keeps the connector honestly unscheduled
- **WHEN** a registered first-party manifest is otherwise auto-enroll eligible but at least one entry of `capabilities.auth.required` is unsatisfied (the named `process.env` value is absent or empty for a string entry, or every alias in an alias-array entry is absent or empty in `process.env`)
- **THEN** the reference SHALL NOT create a schedule row for that connector
- **AND** the connector SHALL continue to surface as `NOSCHED` in `scheduler-doctor` and the dashboard SHALL NOT claim the connector is currently runnable

#### Scenario: Auto-enrollment never overrides operator intent
- **WHEN** the reference boots and a persisted schedule row already exists for a connector that would otherwise be auto-enroll eligible
- **THEN** the reference SHALL NOT alter `enabled`, `interval_seconds`, `jitter_seconds`, or any other field of that row
- **AND** the reference SHALL NOT re-enable a row the operator had paused

#### Scenario: Manual, paused, background-unsafe, unproven, or owner-auth assisted connectors are never auto-enrolled
- **WHEN** a registered first-party manifest declares `recommended_mode` of `manual` or `paused`, OR `background_safe: false`, OR `public_listing.status` other than `proven`, OR `capabilities.refresh_policy.assisted_after_owner_auth: true`, OR omits `capabilities.auth.required`
- **THEN** the reference SHALL NOT auto-enroll a schedule for that connector even when every env name happens to be present
- **AND** existing schedule mutation gates SHALL continue to apply for ineligible connectors
- **AND** a `needs_human_auth` connector with `assisted_after_owner_auth: true` MAY still be scheduled through an explicit owner schedule mutation after the owner configures the connection.

#### Scenario: Operators can opt out of auto-enrollment
- **WHEN** the reference boots with `PDPP_SKIP_AUTO_SCHEDULE_ENROLLMENT=1` in its environment or with the equivalent constructor option set to `false`
- **THEN** the reference SHALL skip the auto-enrollment pass entirely
- **AND** schedule mutation via the regular schedule API SHALL still work as before

### Requirement: Failed connector exits SHALL preserve bounded owner diagnostics

When a connector child process exits before emitting a valid `DONE` message, the reference runtime SHALL persist enough bounded diagnostic evidence for the owner to understand the observed failure class after the process has exited. The terminal run failure data SHALL include a runtime-authored `failure_origin` and `failure_message`. If the connector wrote stderr before exit, the terminal failure data SHALL also include a bounded, redacted stderr diagnostic excerpt with byte-count and truncation metadata.

The persisted stderr diagnostic SHALL be treated as connector-authored, untrusted diagnostic evidence. It SHALL be visible only on owner/control-plane surfaces and SHALL NOT be exposed through grant-scoped `/v1` data, search, schema, or blob APIs.

The runtime SHALL bound stderr capture before persistence; it SHALL NOT accumulate unbounded stderr in memory for the lifetime of a run. The diagnostic excerpt SHALL be redacted before it is written to the run timeline and SHALL preserve metadata that tells the owner whether the excerpt was truncated.

#### Scenario: Connector exits before DONE after writing stderr

- **WHEN** a connector child process writes stderr and exits with a non-zero code before emitting `DONE`
- **THEN** the persisted terminal `run.failed` data SHALL include `failure_origin: "connector"`
- **AND** it SHALL include a runtime-authored `failure_message`
- **AND** it SHALL include the connector `exit_code`
- **AND** it SHALL include a `connector_diagnostics.stderr_tail` object containing a bounded redacted excerpt, `bytes_observed`, `bytes_captured`, `truncated`, and `redacted`.

#### Scenario: Connector stderr exceeds the diagnostic cap

- **WHEN** a connector writes more stderr than the configured diagnostic cap before exiting
- **THEN** the persisted `connector_diagnostics.stderr_tail.text` SHALL contain only a bounded tail excerpt
- **AND** `truncated` SHALL be `true`
- **AND** `bytes_observed` SHALL be greater than `bytes_captured`.

#### Scenario: Connector stderr contains a secret-like value

- **WHEN** captured connector stderr contains a value matching the reference diagnostic redaction policy
- **THEN** the persisted stderr excerpt SHALL contain the redacted replacement rather than the original secret
- **AND** the diagnostic metadata SHALL indicate that redaction was applied.

#### Scenario: Client-token read cannot access connector stderr diagnostics

- **WHEN** a grant-scoped client token reads records, search results, schema, blobs, or other `/v1` resources within its grant
- **THEN** connector stderr diagnostics from run timelines SHALL NOT be included in the response
- **AND** the client SHALL NOT receive a URL or object identifier that grants access to those diagnostics.

#### Scenario: Owner run timeline can inspect connector stderr diagnostics

- **WHEN** the owner reads the failed run timeline through the reference control plane
- **THEN** the terminal failure event SHALL include the bounded connector diagnostic fields
- **AND** the diagnostic SHALL be labeled or shaped so the dashboard can distinguish connector-authored stderr from runtime-authored failure classification.

### Requirement: Node diagnostic reports SHALL be secret-minimized when enabled

When the reference implementation enables Node.js diagnostic reports for a process whose environment may be inherited by connector child processes, it SHALL configure those reports to exclude environment variables and network details. Diagnostic reports are reference/operator artifacts for crash investigation; they SHALL NOT become grant-scoped PDPP data, and the reference SHALL NOT expose report paths or report contents through `/v1` client APIs.

#### Scenario: Dev command enables connector-inheritable Node reports

- **WHEN** a reference dev command enables `--report-on-fatalerror` or `--report-uncaught-exception`
- **AND** connector child processes may inherit those report settings through `NODE_OPTIONS` or process environment
- **THEN** the command SHALL also enable `--report-exclude-env`
- **AND** it SHALL enable `--report-exclude-network`.

#### Scenario: A connector child produces a Node diagnostic report

- **WHEN** a connector child process produces a Node diagnostic report
- **THEN** the report SHALL be treated as an operator-local diagnostic artifact
- **AND** client-token `/v1` reads SHALL NOT expose the report content, path, or object identifier.

### Requirement: OAuth error responses SHALL include request identifiers

The reference implementation SHALL keep authorization-server OAuth errors RFC-shaped while adding a stable request identifier.

#### Scenario: OAuth endpoint rejects a request

- **WHEN** an OAuth authorization-server endpoint returns an error response with `error`
- **THEN** the JSON body SHALL include `request_id`
- **AND** the response SHALL include a `Request-Id` header with the same value
- **AND** the body SHALL retain the OAuth `error` and `error_description` fields when a description is available.

#### Scenario: OAuth errors are compared with PDPP resource errors

- **WHEN** a client receives an OAuth endpoint error
- **THEN** the error SHALL NOT be wrapped in the nested PDPP resource-server error envelope
- **AND** clients SHALL treat `request_id` as the cross-surface correlation key.

### Requirement: Dashboard BFF device approval SHALL use the JSON CSRF exemption
The reference implementation SHALL allow same-origin dashboard backend callers to drive the canonical RFC 8628 device flow by POSTing JSON to `/device/approve` and `/device/deny` with a valid owner session cookie. The reference implementation SHALL NOT introduce a private owner-token mint endpoint that bypasses the public device-flow state machine.

#### Scenario: BFF approves a device flow with a valid owner session cookie
- **WHEN** the dashboard BFF POSTs to `/device/approve` with `Content-Type: application/json`, a valid `pdpp_owner_session` cookie, and a staged device `user_code`
- **THEN** the AS SHALL approve the staged device request
- **AND** the subsequent `/oauth/token` device-code exchange SHALL return the bearer issued by the canonical device flow

#### Scenario: JSON approval without a valid owner session is rejected
- **WHEN** the dashboard BFF POSTs to `/device/approve` with `Content-Type: application/json` but without a valid owner session cookie
- **THEN** the AS SHALL return 401 with `owner_session_required`

#### Scenario: Hosted-form CSRF enforcement remains in place
- **WHEN** a caller POSTs a form-encoded body to `/device/approve` without a valid hosted-form CSRF token
- **THEN** the AS SHALL return 403 with `csrf_token_invalid`

#### Scenario: Private owner-token mint endpoint is absent
- **WHEN** a caller requests `POST /_ref/owner/mint-self-export-token`
- **THEN** the AS SHALL NOT mint a bearer through that route

### Requirement: Reference freshness SHALL be derived from run evidence when available

Reference RS and `_ref` surfaces that emit `freshness` SHALL derive the field from connector run evidence and connector refresh policy when those inputs are available. The reference SHALL NOT report a fabricated `last_attempted_at` from record timestamps.

#### Scenario: Recent successful run is current

- **WHEN** a connector has a latest successful run with `finished_at` inside `capabilities.refresh_policy.maximum_staleness_seconds`
- **THEN** RS and `_ref` freshness for that connector's streams SHALL include `captured_at` equal to the latest successful run time
- **AND** `status` SHALL be `current`.

#### Scenario: Latest failed attempt marks data stale

- **WHEN** a connector has a latest failed or cancelled run attempt after the latest successful run
- **THEN** freshness SHALL include `last_attempted_at` equal to the failed or cancelled attempt time
- **AND** `status` SHALL be `stale`.

#### Scenario: Record timestamp fallback remains unknown without policy

- **WHEN** the reference has record `last_updated` evidence but no connector run evidence or maximum staleness policy
- **THEN** freshness MAY include `captured_at` from the record timestamp
- **AND** it SHALL keep `status` equal to `unknown`
- **AND** it SHALL NOT emit `last_attempted_at`.

#### Scenario: Missing maximum staleness does not invent freshness guarantees

- **WHEN** a connector has a successful run but no `maximum_staleness_seconds` declaration
- **THEN** freshness SHALL NOT report `current` solely because a run exists
- **AND** it SHALL keep `status` equal to `unknown` unless the latest attempt failed after the latest success.

### Requirement: Authorization-server metadata SHALL publish pre-registered public clients

When the reference authorization server advertises `pre_registered_public`, it SHALL publish the usable public client identifiers in authorization-server metadata.

#### Scenario: Dynamic registration is disabled

- **WHEN** a public caller fetches `/.well-known/oauth-authorization-server`
- **AND** dynamic registration is disabled
- **THEN** the metadata SHALL omit `registration_endpoint`
- **AND** `pdpp_registration_modes_supported` SHALL include `pre_registered_public`
- **AND** `pdpp_pre_registered_public_clients` SHALL contain at least one usable public client.

#### Scenario: Public clients are advertised

- **WHEN** `pdpp_pre_registered_public_clients` is present
- **THEN** every entry SHALL include `client_id`, `client_name`, and `token_endpoint_auth_method`
- **AND** every entry SHALL describe a configured pre-registered public client
- **AND** the list SHALL NOT include dynamically registered clients, owner-scoped clients, secrets, access tokens, or private registration state.

#### Scenario: Dynamic registration is also available

- **WHEN** dynamic registration is available to the caller
- **THEN** the metadata SHALL advertise both `dynamic` and `pre_registered_public`
- **AND** `pdpp_pre_registered_public_clients` SHALL still list the configured pre-registered public clients.

### Requirement: RS 401 responses SHALL advertise protected-resource metadata when safe
The reference Resource Server SHALL include a `WWW-Authenticate` header with a `Bearer` challenge and RFC 9728 `resource_metadata` parameter when rejecting a bearer-authenticated public query request with HTTP 401. The `resource_metadata` value SHALL point at the RS protected-resource metadata URL derived from the same configured public resource origin used by `GET /.well-known/oauth-protected-resource`. The JSON error body SHALL include the same URL as `error.resource_metadata` and SHALL include an `error.next_step` hint that tells agents to use resource metadata discovery before retrying protected `/v1/**` endpoints. When the metadata URL would require deriving a public origin from an untrusted request host, the reference SHALL omit the challenge and body hints rather than advertise that host.

#### Scenario: Missing bearer token gets metadata challenge
- **WHEN** a client requests a protected RS `/v1/**` endpoint without an Authorization header
- **THEN** the reference SHALL respond with HTTP 401
- **AND** the response SHALL include `WWW-Authenticate: Bearer resource_metadata="<metadata-url>"`
- **AND** `<metadata-url>` SHALL be the RFC 9728 protected-resource metadata URL for the resolved RS resource origin
- **AND** the JSON body SHALL include `error.resource_metadata` equal to `<metadata-url>`
- **AND** the JSON body SHALL include `error.next_step`

#### Scenario: Invalid bearer token gets metadata challenge
- **WHEN** a client requests a protected RS `/v1/**` endpoint with an invalid bearer token
- **THEN** the reference SHALL respond with HTTP 401
- **AND** the response SHALL include the same `WWW-Authenticate` `resource_metadata` challenge
- **AND** the JSON body SHALL include the same `error.resource_metadata` value

#### Scenario: Untrusted public host is not advertised
- **WHEN** a client requests a protected RS `/v1/**` endpoint through a public request host that is neither local/private nor listed in `PDPP_TRUSTED_HOSTS`
- **AND** no explicit non-loopback RS public URL is configured
- **THEN** the reference SHALL respond with HTTP 401
- **AND** the response SHALL omit `WWW-Authenticate` rather than deriving metadata from the untrusted host
- **AND** the JSON body SHALL omit `error.resource_metadata` and `error.next_step`

### Requirement: Manifest reconciliation MUST invalidate records on the reference-fixture → polyfill transition and MUST preserve records on every other manifest diff

When the reference performs polyfill manifest reconciliation at startup and observes that a connector's persisted manifest's `(version, sorted-stream-names)` fingerprint matches the on-disk reference-fixture manifest fingerprint for that same `connector_id`, AND the shipped polyfill manifest fingerprint is different, the reference SHALL invalidate every record previously persisted for that connector before re-registering the new manifest. Invalidation SHALL remove records, change history, version counters, blob bindings, and lexical and semantic index entries for the affected connector, and SHALL be logged per connector with the deleted record count.

When reconciliation observes a structural manifest diff that is NOT this reference-fixture → polyfill transition (for example: a polyfill manifest evolves with new `query.search.semantic_fields`, a description revision, a schema addition, a polyfill-only connector version bump, or a connector with no reference-fixture collision), the reference SHALL re-register the new manifest and SHALL NOT invalidate any records.

#### Scenario: A seeded reference fixture is replaced by the shipped polyfill manifest at boot
- **WHEN** the reference starts with a database whose persisted manifest fingerprint matches the on-disk reference-fixture fingerprint for a given `connector_id`, and the shipped polyfill manifest fingerprint for that same `connector_id` is different
- **THEN** reconciliation SHALL delete every record persisted under that `connector_id` before the new manifest is registered
- **AND** the dashboard, search endpoints, and dataset summary SHALL NOT advertise any prior-shape record as fresh data after reconciliation completes

#### Scenario: An ordinary polyfill manifest evolution is reconciled
- **WHEN** the persisted manifest is the prior polyfill version for a given `connector_id` and the shipped polyfill manifest differs only in details such as added `semantic_fields`, a copy revision, an added stream view, or a polyfill version bump with the same stream set
- **THEN** reconciliation SHALL re-register the new manifest
- **AND** SHALL NOT delete any records for that `connector_id`

#### Scenario: A polyfill-only connector with no reference-fixture collision is reconciled
- **WHEN** a connector's `connector_id` has no corresponding manifest under `reference-implementation/manifests/`, and the shipped polyfill manifest differs from the persisted manifest
- **THEN** reconciliation SHALL re-register the new manifest
- **AND** SHALL NOT delete any records for that `connector_id`

#### Scenario: The persisted manifest already matches the shipped polyfill manifest
- **WHEN** the persisted manifest for a `connector_id` is structurally equal to the shipped polyfill manifest at boot
- **THEN** reconciliation SHALL NOT invalidate any records for that `connector_id`

#### Scenario: A connector is registered for the first time at boot
- **WHEN** the persisted database contains no manifest row for a `connector_id` that the shipped polyfill manifests cover
- **THEN** reconciliation SHALL NOT invalidate records (there are none) and SHALL NOT auto-register the connector either

#### Scenario: A direct registerConnector call updates an existing manifest
- **WHEN** an operator or test calls `registerConnector` with a manifest that differs from the persisted manifest, outside the reconciliation loop
- **THEN** records SHALL NOT be deleted as a side effect of the registration call

#### Scenario: Reconciliation invalidation is observable
- **WHEN** reconciliation invalidates records for a connector via the reference-fixture → polyfill transition
- **THEN** it SHALL emit a log line that names the connector id and the number of records deleted, so the operator can audit which prior-shape data was discarded

### Requirement: Record-version churn observability SHALL be bounded and reference-only

The reference implementation SHALL expose owner-only record-version observability
for detecting streams whose retained history grows disproportionately to current
records. This observability SHALL remain a reference-only operator diagnostic
and SHALL NOT change PDPP Core record read semantics, Collection Profile
messages, or public `/v1` resource-server contracts.

Each version-churn row SHALL additionally carry a reference-derived
`version_disposition` that classifies why the row's retained history exists. The
disposition SHALL be one of:

- `active_defect_or_unclassified` — a non-normal row with no recognized
  disposition. This SHALL be the only disposition that counts toward an operator
  "needs review" signal.
- `reviewed_historical_residue` — a stream with a registered compaction policy
  that the owner has reviewed as expected pre-fix accumulation, whose most recent
  history write is at or before the recorded review evidence.
- `point_in_time_retained_history` — genuine real-field movement whose sampled
  observation has been split into an append-keyed stream; the retained entity
  history is real history that SHALL NOT be compacted.
- `lossless_compaction_candidate` — a stream with a registered compaction policy
  whose redundant adjacent versions remain removable, OR a reviewed-residue
  stream whose history grew after the review (re-alarm).
- `recurring_point_in_time_snapshot` — a stream that legitimately re-versions on
  each real-growth pass, is gated against byte-identical no-op re-emits, and
  cannot be append-split or compacted (the whole record is the evolving
  observation). This is expected retained history.

The `version_disposition` SHALL be **derived by the reference implementation**
from signals it controls — the presence of a registered compaction policy, the
reference-maintained point-in-time split list, the reference-maintained
recurring point-in-time snapshot list, and the owner-maintained reviewed-residue
evidence. A connector SHALL NOT be able to set, override, or suppress a row's
`version_disposition` through any manifest field or emitted payload.

The derivation SHALL apply the recognized lists with a fixed precedence so that
a stream which is BOTH a recurring point-in-time snapshot AND carries a
registered compaction policy classifies as `recurring_point_in_time_snapshot`,
not `lossless_compaction_candidate`. The recurring-snapshot list and the
point-in-time split list SHALL therefore be evaluated before the compaction
policy signal. (The session streams that motivate
`recurring_point_in_time_snapshot` DO carry a registered compaction policy — it
is the regression safety net for a broken no-op gate — so policy presence cannot
be the distinguishing signal; explicit list membership is.)

The `version_disposition` SHALL be a label only. It SHALL NOT alter the numeric
`risk_thresholds`, the computed `risk_level`, or the `risk_reasons`. An
undeclared high-churn stream SHALL still surface as `active_defect_or_unclassified`
at its real `risk_level`. The envelope SHALL make the threshold-independence
explicit so a reader cannot mistake disposition for a threshold override.

#### Scenario: Owner lists version churn stats

- **WHEN** an owner-authenticated caller requests `GET /_ref/records/version-stats`
- **THEN** the response SHALL contain bounded aggregate rows keyed by
  `connector_instance_id` and `stream`
- **AND** each row SHALL include current record count, retained record-history
  count, versions-per-record, projection freshness when projection-backed,
  recent write timestamps when known, a reference-only risk classification, and a
  reference-derived `version_disposition`
- **AND** the response SHALL NOT include raw `record_json`, raw
  `record_changes.record_json`, credentials, or connector payload bodies.

#### Scenario: Non-owner caller attempts to read version churn stats

- **WHEN** a caller without owner authorization requests
  `GET /_ref/records/version-stats`
- **THEN** the reference implementation SHALL reject the request using the same
  owner-auth policy as other `_ref` operator reads.

#### Scenario: Version-churn stats are filtered

- **WHEN** an owner passes exact `connector_instance_id`, exact `stream`, or
  `risk` filters
- **THEN** the route SHALL apply those filters before returning rows
- **AND** result size SHALL remain capped by a server-enforced limit.

#### Scenario: Version-churn stats do not imply compaction

- **WHEN** a stream is classified as high churn
- **THEN** the reference implementation SHALL surface that classification as
  operator evidence only
- **AND** it SHALL NOT automatically compact, delete, merge, or rewrite
  `record_changes` history.

#### Scenario: Disposition does not change the risk thresholds

- **WHEN** the reference derives a `version_disposition` for a row
- **THEN** the row's `risk_level`, `risk_reasons`, and `versions_per_record`
  SHALL be computed exactly as they are without disposition
- **AND** the envelope's `risk_thresholds` SHALL be unchanged
- **AND** the envelope SHALL assert that disposition does not affect the
  thresholds.

#### Scenario: An unrecognized high-churn stream needs review

- **WHEN** a `watch` or `high` row is on a `(connector_id, stream)` that has no
  registered compaction policy, is not an append-split residual stream, is not in
  the reviewed-residue evidence, and is not a recurring point-in-time snapshot
- **THEN** the reference SHALL classify the row `active_defect_or_unclassified`
- **AND** it SHALL be the only disposition counted toward an operator
  "needs review" signal.

#### Scenario: A connector cannot self-declare its disposition

- **WHEN** a connector manifest or emitted record payload contains a field that
  attempts to assert a stream's churn disposition
- **THEN** the reference SHALL ignore that field when deriving
  `version_disposition`
- **AND** the derived disposition SHALL depend only on reference-controlled
  signals (registered compaction policy presence, the reference-maintained
  point-in-time split list, the reference-maintained recurring point-in-time
  snapshot list, and owner reviewed-residue evidence).

#### Scenario: Reviewed residue re-alarms when history grows after review

- **WHEN** a stream classified `reviewed_historical_residue` writes new history
  whose most recent timestamp is after the recorded review evidence
- **THEN** the reference SHALL classify the row `lossless_compaction_candidate`
- **AND** the row SHALL count as actionable rather than reviewed.

#### Scenario: A recurring point-in-time snapshot stream is expected retained history

- **WHEN** a stream on the reference-maintained recurring point-in-time snapshot
  list (an evolving local agent `sessions` stream — `claude-code/sessions` or
  `codex/sessions`) crosses a churn threshold
- **THEN** the reference SHALL classify the row `recurring_point_in_time_snapshot`,
  taking precedence over the row's registered compaction policy and any
  reviewed-residue evidence
- **AND** the row SHALL NOT count toward the operator "needs review" signal
- **AND** an advance in the row's most recent history timestamp SHALL NOT
  re-alarm the row, because growth is its expected, non-removable signal.

#### Scenario: A split residual entity stream is never compactable

- **WHEN** an entity stream whose sampled metric has been moved to an
  append-keyed sibling stream (for example `github/user`, `slack/channels`, or
  `ynab/accounts`) crosses a churn threshold on its retained pre-split history
- **THEN** the reference SHALL classify the row `point_in_time_retained_history`
- **AND** the reference SHALL NOT offer a compaction remediation for the row,
  because compacting it would delete real history.

### Requirement: Version-churn observability SHALL serve the unfiltered hot path from the maintained projection without an unbounded history scan

The owner-only `GET /_ref/records/version-stats` read SHALL produce its bounded
top-churn diagnostic for an **unfiltered** request without running an unbounded
aggregate over the entire `record_changes` table. The reference implementation
SHALL source the per-stream churn facts from the maintained retained-size
projection for streams the projection can classify, and SHALL compute the
ground-truth aggregate (`COUNT(*)`, `COUNT(DISTINCT record_key)`,
`MAX(emitted_at)`) only for a bounded candidate set of streams.

This requirement governs how the row facts are SOURCED for the unfiltered hot
path. It SHALL NOT alter what a row contains, the numeric churn thresholds, the
`risk_level` / `risk_reasons` classification, or the derived
`version_disposition`. A row whose facts are sourced from ground truth SHALL be
byte-identical to the row the prior full scan would have produced.

The reference implementation SHALL treat the projection's `record_history_count`
and current `record_count` as authoritative for a stream ONLY when that
projection row is not dirty. It SHALL NOT treat the projection's
`record_history_count` as authoritative for a dirty row, and SHALL NOT
incrementally maintain `COUNT(DISTINCT record_key)` or `MAX(emitted_at)` from
write-time deltas.

The candidate set SHALL be derived conservatively so that no stream which
ground truth would classify above `normal` is omitted from the ground-truth
computation. A stream SHALL be a candidate when its projection row is dirty, or
when its non-dirty projection facts could place it at or above the `watch`
threshold under the denominator that maximizes versions-per-record. Over-
inclusion of a stream that proves `normal` SHALL be acceptable; omission of a
non-`normal` stream SHALL NOT occur.

When the global retained-size projection is dirty (never built or rebuild
pending), the reference implementation SHALL fall back to the full ground-truth
computation for the unfiltered request rather than serve a candidate-narrowed
diagnostic.

#### Scenario: Unfiltered request avoids the unbounded scan

- **WHEN** an owner-authenticated caller requests `GET /_ref/records/version-stats`
  with no `connector_instance_id` and no `stream` filter, and the global
  retained-size projection is not dirty
- **THEN** the reference implementation SHALL NOT run an aggregate over
  `record_changes` that is unbounded by stream
- **AND** it SHALL compute the ground-truth `COUNT(*)`,
  `COUNT(DISTINCT record_key)`, and `MAX(emitted_at)` only for the bounded
  candidate set of streams (candidates plus any dirty projection rows).

#### Scenario: Candidate facts are byte-identical to the full scan

- **WHEN** the unfiltered request classifies a stream as `watch` or `high` from
  the candidate ground-truth computation
- **THEN** that row's `record_history_count`, `record_key_count`,
  `last_history_at`, `versions_per_record`, `risk_level`, `risk_reasons`, and
  `version_disposition` SHALL equal the values the prior full
  `record_changes` scan would have produced for the same stream.

#### Scenario: A non-candidate normal stream is classified without a scan

- **WHEN** a stream's non-dirty projection facts are below the candidate
  threshold under the versions-per-record-maximizing denominator
- **THEN** the reference implementation SHALL classify the row from projection
  facts alone, reporting `projection_authority` as the projection (not ground
  truth), and SHALL report `record_key_count` and `last_history_at` as null
- **AND** it SHALL NOT issue a `record_changes` aggregate for that stream.

#### Scenario: A dirty projection row is always verified against ground truth

- **WHEN** a stream's projection row is dirty
- **THEN** the reference implementation SHALL include that stream in the bounded
  ground-truth computation regardless of the stream's apparent projection risk,
  so a stale projection count cannot cause a non-normal row to be omitted or
  downgraded.

#### Scenario: A cold or rebuilding projection falls back to the full computation

- **WHEN** an unfiltered request arrives while the global retained-size
  projection is dirty
- **THEN** the reference implementation SHALL compute the diagnostic from the
  full ground-truth aggregate rather than the candidate-narrowed path, so a cold
  or rebuilding instance is never served a thinned diagnostic.

#### Scenario: Filtered requests are unchanged

- **WHEN** an owner passes an exact `connector_instance_id` or exact `stream`
  filter
- **THEN** the reference implementation SHALL apply that filter to the
  ground-truth computation as before
- **AND** result size SHALL remain capped by the server-enforced limit.

### Requirement: Record version allocation SHALL be atomic with the durable mutation

The reference implementation SHALL allocate the next per-`(connector_id, stream)` record version with a single atomic store operation, executed inside the durable record mutation transaction, that simultaneously advances version state and returns the freshly-allocated version. The reference SHALL NOT compute the next version from a separately-observable read of `version_counter` followed by a later write.

This requirement strengthens, but does not weaken, the existing durable record ingest and direct delete atomicity requirements. Lexical, semantic, and disclosure-spine maintenance SHALL remain outside the durable record mutation transaction.

The reference implementation SHALL evaluate no-op equivalence against the adapter's stored form in a way that does not depend on incidental layout differences (whitespace, key order) the adapter itself introduces. The SQLite adapter SHALL compare the stored TEXT `record_json` against the inbound serialized payload as a string. The Postgres adapter SHALL compare the stored `jsonb` `record_json` against the inbound payload structurally at the `jsonb` level. Both adapters SHALL satisfy the property that a byte-identical inbound payload following a successful prior ingest of the same payload is treated as a no-op.

When the reference processes a no-op re-ingest, an absent-record delete, or a repeated delete, it SHALL NOT invoke the atomic allocator, SHALL NOT advance `version_counter`, and SHALL NOT append a `record_changes` row.

#### Scenario: Atomic allocation on first write

- **WHEN** the reference performs the first changed write for a `(connector_id, stream)` pair
- **THEN** the atomic allocator SHALL create the `version_counter` row at `max_version = 1` and return `1` in the same statement
- **AND** the appended `record_changes.version` SHALL equal the returned value

#### Scenario: Atomic allocation on subsequent writes

- **WHEN** the reference performs a subsequent changed write for an existing `(connector_id, stream)` pair
- **THEN** the atomic allocator SHALL advance `version_counter.max_version` by exactly one and return the advanced value in the same statement
- **AND** successive changed writes for the same `(connector_id, stream)` SHALL receive distinct, monotonically increasing versions

#### Scenario: SQLite byte-identical re-ingest

- **WHEN** the SQLite-backed reference receives two successive ingests for the same `(connector_id, stream, record_key)` whose inbound `JSON.stringify(data)` outputs are byte-identical
- **THEN** only the first call SHALL allocate a version and append a `record_changes` row
- **AND** the second call SHALL return `{ accepted: true, changed: false }` without advancing `version_counter`

#### Scenario: Postgres byte-identical re-ingest

- **WHEN** the Postgres-backed reference receives two successive ingests for the same `(connector_id, stream, record_key)` whose inbound `JSON.stringify(data)` outputs are byte-identical
- **THEN** only the first call SHALL allocate a version and append a `record_changes` row
- **AND** the second call SHALL return `{ accepted: true, changed: false }` without advancing `version_counter`
- **AND** the result SHALL NOT depend on whether Postgres' `jsonb` storage canonicalizes whitespace or key order differently from the inbound serialized form

#### Scenario: Repeated delete

- **WHEN** the reference processes a delete for a `(connector_id, stream, record_key)` whose current row is already deleted or absent
- **THEN** it SHALL NOT invoke the atomic allocator
- **AND** `version_counter` SHALL NOT advance
- **AND** `record_changes` SHALL NOT gain a row

#### Scenario: Contiguous change-log sequence

- **WHEN** consumers read `record_changes` for a `(connector_id, stream)` after a sequence of changed and no-op writes
- **THEN** the observed `version` sequence SHALL be contiguous and strictly increasing
- **AND** `changes_since` SHALL observe no gaps and no duplicates relative to `version_counter.max_version`

#### Scenario: Allocation failure rolls back the durable mutation

- **WHEN** the atomic allocation or any subsequent step inside the durable mutation transaction fails
- **THEN** the reference SHALL NOT leave `version_counter` advanced relative to `records` and `record_changes`
- **AND** a later changed write for the same `(connector_id, stream)` SHALL NOT collide with or skip around a partially allocated version

### Requirement: Connector runtime SHALL provide adaptive lanes for upstream throttle buckets
The reference implementation's polyfill connector runtime SHALL provide a reusable adaptive lane utility for connector-local outbound work that targets an upstream throttle bucket. A lane SHALL bound concurrency, bound queued work, apply inter-launch pacing, accept connector-provided outcome classification, respect bounded `Retry-After` when provided, and expose deterministic timing hooks for tests.

#### Scenario: Connector schedules work through a lane
- **WHEN** a connector schedules multiple upstream requests through an adaptive lane
- **THEN** the lane SHALL NOT start more concurrent work than its current effective concurrency allows
- **AND** the lane SHALL NOT exceed its configured maximum concurrency
- **AND** the lane SHALL NOT allow queued work to grow without an explicit configured bound or pause/fail-fast policy

#### Scenario: Upstream reports rate limiting
- **WHEN** a lane receives an outcome classified as `rate_limited`
- **THEN** the lane SHALL reduce effective concurrency conservatively
- **AND** the lane SHALL apply a cooldown before launching additional work for the same upstream throttle bucket
- **AND** the lane SHALL respect a bounded `Retry-After` value when one is provided

#### Scenario: Clean successes continue
- **WHEN** a lane observes a sustained connector-configured window of clean outcomes
- **THEN** the lane MAY increase effective concurrency gradually
- **AND** the lane SHALL NOT increase beyond its configured maximum concurrency

### Requirement: Retries SHALL remain lane-governed
Retry attempts for lane-governed work SHALL obey the same lane capacity, pacing, cooldown, queue, and cancellation controls as first attempts.

#### Scenario: Request retries after a transient failure
- **WHEN** a lane-governed request receives a retryable network, server, or throttle outcome
- **THEN** the retry SHALL NOT bypass the lane's effective concurrency, cooldown, or queue bound
- **AND** the lane SHALL NOT create multiple concurrent retry loops for the same upstream throttle bucket beyond the configured lane capacity

#### Scenario: Run is cancelled while lane work is pending
- **WHEN** a run using adaptive lanes is cancelled or reaches a terminal failure before queued lane work starts
- **THEN** queued work SHALL be cleared or rejected
- **AND** scheduled retries SHALL NOT launch after cancellation
- **AND** active attempts SHOULD receive cancellation through `AbortSignal` or an equivalent mechanism when the underlying operation supports it

### Requirement: Connectors SHALL treat unbounded throttling as a source-bucket signal
When an upstream returns a retryable throttle response that carries no bounded backoff hint (for example HTTP 429 with no `Retry-After`), a connector SHALL be able to stop retrying that single request before exhausting its full per-request retry budget, so that a per-account throttle does not cause one request to spend a large retry budget against an already-pressured upstream. A bounded backoff hint, when present, SHALL still be honored on the connector's normal retry budget.

#### Scenario: Bare throttle response without a backoff hint
- **WHEN** a lane-governed request receives a throttle outcome (such as HTTP 429) that carries no `Retry-After` or equivalent bounded backoff hint
- **THEN** the connector MAY stop retrying that request after a small bounded number of attempts rather than exhausting its full per-request budget
- **AND** the connector SHALL surface the resulting pressure as resumable gap/deferred state rather than silently dropping required data
- **AND** required items deferred by this fast-open SHALL NOT be represented as complete cursor coverage

#### Scenario: Throttle response carries a bounded backoff hint
- **WHEN** a lane-governed request receives a throttle outcome that carries a bounded `Retry-After` or equivalent hint
- **THEN** the connector SHALL respect the bounded hint on its normal retry budget
- **AND** the connector SHALL NOT treat the hinted wait as a fast-open source-bucket signal

### Requirement: Raised detail concurrency SHALL be gated on current cold-state preflight
When a connector is configured to run a bulk detail lane above the serial default concurrency for an opaque per-account upstream, it SHALL first classify current source pressure with a small status-only preflight before fanning out at the raised concurrency. If the preflight observes throttling, the connector SHALL hold the run at the serial default concurrency instead of escalating. The preflight SHALL only make a run more conservative, never less, and SHALL NOT run when the configured concurrency is already the serial default.

#### Scenario: Owner enables a faster posture against a cold account
- **WHEN** a connector is configured to raise bulk detail concurrency above the serial default
- **AND** a status-only preflight of a small number of detail requests observes no throttling
- **THEN** the connector MAY proceed at the requested raised concurrency

#### Scenario: Owner enables a faster posture against a pressured account
- **WHEN** a connector is configured to raise bulk detail concurrency above the serial default
- **AND** a status-only preflight observes a throttle response
- **THEN** the connector SHALL hold the bulk detail lane at the serial default concurrency for that run
- **AND** the connector SHALL NOT fan out the raised concurrency against the pressured upstream

#### Scenario: Serial default needs no preflight
- **WHEN** a connector's configured bulk detail concurrency is the serial default
- **THEN** the connector SHALL NOT issue any preflight probe requests
- **AND** the run's request behavior SHALL remain unchanged from the serial baseline

### Requirement: Adaptive lanes SHALL stay outside cursor ownership
Adaptive lanes SHALL schedule connector work but SHALL NOT emit connector `RECORD`, `STATE`, or `DONE` messages and SHALL NOT decide whether a bounded run's staged state becomes durable.

#### Scenario: Required upstream item fails after retry budget
- **WHEN** a lane returns a terminal or exhausted outcome for an upstream item that the connector treats as required
- **THEN** the connector SHALL remain responsible for deciding whether to fail the run, emit `SKIP_RESULT`, or continue
- **AND** the lane SHALL NOT advance stream cursor state on the connector's behalf

#### Scenario: Lane work affects a cursor boundary
- **WHEN** a connector uses lane-managed work to collect records covered by a stream cursor boundary
- **THEN** the connector SHALL wait for all required lane-managed work for that cursor boundary to settle before emitting the corresponding stream `STATE`
- **AND** failed or skipped required items SHALL NOT be represented as complete cursor coverage

#### Scenario: A bounded run fails
- **WHEN** a bounded run using adaptive lanes fails before successful `DONE`
- **THEN** the existing runtime checkpoint-commit rules SHALL remain authoritative
- **AND** staged state SHALL NOT be durably committed merely because lane-managed work completed for some items

### Requirement: Adaptive lane observability SHALL be safe and bounded
Adaptive lanes SHALL expose progress or telemetry hooks sufficient to explain throttling behavior to the owner and to tests. Lane observability SHALL avoid leaking bearer tokens, cookies, request bodies, full sensitive URLs, or upstream record identifiers unless the connector supplies an explicitly safe label.

#### Scenario: Lane enters cooldown
- **WHEN** a lane enters cooldown because of upstream pressure
- **THEN** observability hooks SHOULD report the lane name, outcome class, effective concurrency, bounded delay, and cooldown reason
- **AND** the report SHALL avoid raw secret-bearing request details

#### Scenario: Tests use fake timing
- **WHEN** lane behavior is tested
- **THEN** tests SHALL be able to inject fake sleep and fake randomness
- **AND** tests SHALL NOT depend on wall-clock sleeps to prove retry, pacing, or adaptation behavior

### Requirement: Adaptive lanes SHALL support quality-of-service separation
The connector runtime SHALL allow connectors to use separate adaptive lanes for distinct upstream work classes so bulk collection does not starve recovery-critical work.

#### Scenario: Bulk hydration is saturated
- **WHEN** a connector's bulk hydration lane is at capacity or in cooldown
- **THEN** separate login, manual-action, browser-navigation, or listing lanes SHALL NOT be blocked solely because the bulk lane is saturated

### Requirement: Run automation policy SHALL apply across trigger kinds
The reference implementation SHALL classify every connector run request through a shared automation policy model before starting the connector. The policy model SHALL treat the run trigger as metadata and SHALL NOT create separate execution semantics for scheduled, manual, retry, and webhook-triggered runs.

#### Scenario: Scheduled run uses shared policy
- **WHEN** the scheduler creates a run request for a connector
- **THEN** the reference SHALL classify the request through the same automation policy model used by other trigger kinds
- **AND** the persisted run or scheduler history SHALL identify the trigger kind as `scheduled`

#### Scenario: Webhook run uses shared policy
- **WHEN** a signed source webhook requests connector refresh
- **THEN** the reference SHALL classify the request through the same automation policy model used by scheduled and manual run requests
- **AND** the trigger kind SHALL be recorded as `webhook`

#### Scenario: Manual run remains an owner gesture
- **WHEN** the owner starts a connector run from the dashboard or reference control API
- **THEN** the reference SHALL classify the request with trigger kind `manual`
- **AND** the policy model MAY allow that request to surface connector/runtime behavior that automatic triggers would skip or ask before starting

### Requirement: Automation modes SHALL distinguish unattended, assisted, ask-before-run, and manual-only behavior
The reference implementation SHALL derive an automation mode for connector run requests from connector policy, deployment readiness, owner preferences, and trigger kind. The automation mode SHALL be one of `unattended`, `assisted`, `ask_before_run`, or `manual_only`.

#### Scenario: Unattended connector runs in the background
- **WHEN** a connector is background-safe, deployment-ready, and owner policy permits unattended refresh
- **THEN** automatic triggers MAY start the connector without additional owner approval
- **AND** the run SHALL NOT imply that owner assistance is expected

#### Scenario: Assisted connector may notify during a run
- **WHEN** a connector is allowed to start automatically but may encounter bounded owner assistance
- **THEN** the reference MAY start the run from an automatic trigger
- **AND** it SHALL notify the owner only according to the run assistance and notification policy

#### Scenario: Ask-before-run preserves schedule intent without surprise execution
- **WHEN** a connector has persisted automatic intent but the policy predicts owner-present work before useful collection can begin
- **THEN** the reference SHALL NOT silently start the connector from the automatic trigger
- **AND** it MAY create an owner-visible ask-before-run notification or queue entry instead

#### Scenario: Manual-only connector is not background-started
- **WHEN** a connector policy resolves to `manual_only`
- **THEN** scheduled, retry, and webhook triggers SHALL NOT start the connector
- **AND** manual owner gestures SHALL remain available when deployment prerequisites allow them

### Requirement: Owner notification policy SHALL be explicit and tiered
The reference implementation SHALL distinguish dashboard-inbox observability from interruptive owner notifications. Web Push, ntfy, and future interruptive channels SHALL require explicit owner opt-in. Notifications SHALL be classified as `action_required` or `informational`.

#### Scenario: Dashboard inbox remains durable
- **WHEN** a run enters an assistance, retry, failure, recovery, or completion state
- **THEN** the reference SHALL keep an owner-visible dashboard record of the state
- **AND** that dashboard record SHALL NOT depend on Web Push or ntfy delivery success

#### Scenario: Informational notification respects quiet hours
- **WHEN** an informational notification is generated during the owner's configured quiet window
- **THEN** the reference SHALL suppress or defer the interruptive notification
- **AND** the dashboard inbox entry SHALL remain visible

#### Scenario: Action-required notification may bypass app quiet hours
- **WHEN** a notification is classified as action-required and the owner has opted into the target channel
- **THEN** the reference MAY send the interruptive notification even during app-level quiet hours
- **AND** the notification SHALL still respect OS, browser, provider, and channel subscription controls

#### Scenario: Missing notification subscription does not block the run state
- **WHEN** a run needs owner assistance but the owner has no valid interruptive notification channel
- **THEN** the reference SHALL expose the assistance in the dashboard inbox
- **AND** it SHALL NOT pretend that a push or ntfy notification was delivered

### Requirement: Static reference SQL SHALL be inspectable by name
The reference implementation SHALL keep static SQLite statements that define durable reference behavior in named query artifacts or an equivalent named registry. Query identifiers SHALL be stable enough for reviewers, tests, and future operator tooling to refer to them directly.

#### Scenario: A reviewer audits record-list SQL
- **WHEN** a reviewer needs to inspect the SQL used by a durable reference route
- **THEN** the query SHALL be discoverable by a stable name rather than only by grepping unrelated application code
- **AND** the call site SHALL make the selected query name clear

### Requirement: Query extraction SHALL NOT hide dynamic behavior
The reference implementation SHALL keep genuinely dynamic SQL construction explicit when extracting it would obscure authorization, filter, pagination, or variable-list semantics.

#### Scenario: A query has optional filters
- **WHEN** SQL shape changes based on request filters, grant constraints, cursor predicates, or a variable number of candidate keys
- **THEN** the reference MAY keep that query assembly in code
- **AND** the dynamic branch SHALL remain auditable and covered by tests

### Requirement: Extracted SQL SHALL be validated against the reference schema
The reference implementation SHALL provide a validation path that prepares or analyzes extracted static SQL against the current reference schema so missing tables, missing columns, and malformed statements fail before runtime use.

#### Scenario: A query references a removed column
- **WHEN** an extracted SQL artifact references a column that no longer exists in the current schema
- **THEN** the reference verification path SHALL fail with a diagnostic identifying the query artifact

### Requirement: A reusable reconciliation primitive SHALL be available for manifest-vs-schema-vs-emit drift checks
The polyfill-connectors package SHALL provide a pure-function reconciler (`reconcile`, `parseManifestStreams`, `parseSchemaStreams`, `scanEmittedStreams`, and `reconcileFromDisk` in `src/manifest-reconcile.ts`) that compares declared streams (manifest), registered streams (schema registry keys), and emit-site stream-name literals (static-scanned from connector source).

The reconciler SHALL flag three drift classes:
1. `missing_manifest` — emitted but not declared in the manifest. Public-contract gap.
2. `missing_schema` — emitted but not registered in the connector's `SCHEMAS`. Runtime-validation gap.
3. `missing_emit` — declared in the manifest but neither registered in `SCHEMAS` nor literal-emitted. Public-contract overclaim with no fulfillment path.

A connector SHALL be considered aligned (`ok: true`) when all three drift arrays are empty. Declared and registered but not literal-emitted is acceptable: the schema registration is treated as the contract that the connector can populate the stream, and the emit-scan is a heuristic that may miss dynamic emits.

#### Scenario: A connector starts emitting a new stream
- **WHEN** an emit literal `emitRecord("new_stream", ...)` is added to a connector's source
- **THEN** running the reconciler SHALL flag `missing_manifest` and `missing_schema` until both are added
- **AND** the regression-test in `bin/reconcile-manifests.test.ts` SHALL fail

### Requirement: A regression test SHALL run reconciliation against every schema-bearing connector
A test under `bin/reconcile-manifests.test.ts` SHALL iterate every connector that ships a `schemas.ts` and assert the reconciler reports `ok: true`. The test SHALL fail with the drift detail (missing arrays + declared/registered/emitted snapshots) when any connector drifts.

#### Scenario: A schema edit removes a stream from the registry without removing it from the manifest
- **WHEN** the connector's `SCHEMAS` registry no longer includes a stream that the manifest still declares
- **THEN** the regression test SHALL fail with `missing_emit` listing that stream (or `missing_schema` if the connector still emits it)

### Requirement: Direct record delete SHALL be atomic

The reference implementation SHALL treat direct owner-authenticated record delete as one atomic mutation of live record state, per-stream version state, and record change history. Search-index maintenance and disclosure-spine observability SHALL remain outside this durable record mutation unit unless a later OpenSpec change explicitly widens the boundary.

When `PDPP_CHANGE_HISTORY_LIMIT` bounds retained history, the prune step inside the durable delete unit SHALL preserve current-history anchors under the same rule as durable ingest: it SHALL NOT delete the `record_changes` row whose `version` equals a current `records` row's `version` for the same `(connector_instance_id, stream, record_key)`, and the retained-size and dataset-summary delta accounting for the prune SHALL use the same anchor-preserving predicate as the prune DELETE.

#### Scenario: Successful direct delete

- **WHEN** the reference directly deletes an existing live record
- **THEN** the live `records` row delete marker, appended deleted `record_changes` row, and `version_counter` advance SHALL commit as one atomic unit
- **AND** the appended `record_changes.version` SHALL be the version recorded by `version_counter` for that `(connector_id, stream)` after the commit

#### Scenario: No-op direct delete

- **WHEN** the reference directly deletes a record that is absent or already deleted
- **THEN** it SHALL NOT append a `record_changes` row
- **AND** it SHALL NOT advance `version_counter`

#### Scenario: Direct delete mutation failure

- **WHEN** an error occurs before the durable direct-delete mutation commits
- **THEN** the reference SHALL NOT leave `records`, `record_changes`, and `version_counter` in a partially advanced state
- **AND** a later mutation for the same `(connector_id, stream)` SHALL NOT collide with or skip around a partially written version

#### Scenario: Derived index delete maintenance

- **WHEN** durable direct record delete commits successfully
- **THEN** lexical and semantic index delete maintenance MAY run after the commit as derived maintenance
- **AND** failure in derived index delete maintenance SHALL NOT retroactively partially commit or roll back the durable direct delete mutation

#### Scenario: Delete-path pruning preserves a still-current anchor

- **WHEN** a delete advances the per-stream version and the prune step runs, while a different unchanged key's current `records` row sits below the prune cutoff
- **THEN** the prune step SHALL retain that other key's anchor `record_changes` row
- **AND** the prune SHALL NOT strand any current row whose key was not the delete target

### Requirement: Durable record ingest SHALL be atomic

The reference implementation SHALL treat durable record ingest as one atomic mutation of live record state, per-stream version state, and record change history. Search-index maintenance and disclosure-spine observability SHALL remain outside this durable record mutation unit unless a later OpenSpec change explicitly widens the boundary.

When `PDPP_CHANGE_HISTORY_LIMIT` bounds retained history, the prune step inside the durable ingest unit SHALL NOT delete the `record_changes` row that anchors a current `records` row for the same `(connector_instance_id, stream, record_key)` — the retained history row whose `version` equals the current `records` row's `version`. A pure per-stream version cutoff SHALL NOT be used, because the per-stream version advances on every key's mutation and would otherwise delete the anchor of an unchanged ("cold") current row once other ("hot") keys advance the stream past that key's retention horizon, stranding the current row with no retained history to prove it. Pruning SHALL remain bounded for changing keys: only the single anchor row per live key is exempt; older history for that key and all history of keys whose current row has since advanced SHALL still prune.

The retained-size and dataset-summary delta accounting for a prune SHALL count and sum exactly the rows the prune deletes, using the same anchor-preserving predicate, so the read models do not over-report pruned rows or bytes for keys whose anchor is retained.

Anchor-preserving pruning stops *new* stranding going forward, but it cannot reconstruct a current row whose anchor was already stranded before this fix deployed (or by a non-atomic bulk delete). For that pre-existing residue, durable ingest SHALL self-heal an unanchored current row: when an incoming record's durable payload is byte-identical to the current live state AND no retained `record_changes` row exists for the same `(connector_instance_id, stream, record_key)` at the current `records` row's `version` (the would-be no-op fires but the anchor is gone), the ingest SHALL re-anchor the current row by allocating a NEW per-stream version and appending a fresh `record_changes` row at that version, rather than suppressing the write as a plain no-op. The new version SHALL be the head-of-window version (`version_counter` advance), not the stale stranded version, so the re-anchor is durable against the next prune. This self-heal SHALL be confined to the unanchored case: an identical re-ingest of a still-anchored current row SHALL remain a true no-op (it SHALL NOT append a `record_changes` row and SHALL NOT advance `version_counter`), preserving the anti-churn no-op suppression.

#### Scenario: Successful record mutation

- **WHEN** the reference ingests a record whose payload changes durable state
- **THEN** the live `records` row, appended `record_changes` row, and `version_counter` advance SHALL commit as one atomic unit
- **AND** the appended `record_changes.version` SHALL be the version recorded by `version_counter` for that `(connector_id, stream)` after the commit

#### Scenario: No-op re-ingest of an anchored current row

- **WHEN** the reference ingests a record whose durable payload is identical to the current live state AND the current `records` row's anchoring `record_changes` row (at the current row's `version`) is still retained
- **THEN** it SHALL NOT append a `record_changes` row
- **AND** it SHALL NOT advance `version_counter`

#### Scenario: Self-heal re-ingest of an unanchored current row

- **WHEN** the reference ingests a record whose durable payload is identical to the current live state but the current `records` row's anchoring `record_changes` row (at the current row's `version`) has been pruned away, leaving the current row unprovable from retained history
- **THEN** the ingest SHALL allocate a new per-stream version and append a fresh `record_changes` row at that version for the key, re-anchoring the current row
- **AND** it SHALL advance `version_counter` by exactly one
- **AND** the current `records` row's `version` SHALL be updated to the newly allocated version so it matches its fresh anchor
- **AND** the record-count and current-payload byte deltas SHALL be zero (no row added, identical payload), with only the appended history row and any pruned tail reflected in the retained-size and dataset-summary deltas
- **AND** after the heal the current projection for that key SHALL be provable from retained history (no `unresolved_pruned` row remains for it)

#### Scenario: Repeated delete

- **WHEN** the reference receives a delete for a record that is already deleted or absent
- **THEN** it SHALL NOT append a duplicate delete change
- **AND** it SHALL NOT advance `version_counter`

#### Scenario: Durable mutation failure

- **WHEN** an error occurs before the durable ingest mutation commits
- **THEN** the reference SHALL NOT leave `records`, `record_changes`, and `version_counter` in a partially advanced state
- **AND** a later ingest for the same `(connector_id, stream)` SHALL NOT collide with or skip around a partially written version

#### Scenario: Derived index maintenance

- **WHEN** durable record ingest commits successfully
- **THEN** lexical and semantic index maintenance MAY run after the commit as derived maintenance
- **AND** failure in derived index maintenance SHALL NOT retroactively partially commit or roll back the durable record mutation

#### Scenario: History pruning preserves a cold-key anchor while the stream advances

- **WHEN** a current `records` row for a key is at version `V` and unchanged, and other keys advance the per-stream version past `V + PDPP_CHANGE_HISTORY_LIMIT`
- **THEN** the prune step SHALL retain the `record_changes` row at version `V` for that key
- **AND** the current projection for that key SHALL remain provable from retained history (no `unresolved_pruned` row is created by pruning)
- **AND** history for changing keys SHALL still be bounded by `PDPP_CHANGE_HISTORY_LIMIT`

#### Scenario: History pruning preserves a deleted-key tombstone anchor

- **WHEN** a current `records` row is a tombstone at version `V` (the key was deleted) and other keys advance the per-stream version past `V + PDPP_CHANGE_HISTORY_LIMIT`
- **THEN** the prune step SHALL retain the deleted `record_changes` row at version `V` for that key
- **AND** the key SHALL remain in the consistent `(deleted latest history, deleted current)` state, neither resurrected nor orphaned

### Requirement: Public client self-registration SHALL be publicly discoverable

The reference implementation SHALL support public-client self-registration through the advertised dynamic registration endpoint when DCR is enabled.

#### Scenario: Stranger registers a public client

- **WHEN** a third-party client fetches authorization-server metadata
- **AND** DCR is enabled
- **THEN** the metadata SHALL include `registration_endpoint`
- **AND** `pdpp_registration_modes_supported` SHALL include `dynamic`.

#### Scenario: Public registration succeeds

- **WHEN** a third-party client posts supported public-client metadata to `registration_endpoint` without an initial access token
- **THEN** the reference SHALL create a public client with `token_endpoint_auth_method: "none"`
- **AND** the response SHALL include the assigned `client_id`
- **AND** the request SHALL NOT grant data access or mint bearer tokens
- **AND** the reference SHALL emit an auditable `client.registered` spine event.

#### Scenario: Invalid bearer registration is rejected

- **WHEN** a caller posts public-client metadata with an invalid bearer initial-access token
- **THEN** the reference SHALL NOT create a client
- **AND** the reference SHALL return an OAuth `invalid_client` error
- **AND** the reference SHALL emit an auditable `client.register_rejected` spine event.

#### Scenario: Public registration validates metadata strictly

- **WHEN** a public registration request includes unsupported OAuth metadata, confidential-client claims, unsupported auth methods, or malformed URI metadata
- **THEN** the reference SHALL reject the request
- **AND** the error SHALL include request correlation data.

#### Scenario: Public registration is rate limited

- **WHEN** unauthenticated registration attempts exceed the reference rate limit for a request origin
- **THEN** the reference SHALL return HTTP 429
- **AND** the response SHALL include `Retry-After`.

### Requirement: Reference schedules SHALL express desired freshness without causing manual-attention retry storms

Reference schedules SHALL express desired data freshness and launch eligibility for a connection/source. A due schedule SHALL NOT be interpreted as a guarantee that every due instant creates a run.

#### Scenario: Due schedule is blocked by unresolved attention

- **WHEN** a connection schedule becomes due
- **AND** an equivalent unresolved attention request exists for that connection/source
- **THEN** the reference scheduler SHALL NOT start another automatic run for that schedule
- **AND** it SHALL record or expose that the schedule was skipped, paused, or suppressed because owner/operator attention remains unresolved
- **AND** the connection SHALL preserve an explicit operator path to resume, run now, or re-enable automatic scheduling after the attention request is resolved

#### Scenario: Freshness intent remains visible while launch is suppressed

- **WHEN** a schedule is paused or suppressed because owner/operator attention is required
- **THEN** the reference SHALL continue to expose the desired freshness policy separately from the current launch eligibility
- **AND** it SHALL NOT report the connection as fresh merely because automatic launches are suppressed

#### Scenario: Resolved attention does not replay an unbounded schedule backlog

- **WHEN** a schedule has missed one or more due instants while launch was paused or suppressed for owner/operator attention
- **AND** the attention request is resolved or explicitly overridden
- **THEN** the reference SHALL NOT automatically start one run for every missed due instant
- **AND** it SHALL make the schedule eligible for the next normal launch or at most one latest-state catch-up run by default
- **AND** any broader backfill SHALL be explicit, bounded, and available only when the connector declares safe interval semantics

### Requirement: Reference runs SHALL be bounded attempts when owner/operator attention is required

Reference runs SHALL remain bounded execution attempts. A run that discovers a required owner/operator action SHALL finish with a typed waiting-for-operator outcome or equivalent terminal evidence rather than remaining active indefinitely.

#### Scenario: Run creates durable attention evidence

- **WHEN** a run cannot proceed without owner/operator action such as login, OTP, account review, consent, filesystem availability, or device availability
- **THEN** the run SHALL finish as a bounded attempt
- **AND** the reference SHALL create or update a durable typed attention request linked to the connection/source and the run evidence when available
- **AND** the run outcome SHALL be distinguishable from retryable infrastructure failure and terminal connector failure

#### Scenario: Manual attention does not hide partial data state

- **WHEN** a run produces usable data but cannot fully complete without owner/operator action
- **THEN** the reference MAY expose a succeeded-with-gaps outcome
- **AND** it SHALL preserve attention evidence for the missing action
- **AND** it SHALL NOT require another automatic run until the unresolved action is resolved or explicitly overridden

### Requirement: Reference attention requests SHALL be durable, typed, notified, and resumable

The reference SHALL model owner/operator attention as a durable typed request keyed to connection/source and optionally linked to a run. The request SHALL include enough policy state to notify the owner safely, suppress duplicate noise, and resume intentionally.

#### Scenario: Attention request captures the operator contract

- **WHEN** the reference creates or updates an attention request
- **THEN** the request SHALL include a machine-readable reason
- **AND** it SHALL include safe human-readable instructions that do not expose secrets
- **AND** it SHALL include status, creation time, last-observed time, optional expiry or review time, and a resume action or re-enable path
- **AND** it SHALL include notification state and quiet-hour or suppression metadata sufficient to avoid repeated noisy notifications

#### Scenario: Equivalent attention is deduplicated per connection

- **WHEN** repeated attempts encounter the same unresolved owner/operator requirement for a connection/source
- **THEN** the reference SHALL update or reuse the existing attention request instead of creating unbounded duplicate requests
- **AND** suppression for that request SHALL apply only to the affected connection/source unless the operator explicitly chooses a broader scope

### Requirement: Reference notification policy SHALL avoid silent failures and noisy repeats

The reference SHALL surface manual-attention requirements through explicit notification policy. It SHALL avoid both silent suppression and repeated unresolved alerts. Notification delivery state SHALL be persisted on the durable attention record so the operator console can answer "did we tell the owner?" without rereading transport logs.

#### Scenario: Owner is notified with bounded repetition

- **WHEN** a new attention request requires owner/operator action
- **THEN** the reference SHALL mark notification as pending, sent, suppressed, failed, or acknowledged according to delivery outcome
- **AND** the notification state SHALL be a durable axis on the attention record, persisted alongside lifecycle and updated by the notification fanout path even when delivery is short-circuited (channel unavailable, no opted-in subscription, policy-suppressed)
- **AND** repeated notifications for the same unresolved request SHALL be governed by quiet-hour and suppression policy
- **AND** the reference SHALL keep the request visible until it is resolved, expired, or intentionally dismissed

#### Scenario: Notification failure does not cause a run storm

- **WHEN** notification delivery fails for an attention request
- **THEN** the reference SHALL preserve the unresolved attention request and notification failure state
- **AND** the durable attention record SHALL record `notification_state: failed` without changing `lifecycle`, so the projection continues to surface needs_attention
- **AND** it SHALL NOT treat notification failure as permission to repeatedly launch the same scheduled run

#### Scenario: Owner-side acknowledgement is recorded as a notification outcome

- **WHEN** the owner advances an attention prompt past `open` (lifecycle transitions to `acknowledged` or `in_progress`)
- **THEN** the durable notification state SHALL be updated to `acknowledged`
- **AND** the operator console SHALL be able to distinguish "we delivered the push" from "the owner has seen the prompt" without inspecting transport logs

#### Scenario: Operator-visible notification state degrades honestly when evidence is missing

- **WHEN** the projection has no structured attention record and is falling back to the schedule's `human_attention_needed` flag
- **THEN** the operator-visible notification state for that CTA SHALL be null (unknown)
- **AND** the dashboard SHALL NOT fabricate a `sent`/`pending` claim that the durable evidence cannot support

### Requirement: Reference local collector scheduling SHALL remain host-supervisor-owned

The reference SHALL keep server schedule policy separate from local collector host supervision. Server-side schedule intent MAY inform local collector diagnostics or prompts, but it SHALL NOT claim control over host-local timing, filesystem availability, or device wake behavior.

#### Scenario: Local collector requires host action

- **WHEN** a local collector cannot run because the device, filesystem, credentials, or host supervisor requires action
- **THEN** the reference MAY create or expose an attention request or diagnostic
- **AND** server schedules SHALL NOT repeatedly launch remote attempts that cannot control the local host condition
- **AND** the remediation path SHALL identify the local collector or host supervisor as the action owner

### Requirement: Annotated routes SHALL attach reference-contract manifests at registration
The reference implementation SHALL look up the `@pdpp/reference-contract` manifest for every HTTP route mounted with a `{ contract: '<operation id>' }` annotation. The lookup SHALL run at route registration so drift between the server and the contract package fails fast rather than silently.

#### Scenario: Unknown contract operation id
- **WHEN** a route is mounted with a `{ contract }` operation id that is not exported by `@pdpp/reference-contract`
- **THEN** the reference implementation SHALL throw at route registration
- **AND** SHALL identify the unknown operation id in the error message.

### Requirement: Allowlisted contract routes SHALL enforce request contracts at runtime
The reference implementation SHALL maintain an explicit allowlist of reference-contract operation ids whose annotated routes have transport-level request validation enforced. Validation SHALL use the shared reference-contract schemas rather than server-local duplicate schemas. The allowlist SHALL be defined in the server transport/adapter layer and SHALL NOT be inferred from the manifest alone.

#### Scenario: Malformed request on an allowlisted contract route
- **WHEN** a caller sends a request whose params, query, headers, or body violate the route's declared reference-contract request schema, and the route's operation id is in the request-validation allowlist
- **THEN** the reference implementation SHALL reject the request before the route handler mutates state or serves data
- **AND** the rejection SHALL use a structured error envelope with a request id, picking an OAuth-shaped or PDPP-shaped envelope based on the route manifest's declared 400 response schema.

#### Scenario: Protected route validation ordering
- **WHEN** an unauthenticated caller sends a malformed request to an allowlisted protected contract route
- **THEN** authentication SHALL run before request-shape validation
- **AND** the response SHALL remain an authentication failure rather than leaking contract validation details.

### Requirement: Non-allowlisted contract routes SHALL preserve handler-owned diagnostics
The reference implementation SHALL NOT pre-empt handler-owned rejection diagnostics on annotated routes that are outside the request-validation allowlist. Handler-emitted error codes (OAuth `invalid_client_metadata`, PDPP `invalid_status`, etc.), structured `param` hints, reference trace ids, and spine events such as `client.register_rejected` SHALL remain observable for malformed input.

#### Scenario: Malformed request on a non-allowlisted contract route
- **WHEN** a caller sends a request that violates the declared request schema on an annotated route NOT in the request-validation allowlist
- **THEN** the transport SHALL pass the request through to the route handler
- **AND** any handler-emitted error code, message, `param` hint, reference trace id, or spine event SHALL remain observable to clients and to `trace show`.

### Requirement: Response validation SHALL be explicit and non-mutating
The reference implementation SHALL validate JSON responses only for routes explicitly enrolled in a response-validation allowlist. Response validation SHALL inspect the payload the handler intends to send and SHALL NOT serialize, strip, coerce, or otherwise transform the response.

#### Scenario: Canary response violates its schema
- **WHEN** an allowlisted contract route attempts to send a JSON response that violates its declared response schema
- **THEN** the reference implementation SHALL fail closed with a server-side contract error
- **AND** it SHALL NOT send the invalid payload as if it matched the contract.

#### Scenario: Non-JSON or non-allowlisted response
- **WHEN** a route sends a redirect, 204 response, binary body, stream, server-sent event, or a JSON response from a route not yet in the response-validation allowlist
- **THEN** response validation SHALL NOT transform or strip that response
- **AND** broader response validation SHALL require explicit enrollment after schema exactness is proven.

### Requirement: Route contract validation SHALL remain a transport boundary
Runtime route-contract validation SHALL live in the transport/HTTP adapter layer. Operation modules SHALL remain framework-independent and SHALL NOT import the reference-contract package solely to validate HTTP wire shapes.

#### Scenario: Operation boundary remains pure
- **WHEN** a route delegates to a canonical operation module
- **THEN** request and response validation SHALL be applied by the host adapter around the operation
- **AND** the operation module SHALL remain free of Fastify, Express, concrete storage, and reference-contract runtime dependencies.

### Requirement: Source webhook ingress is reference-only and source-authenticated

The reference implementation SHALL expose source webhook ingress only as reference-runtime behavior at `POST /_ref/source-webhooks/:sourceId` on the RS application only. It SHALL NOT register the ingress route on the AS application. It SHALL NOT advertise source webhooks as core PDPP support, SHALL NOT add event-driven grant semantics, and SHALL NOT accept source callbacks authenticated with owner bearer tokens, client grant tokens, or local collector device credentials.

The ingress route SHALL NOT appear in `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, or any other public PDPP metadata endpoint.

When no per-source HMAC secret is configured for a given `sourceId`, the reference SHALL return HTTP 404 with error code `unknown_source`. The endpoint is active only for source ids present in the operator-configured secret map (`PDPP_SOURCE_WEBHOOK_SECRETS`).

#### Scenario: A source callback reaches the reference ingress endpoint
- **WHEN** a caller posts a source webhook callback to `POST /_ref/source-webhooks/:sourceId`
- **THEN** the reference SHALL authenticate the callback with the per-source HMAC credential before processing the body
- **AND** the reference SHALL reject missing, malformed, stale, or invalid signatures before mutating records or scheduler state

#### Scenario: Metadata is requested
- **WHEN** a client reads public PDPP metadata from `/.well-known/oauth-protected-resource` or `/.well-known/oauth-authorization-server`
- **THEN** the reference SHALL NOT advertise the reference source webhook endpoint as a public PDPP capability

#### Scenario: Owner or client session credentials are presented
- **WHEN** a caller posts to `POST /_ref/source-webhooks/:sourceId` with a valid owner-session cookie, owner bearer token, or client grant bearer token
- **THEN** the reference SHALL NOT use those credentials to authenticate the webhook callback
- **AND** the reference SHALL authenticate only via the `PDPP-Webhook-Signature` header against the configured per-source HMAC secret

#### Scenario: The source is not configured
- **WHEN** the request identifies all required source-webhook headers
- **AND** no per-source HMAC secret is configured for the given `sourceId`
- **THEN** the reference SHALL return HTTP 404 with error code `unknown_source` before performing any signature or timestamp check

### Requirement: Source webhook ingress uses a PDPP-specific signed envelope

The reference implementation SHALL authenticate source webhook callbacks using three required request headers with a defined signing scheme.

Required headers:

| Header | Format | Purpose |
|---|---|---|
| `PDPP-Webhook-Timestamp` | Decimal integer string of Unix epoch seconds | Replay-protection timestamp |
| `PDPP-Webhook-Event-Id` | Non-empty opaque string | Idempotency key component |
| `PDPP-Webhook-Signature` | `sha256=<lowercase-hex>` | HMAC-SHA256 authenticity |

The signed material SHALL be `"${timestamp}.${body}"` where `timestamp` is the value of the `PDPP-Webhook-Timestamp` header and `body` is the raw UTF-8 request body. The expected signature SHALL be `sha256=` followed by the lowercase hex encoding of `HMAC-SHA256(secret, signed_material)` where `secret` is the per-source HMAC secret. Signature comparison SHALL use a timing-safe equality check.

HTTP header names are case-insensitive. The header names above are the canonical documentation casing; adapters MAY receive or normalize them in lowercase.

These header names are intentionally PDPP-prefixed rather than the Standard Webhooks v1 names (`webhook-id`, `webhook-timestamp`, `webhook-signature`). Standard Webhooks v1 is the right choice for the outbound client-event-subscription delivery direction (where the reference is the sender). Source webhook ingress is the receiver direction: the reference accepts callbacks from source platforms with their own signing schemes, and standardizing inbound header names would require every source platform to adopt PDPP header names. PDPP-prefixed names correctly signal that this is a reference-specific adapter contract, not a PDPP Core protocol surface.

#### Scenario: All required headers are present and signature matches
- **WHEN** a caller posts a request with valid `PDPP-Webhook-Timestamp`, `PDPP-Webhook-Event-Id`, and `PDPP-Webhook-Signature` headers
- **AND** the signature matches `sha256=hex(HMAC-SHA256(secret, "${timestamp}.${body}"))` using the configured per-source secret
- **AND** the timestamp is within the accepted tolerance window
- **THEN** the reference SHALL proceed to idempotency checking and payload processing

#### Scenario: A required header is absent or blank
- **WHEN** any of `PDPP-Webhook-Timestamp`, `PDPP-Webhook-Event-Id`, or `PDPP-Webhook-Signature` is absent or blank
- **THEN** the reference SHALL reject the request with HTTP 401 before processing the body
- **AND** the error code SHALL identify which header is missing (`missing_timestamp`, `missing_event_id`, or `missing_signature`)

#### Scenario: The signature does not match
- **WHEN** the `PDPP-Webhook-Signature` header is present but does not match the expected HMAC for the given body, timestamp, and per-source secret
- **THEN** the reference SHALL reject the request with HTTP 401 and error code `invalid_signature`

### Requirement: Source webhook ingress enforces a timestamp tolerance window

The reference implementation SHALL reject callbacks whose `PDPP-Webhook-Timestamp` value, when interpreted as Unix epoch seconds, differs from the server's current wall-clock time by more than 300 seconds (5 minutes). Timestamp rejection SHALL occur after required-header validation and per-source secret resolution, and before signature verification.

#### Scenario: The timestamp is within the tolerance window
- **WHEN** `abs(server_time_seconds - timestamp_seconds) <= 300`
- **THEN** the reference SHALL proceed to HMAC signature verification

#### Scenario: The timestamp is outside the tolerance window
- **WHEN** `abs(server_time_seconds - timestamp_seconds) > 300`
- **THEN** the reference SHALL reject the request with HTTP 401 and error code `stale_timestamp`
- **AND** the reference SHALL NOT perform HMAC signature verification or body parsing for that request

### Requirement: Source webhook ingress prevents replay before mutation

The reference implementation SHALL persist an idempotency decision for each accepted source webhook event before applying record mutations or scheduler signals. The idempotency key SHALL be the composite `(source_id, event_id)` where `event_id` is the value of the `PDPP-Webhook-Event-Id` header. The persistence layer SHALL enforce a `UNIQUE(source_id, event_id)` constraint so that concurrent or retried deliveries of the same event are serialized at the storage layer.

#### Scenario: A new event is received
- **WHEN** the `(sourceId, eventId)` pair has not been previously accepted
- **THEN** the reference SHALL insert an idempotency record before executing ingest or scheduler operations
- **AND** record mutations or scheduler signals SHALL execute only after the idempotency record is durably committed

#### Scenario: A duplicate source event is received
- **WHEN** a source webhook event with a previously accepted `(sourceId, eventId)` pair is received again
- **THEN** the reference SHALL return HTTP 202 with `{ "accepted": true, "duplicate": true, "source_id": "...", "event_id": "..." }`
- **AND** the reference SHALL NOT reapply record mutations or scheduler signals for that event

### Requirement: Source webhook ingress error codes and HTTP statuses are enumerated

The reference implementation SHALL return the following error codes and HTTP status codes for authentication, replay, and payload failures at the source webhook ingress endpoint:

| Error code | HTTP status | Trigger condition |
|---|---|---|
| `missing_event_id` | 401 | `PDPP-Webhook-Event-Id` header absent or blank |
| `missing_timestamp` | 401 | `PDPP-Webhook-Timestamp` header absent or blank |
| `missing_signature` | 401 | `PDPP-Webhook-Signature` header absent or blank |
| `unknown_source` | 404 | No HMAC secret configured for the given `sourceId` |
| `stale_timestamp` | 401 | Timestamp is outside the +/-5-minute tolerance window |
| `invalid_signature` | 401 | HMAC-SHA256 mismatch |
| `invalid_payload` | 400 | Body is not a JSON object, `action` value is not recognized, or required fields for the stated `action` are missing |

All error responses SHALL use the reference's standard PDPP error envelope. Auth and replay failures SHALL return 401 rather than 403 to avoid revealing credential presence to unauthenticated callers. The `unknown_source` 404 is intentional: a wrong `sourceId` in the URL is a diagnosable operator misconfiguration, and source ids are not secret.

#### Scenario: An auth or replay failure is returned
- **WHEN** a webhook callback fails for any authentication or replay reason
- **THEN** the HTTP response SHALL use the error code and HTTP status from the table above
- **AND** the response body SHALL use the reference's standard PDPP error envelope

#### Scenario: A payload error is returned
- **WHEN** the callback passes authentication and replay checks but the body is malformed, unrecognized, or missing required fields
- **THEN** the reference SHALL return HTTP 400 with error code `invalid_payload`

### Requirement: Source webhook ingress supports two payload action values

The reference implementation SHALL accept source webhook payloads with one of two `action` values: `ingest_records` and `schedule_run`. Any other `action` value SHALL cause the reference to return HTTP 400 with error code `invalid_payload`.

**`action: "ingest_records"`** - push records into the reference's existing record-ingest path. Required additional fields:
- `stream` - non-empty string identifying the target stream declared in the connector manifest.
- `records` - array of record objects to ingest.

Records SHALL be serialized as NDJSON and passed to the existing record-ingest operation (`rs.records.ingest`). The webhook path SHALL NOT bypass stream lookup, record validation, tombstone behavior, versioning, indexing, or grant-visible query behavior.

**`action: "schedule_run"`** - request a connector refresh. No additional fields are required. The request SHALL be classified through the shared automation policy model with `trigger_kind: "webhook"`. The run SHALL be started only if the automation policy resolves `allowed_to_start: true`. If the runtime controller is unavailable, the reference SHALL fall back to signaling the scheduler's last-run-time record.

#### Scenario: A signed record-push callback is accepted
- **WHEN** an authenticated source callback carries `{ "action": "ingest_records", "stream": "<name>", "records": [ ... ] }`
- **THEN** the reference SHALL process those records through the existing `rs.records.ingest` operation for the connector bound to that `sourceId`
- **AND** the response SHALL include `records_accepted` and `records_rejected` counts from that operation

#### Scenario: `ingest_records` is missing required fields
- **WHEN** an authenticated source callback carries `"action": "ingest_records"` but `stream` is absent or blank, or `records` is not an array
- **THEN** the reference SHALL return HTTP 400 with error code `invalid_payload`

#### Scenario: A signed run-trigger callback is accepted and automation policy permits the run
- **WHEN** an authenticated source callback carries `{ "action": "schedule_run" }` and the automation policy resolves `allowed_to_start: true`
- **THEN** the reference SHALL request a connector refresh with `trigger_kind: "webhook"` for the connector bound to that `sourceId`
- **AND** the webhook handler SHALL NOT start the connector run outside the shared automation policy model
- **AND** when the runtime controller is unavailable, the reference SHALL fall back to signaling the scheduler's last-run-time record instead of dropping the request

#### Scenario: Automation policy blocks the run
- **WHEN** an authenticated source callback carries `{ "action": "schedule_run" }` but the automation policy resolves `allowed_to_start: false`
- **THEN** the reference SHALL return HTTP 200 with `{ "action": "schedule_run", "run": null, "automation_policy": { ... } }`
- **AND** the automation policy result SHALL be included in the response body for operator diagnostics

### Requirement: Reference control-plane reads and mutations require owner session when enabled
The reference implementation SHALL require the placeholder owner session on reference-only `_ref` read and mutation routes when owner auth is enabled. When owner auth is disabled, the reference implementation SHALL preserve the current open local-dev behavior for those routes.

#### Scenario: Owner auth is enabled and a read has no session
- **WHEN** a caller submits a `_ref` read request without a valid owner-session cookie or accepted owner credential while `PDPP_OWNER_PASSWORD` is configured
- **THEN** the reference SHALL reject the request with `401 owner_session_required`
- **AND** the route handler SHALL NOT disclose the requested reference state

#### Scenario: Owner auth is enabled and a read has a session
- **WHEN** a caller submits a `_ref` read request with a valid owner-session cookie or accepted owner credential while `PDPP_OWNER_PASSWORD` is configured
- **THEN** the reference SHALL return the route's existing response according to its current behavior

#### Scenario: Owner auth is enabled and a mutation has no session
- **WHEN** a caller submits a `_ref` mutation request without a valid owner-session cookie or accepted owner credential while `PDPP_OWNER_PASSWORD` is configured
- **THEN** the reference SHALL reject the request with `401 owner_session_required`
- **AND** the route handler SHALL NOT perform the requested mutation

#### Scenario: Owner auth is enabled and a mutation has a session
- **WHEN** a caller submits a `_ref` mutation request with a valid owner-session cookie or accepted owner credential while `PDPP_OWNER_PASSWORD` is configured
- **THEN** the reference SHALL process the mutation according to the route's existing behavior

#### Scenario: Owner auth is disabled
- **WHEN** a caller submits a `_ref` read or mutation request while placeholder owner auth is disabled
- **THEN** the reference SHALL preserve the open local-dev behavior for that route

### Requirement: Disclosure Spine Timeline Pagination

The reference implementation SHALL paginate disclosure-spine timelines with a stable logical event ordering. Cursor tokens SHALL NOT depend on SQLite `rowid` or another backend-private physical row identity.

#### Scenario: Tied timestamps remain stable

**WHEN** multiple disclosure-spine events in the same timeline have identical `occurred_at` timestamps
**THEN** paginated reads SHALL return each event exactly once in stable append order
**AND** a cursor returned by one page SHALL resume after the last event served by that page.

#### Scenario: Cursor remains backend-portable

**WHEN** the reference implementation encodes a disclosure-spine timeline cursor
**THEN** the cursor SHALL be opaque to clients
**AND** the decoded cursor state SHALL refer only to stable logical ordering fields, not SQLite physical row identity.

### Requirement: The reference SHALL expose an owner/operator-only record-derived-field repair tool

The reference implementation SHALL provide an owner/operator-only operational tool that repairs current `records` rows whose payload is byte-equivalent (per the No-op equivalence definition above) — *after removing the policy's registered derived fields from both sides* — to a prior `record_changes` row that carries strictly more complete derived fields, under a per-stream repair policy that is registered in code.

The tool SHALL be authorized by direct database access (`PDPP_DATABASE_URL`), not by an HTTP route or scheduler. It SHALL refuse to run without an explicit `(connector_instance_id, stream)` scope. It SHALL default to a dry-run mode that prints the records that would be repaired, the prior `record_changes.version` each refill would be sourced from, and the field set each refill would write. It SHALL NOT mutate any row without an explicit `--apply` flag. It SHALL NOT mutate or delete any existing `record_changes` row. It SHALL allocate any repair write through the existing atomic allocator so the repair itself is observable in `record_changes` and `changes_since`. It SHALL validate `--limit` (if supplied) as a positive integer and refuse to run otherwise.

The tool SHALL apply an equivalence guard: before treating a prior `record_changes` row as a refill source, the tool SHALL compare the current row's payload to that prior row's payload with every field in the policy's `derivedFields` removed from both sides, using jsonb structural equality. A prior row whose normalised payload is not equal to the current row's normalised payload SHALL NOT be used as a refill source even if some of its derived fields are non-null.

The tool SHALL NOT operate across distinct `(connector_instance_id, stream, record_key)` boundaries. It SHALL NOT operate on streams without a registered repair policy.

#### Scenario: Dry-run preview lists repairable rows

- **WHEN** the operator invokes the repair tool in dry-run mode for a `(connector_instance_id, stream)` scope where some current rows have byte-equivalent prior history with more complete derived fields
- **THEN** the tool SHALL print one preview line per repairable record with the source `record_changes.version` and the field set that would be refilled
- **AND** the tool SHALL NOT change any row, allocate any version, or append any `record_changes` row

#### Scenario: Apply repairs as new versions

- **WHEN** the operator invokes the repair tool with `--apply` against a scope that contains repairable rows
- **THEN** for each repaired record the tool SHALL allocate a new version through the atomic allocator and append exactly one `record_changes` row reflecting the merged derived fields
- **AND** the prior `record_changes` history rows SHALL remain byte-identical

#### Scenario: Repair refuses streams without a policy

- **WHEN** the operator invokes the repair tool against a `(connector_instance_id, stream)` pair whose stream has no registered repair policy
- **THEN** the tool SHALL refuse to run and SHALL exit non-zero with a message naming the missing policy

#### Scenario: Equivalence guard rejects a prior row whose non-derived fields have changed

- **WHEN** the operator runs the repair tool on a record whose current row has null derived fields, but the candidate prior `record_changes` row differs from the current row in some field outside the policy's `derivedFields`
- **THEN** the tool SHALL NOT use that prior row as a refill source
- **AND** if no other candidate prior row satisfies the equivalence guard, the record SHALL be skipped (no version allocated, no `record_changes` row appended)

### Requirement: Retained-size reads SHALL expose bounded logical-byte measures

The reference implementation SHALL expose owner-only retained-size reads as
typed logical-byte measures over finite, bounded grains.

#### Scenario: Retained-size measures are explicit

- **WHEN** a retained-size row is returned
- **THEN** it SHALL label current record JSON bytes, record-history JSON bytes,
  blob bytes, total retained bytes, record count, and blob count separately
- **AND** `total_retained_bytes` SHALL be the server-computed sum of the
  logical retained-byte categories for that row.

#### Scenario: Physical storage is not confused with retained data size

- **WHEN** the implementation exposes database physical storage metrics
- **THEN** those metrics SHALL be labeled separately from retained logical
  bytes
- **AND** retained-size reads SHALL NOT use physical table or index size as the
  owner-facing retained data measure.

#### Scenario: Retained-size grains are finite

- **WHEN** retained-size rows are requested
- **THEN** supported grains SHALL be limited to global dataset, connection, and
  stream unless a later capability adds a manifest-authored record-family
  classifier
- **AND** the implementation SHALL NOT accept arbitrary JSON-path group-bys or
  ad hoc dimensions in this capability
- **AND** it SHALL NOT advertise a record-family grain until rebuild and
  incremental maintenance populate that grain from a real bounded
  classification source.

#### Scenario: Connection grain uses connector instance identity

- **WHEN** a retained-size row represents an owner-facing connection
- **THEN** the row SHALL be keyed by `connector_instance_id`
- **AND** stream and record-family rows SHALL remain attributable to that
  connection.

#### Scenario: Future record-family values are bounded

- **WHEN** a connector emits or classifies a record-family value for
  retained-size grouping
- **THEN** the value SHALL be drawn from a bounded connector-authored or
  manifest-authored set
- **AND** unauthored free-form record content SHALL NOT become a retained-size
  dimension label.

### Requirement: Retained-size top-N rows SHALL be bounded drill-down aids

The reference implementation SHALL support bounded top-N retained-size rows for
owner introspection without introducing an ad hoc query engine.

#### Scenario: Top-N rows are capped

- **WHEN** an owner requests retained-size top-N rows
- **THEN** the response SHALL cap the result count server-side
- **AND** it SHALL reject or clamp unsupported limits, scopes, measures, and
  bucket kinds.

#### Scenario: Top-N rows contain identifiers not payloads

- **WHEN** a retained-size top-N row identifies a large connection, stream,
  record, or blob
- **THEN** it SHALL contain the identifiers needed for drill-down
- **AND** it SHALL NOT include raw connector payloads, credentials, cookies,
  interaction answers, or arbitrary record text.

#### Scenario: Top-N freshness is honest

- **WHEN** top-N rows are stale, approximate, rebuilding, or failed
- **THEN** the response SHALL expose metadata sufficient for the dashboard to
  avoid presenting those rows as fresh exact truth.

### Requirement: The dashboard summary stream rows are exposed as a reference-only read
The reference implementation SHALL expose the per-`(connector_id, stream)` rows already maintained by the dataset-summary read model as a reference-only read endpoint so the dashboard can render a per-stream retained-size breakdown without re-scanning canonical records, record changes, or blobs.

#### Scenario: The endpoint returns every projection row
- **WHEN** an authorized owner requests `GET /_ref/dataset/summary/streams` with no query parameters
- **THEN** the reference SHALL return one row per `(connector_id, stream)` from the dataset-summary stream projection
- **AND** each row SHALL carry `connector_id`, `stream`, `record_count`, `record_json_bytes`, `earliest_ingested_at`, `latest_ingested_at`, `earliest_record_time`, `latest_record_time`, `computed_at`, and `dirty_record_time_bounds`
- **AND** the response SHALL be bounded by the projection rows rather than by the size of the canonical records substrate
- **AND** the response envelope SHALL carry the same projection-freshness metadata block (`computed_at`, `state`, `stale_since`, `rebuild_status`, `last_error`, optional `source_high_watermark`) that `GET /_ref/dataset/summary` exposes

#### Scenario: The optional connector_id filter narrows the response
- **WHEN** an authorized owner requests `GET /_ref/dataset/summary/streams?connector_id=<id>`
- **THEN** the reference SHALL return only the projection rows whose `connector_id` matches the supplied value
- **AND** the response envelope SHALL still carry the same projection-freshness metadata block, unchanged by the filter
- **AND** an empty result set SHALL be returned as an empty `streams` array rather than as a 404

#### Scenario: NULL and dirty time bounds are surfaced honestly
- **WHEN** a projection row has no manifest-declared `consent_time_field`, has never been reconciled, or carries the dirty-bound flag set
- **THEN** `earliest_record_time` and `latest_record_time` SHALL be returned as `null` for that row rather than zero-filled, empty-string, or fabricated values
- **AND** `dirty_record_time_bounds` SHALL be returned as a boolean indicating whether the projection believes the record-time bounds are no longer trustworthy
- **AND** the dashboard SHALL be able to distinguish a row whose record-time bounds are honestly unknown from a row whose bounds are known and fresh

#### Scenario: The endpoint stays an owner-gated reference-only surface
- **WHEN** the reference implementation mounts `GET /_ref/dataset/summary/streams`
- **THEN** that route SHALL be gated by the same owner-session check that gates `GET /_ref/dataset/summary`
- **AND** that route SHALL remain documented as a reference-only read surface rather than as a public PDPP API

### Requirement: The Postgres records backend hydrates manifest-declared one-hop relationship expansions

The reference implementation's Postgres records backend SHALL implement the
same grant-scoped one-hop parent → child relationship expansion contract
already provided by the SQLite backend. When a caller requests `expand[]`
on a Postgres deployment, the backend SHALL fetch declared child records,
project them through the child grant, and attach them to the parent
response page rather than rejecting or silently ignoring the request.

#### Scenario: A Postgres deployment hydrates a manifest-declared `has_many` relation

- **WHEN** a client calls `queryRecords` with `expand=recently_played` and `expand_limit[recently_played]=1` against a Postgres-backed deployment
- **AND** the grant covers both `saved_tracks` and `recently_played`
- **AND** the parent record has more than one matching child
- **THEN** the response SHALL include each parent record with an `expanded.recently_played` object
- **AND** `expanded.recently_played.object` SHALL be `'list'`
- **AND** `expanded.recently_played.data` SHALL contain exactly one child record
- **AND** `expanded.recently_played.has_more` SHALL be `true`
- **AND** the response envelope SHALL match the shape the SQLite backend returns for the same request.

#### Scenario: A Postgres deployment hydrates a `has_one` relation

- **WHEN** a client calls `queryRecords` with `expand=message_bodies` against a Postgres-backed deployment
- **AND** the grant covers both `messages` and `message_bodies`
- **THEN** each parent record SHALL include `expanded.message_bodies` set to the matching single child record
- **OR** to `null` when no matching child exists
- **AND** the child SHALL be projected through the child grant's `fields` selection.

#### Scenario: Single-record fetch honors expand on Postgres

- **WHEN** a client calls `getRecord` with `expand=recently_played` and `expand_limit[recently_played]=1` against a Postgres-backed deployment
- **THEN** the response SHALL include `expanded.recently_played` with the same shape as the list endpoint.

### Requirement: Postgres expansion enforces child grant scope, projection, and isolation

The Postgres expansion path SHALL enforce the same authorization and
isolation invariants the SQLite path enforces. Children outside the
child grant's `time_range`, `resources`, or connector-instance scope
SHALL NOT appear in the expanded payload. Fields outside the child
grant's `fields` selection SHALL NOT appear on expanded child records.

#### Scenario: Expansion without the child stream grant is rejected

- **WHEN** a client calls `queryRecords` with `expand=recently_played` against a Postgres-backed deployment
- **AND** the grant covers `saved_tracks` but not `recently_played`
- **THEN** the call SHALL throw with `error.code === 'insufficient_scope'`.

#### Scenario: Child rows from other connector instances are not visible

- **WHEN** two distinct connector instances on the same Postgres database have records for the same stream pair
- **AND** a client expands a relation on one connector instance's parent record
- **THEN** the expanded payload SHALL contain only child records owned by the same connector instance as the parent
- **AND** SHALL NOT contain child records from the other connector instance.

#### Scenario: Child field projection respects the grant

- **WHEN** a client expands a relation and the child grant restricts `fields` to a subset
- **THEN** the expanded child records' `data` object SHALL contain only the granted fields, plus any required-by-schema fields the SQLite path includes
- **AND** SHALL NOT include any fields outside the grant.

### Requirement: Postgres expansion validates the request shape with the same parser as SQLite

The Postgres expansion path SHALL use the same `normalizeExpandRequest`
parser the SQLite expansion path uses, so the accepted request shape,
the allowlist of relations, the cardinality constraints on
`expand_limit`, the nested-expansion rejection, and the default/max
limit enforcement remain identical across backends. The parser is
extracted to a shared `record-expand-helpers.js` module so both backends
import from one source of truth.

#### Scenario: Unsupported relation name returns `invalid_expand`

- **WHEN** a client calls `queryRecords` with `expand=not_a_relation` against a Postgres-backed deployment
- **THEN** the call SHALL throw with `error.code === 'invalid_expand'`.

#### Scenario: `expand_limit` on a `has_one` relation returns `invalid_expand`

- **WHEN** a client calls `expand=message_bodies&expand_limit[message_bodies]=2` against a Postgres-backed deployment
- **AND** `message_bodies` is declared as `has_one`
- **THEN** the call SHALL throw with `error.code === 'invalid_expand'`.

#### Scenario: `expand_limit` value above the manifest `max_limit` returns `invalid_expand`

- **WHEN** a client calls `expand=recently_played&expand_limit[recently_played]=9999` against a Postgres-backed deployment
- **AND** the manifest declares `max_limit: 50` for `recently_played`
- **THEN** the call SHALL throw with `error.code === 'invalid_expand'`.

### Requirement: Postgres expansion is incompatible with `changes_since`

The Postgres expansion path SHALL preserve the SQLite contract that
`expand[]` cannot be combined with `changes_since`. Requests carrying
both SHALL reject with `invalid_expand` before any SQL runs.

#### Scenario: `expand` with `changes_since` is rejected on Postgres

- **WHEN** a client calls `queryRecords` with `expand=recently_played` and `changes_since=beginning` against a Postgres-backed deployment
- **THEN** the call SHALL throw with `error.code === 'invalid_expand'`.

### Requirement: Postgres expansion rejects unsafe manifest JSON fields before SQL interpolation

The Postgres expansion path SHALL re-validate every manifest-declared
JSON field used to build SQL (`foreign_key`, `primary_key`,
`cursor_field`, `consent_time_field`) against the shared
`SAFE_JSON_FIELD` regex before any value is interpolated into a query.
Fields that fail the regex SHALL cause the request to reject before any
SQL is sent.

#### Scenario: A child stream missing from the manifest rejects the expansion

- **WHEN** a client requests an `expand` whose declared child stream is not present in `manifest.streams`
- **THEN** the call SHALL throw with `error.code === 'invalid_expand'`.

#### Scenario: A child stream with a multi-part primary key rejects the expansion

- **WHEN** a client requests an `expand` whose declared child stream uses a multi-column `primary_key`
- **THEN** the call SHALL throw with `error.code === 'invalid_expand'` — mirroring the SQLite path's first-party-only `primary_key: ['id']` constraint.

### Requirement: First-party expansion declarations are conservative and grant-safe

First-party connector manifests SHALL enable `query.expand` only for relations that the current reference engine can serve as one-hop parent-to-child expansions with child grant projection.

#### Scenario: A safe child collection is expanded

- **WHEN** a first-party stream declares `query.expand` for a has-many child collection
- **AND** the child stream has a top-level foreign key referencing the parent record key
- **AND** the caller's grant includes both parent and child streams
- **THEN** record list and detail responses MAY include the child records under `expanded.<relation>`
- **AND** the child records SHALL be projected according to the child stream grant.

#### Scenario: A child stream is not granted

- **WHEN** a caller requests an enabled expansion but the grant does not include the related child stream
- **THEN** the reference SHALL reject the request with insufficient scope rather than silently omitting or partially hydrating the relation.

#### Scenario: A tempting reverse relation is present

- **WHEN** a relation requires looking up a parent or sibling from a foreign key on the current record
- **THEN** first-party manifests SHALL NOT enable it through `query.expand` until a reverse/belongs-to relation contract is specified and tested.

### Requirement: First-party binary streams hydrate through the reference blob substrate

The reference implementation SHALL use its existing blob substrate for first-party connector streams that collect binary file content. A connector that hydrates source bytes SHALL store those bytes through the reference blob storage seam and SHALL expose them to clients through a record `blob_ref` decorated with `fetch_url` at read time.

#### Scenario: A connector hydrates a file-like record

- **WHEN** a first-party connector successfully collects bytes for a file-like record
- **THEN** the connector SHALL emit a record that references the stored bytes through `data.blob_ref`
- **AND** the reference SHALL serve those bytes through `GET /v1/blobs/{blob_id}` under the existing blob authorization rules
- **AND** the reference SHALL NOT require clients to construct stream-specific `/content`, `/download`, or equivalent byte URLs

#### Scenario: A connector cannot hydrate bytes

- **WHEN** a first-party connector can describe a file-like source object but cannot safely collect its bytes
- **THEN** the connector SHALL preserve the metadata record
- **AND** the record SHALL expose a non-secret hydration status or equivalent manifest-declared field that lets clients distinguish hydrated and metadata-only records
- **AND** the connector SHALL NOT fabricate a `blob_ref` for bytes it did not store

#### Scenario: A client lacks blob field visibility

- **WHEN** a caller can read a file-like record but the grant projection does not include the record's `blob_ref` field
- **THEN** the reference SHALL NOT expose a usable blob `fetch_url`
- **AND** `GET /v1/blobs/{blob_id}` SHALL remain unauthorized unless some visible record exposes that blob reference under the caller's grant

#### Scenario: A visible blob is served with private cache semantics

- **WHEN** a caller fetches a visible blob through `GET /v1/blobs/{blob_id}`
- **THEN** the response SHALL include `Content-Type`, `Content-Length`, and `Cache-Control: private, no-store`
- **AND** a `HEAD /v1/blobs/{blob_id}` request under the same grant SHALL return the same status and metadata headers without a response body

### Requirement: First-party blob hydration coverage stays auditable

The reference implementation SHALL keep first-party blob hydration coverage auditable by classifying shipped connector streams that may contain collectible binary content.

#### Scenario: A first-party connector has binary-capable streams

- **WHEN** a shipped first-party connector stream can contain source file bytes, attachments, statements, receipts, exports, or uploaded files
- **THEN** the implementation work SHALL classify that stream as hydrated, metadata-only, deferred, or not applicable
- **AND** the classification SHALL document the reason when hydration is not implemented

#### Scenario: Blob hydration expands to a new stream

- **WHEN** blob hydration support is added to another first-party stream
- **THEN** tests SHALL prove that connector output can produce a visible `blob_ref.fetch_url`
- **AND** tests SHALL prove that byte fetch is grant-safe through `GET /v1/blobs/{blob_id}`

### Requirement: Reference dashboard SHALL scope Search to spine artifact jumps

The reference dashboard's `/dashboard/search` surface SHALL be a spine
artifact lookup utility for traces, grants, and runs (and any future spine
artifact families served by `GET /_ref/search`). It SHALL NOT render an
owner-token record content search section. Record content search SHALL be
the responsibility of `/dashboard/explore` only. This requirement governs
the dashboard's consumption of the public retrieval endpoints; it SHALL NOT
modify any RS or `_ref` read contract.

#### Scenario: Search renders artifact buckets only

- **WHEN** an authenticated operator visits `/dashboard/search?q=<query>` with `jump=0`
- **THEN** the page SHALL render artifact buckets (traces, grants, runs) returned by `GET /_ref/search`
- **AND** the page SHALL NOT render a record-results section, retrieval-state notice, semantic uplift badge, or hybrid retrieval badge
- **AND** the page SHALL NOT call `GET /v1/search`, `GET /v1/search/hybrid`, or `GET /v1/search/semantic`

#### Scenario: Free-text submit redirects to Explore

- **WHEN** an authenticated operator submits a non-empty `q` to `/dashboard/search` without `jump=0` and the query does not resolve to a spine artifact id
- **THEN** the page SHALL redirect to `/dashboard/explore?q=<query>` so record content search happens on one surface
- **AND** the redirect SHALL preserve the URL-encoded query exactly
- **AND** the empty-state copy SHALL link to `/dashboard/explore` so operators discover the record search surface without needing to know about the redirect

#### Scenario: Exact-id jump still resolves through Search

- **WHEN** an authenticated operator submits a query that exactly matches a known trace, grant, or run id on `/dashboard/search` with `jump=1`
- **THEN** the page SHALL redirect to that artifact's canonical detail route (`/dashboard/traces/<id>`, `/dashboard/grants/<id>`, or `/dashboard/runs/<id>`)
- **AND** the exact-id redirect SHALL take precedence over the free-text redirect to Explore

#### Scenario: The sandbox Search surface mirrors the live scope

- **WHEN** a sandbox visitor submits a query on `/sandbox/search`
- **THEN** the page SHALL render the deterministic mock spine artifact buckets only
- **AND** the page SHALL NOT call the sandbox data source's record search methods
- **AND** the same exact-id and free-text redirect rules SHALL apply, targeting `/sandbox/explore`

#### Scenario: Command palette free-text submit reaches Explore

- **WHEN** an operator types a free-text query into the command palette and submits
- **THEN** the palette SHALL navigate to `/dashboard/search?q=<query>&jump=1`
- **AND** the resulting page SHALL redirect to `/dashboard/explore?q=<query>` when the query does not resolve to a spine id

### Requirement: Polyfill connector authoring layer SHALL provide a reusable per-record fingerprint cursor

The reference polyfill-connectors package SHALL expose a shared primitive that connector authors can adopt to suppress no-op record emits on streams whose source re-derives the full record each run (archive rebuilds, full-collection refetches, file-mtime triggers, aggregate re-derivation). The primitive SHALL:

- compute a stable per-record fingerprint over the emitted record fields with a caller-declared exclusion list for run-clock fields;
- accept the prior STATE cursor and tolerantly decode the prior fingerprint map (legacy cursor shapes, missing fields, malformed entries SHALL NOT throw and SHALL produce an empty map for those entries);
- answer whether a given record's fingerprint has moved relative to the prior cursor;
- always carry forward the fingerprint of skipped records so the next STATE write does not silently drop them;
- track ids observed in the current run so that, on full-scan streams, fingerprints for ids absent from the current run can be pruned at run boundary;
- expose the prior fingerprint value so a connector with derived-field-preservation policy can read it without breaking the encapsulation.

The derived-field-preservation surface (the prior fingerprint value exposed for read) SHALL support a fingerprint carrier that retains connector-chosen prior body fields, not only an opaque change-detection hash, so a connector that does not re-derive a field this run can carry the prior value forward rather than overwriting it with null. This is the same construction the Codex `sessions` cursor already uses to carry prior `message_count`/`function_call_count` forward when a run does not re-parse the rollout file; it is realized through the shared carry-forward cursor lifecycle and SHALL NOT require a per-connector parallel lifecycle.

Adoption SHALL be opt-in. Connectors whose source provides a strong incremental cursor SHALL NOT be forced to use the primitive. The primitive SHALL NOT modify the public RECORD or STATE wire shape; the fingerprint map is carried inside the connector's STATE cursor, which is already opaque to the runtime.

The runtime byte-equivalence no-op check at the storage layer SHALL remain in force as a backstop. The authoring-layer primitive SHALL NOT be relied on as the sole churn-prevention layer.

#### Scenario: Identical second run emits no records

- **WHEN** a connector adopts the primitive on a stream and the source state has not moved between runs
- **THEN** the second run SHALL emit zero RECORD messages for that stream
- **AND** the STATE cursor for that stream SHALL still carry the full per-record fingerprint map forward

#### Scenario: Run-clock field does not cause a re-emit

- **WHEN** a record's fingerprint excludes a run-clock field (e.g. `fetched_at`) and only that field advances between runs
- **THEN** `shouldEmit` SHALL return `false`
- **AND** the prior fingerprint SHALL be preserved in the next STATE write

#### Scenario: Source mutation re-emits exactly that record

- **WHEN** the source value of a single record changes between runs
- **THEN** `shouldEmit` SHALL return `true` for that record and `false` for unchanged records
- **AND** only the changed record SHALL appear in the run's RECORD output

#### Scenario: Source deletion is pruned at run boundary

- **WHEN** a record present in the prior cursor is not observed on a requested full-scan stream this run
- **THEN** the prune operation SHALL remove that id from the next STATE cursor
- **AND** a later re-add of the same id SHALL re-emit the record rather than be silently skipped as a no-op

#### Scenario: Legacy or malformed prior state is tolerated

- **WHEN** the prior STATE cursor has no `fingerprints` field, has a malformed shape, or contains entries with the wrong value type
- **THEN** the primitive SHALL produce an empty prior map for the malformed portion
- **AND** the run SHALL proceed without throwing and re-emit every record as new

#### Scenario: A non-re-derived field is carried forward, not nulled

- **WHEN** a connector with a derived-field-preservation policy does not re-derive a body field this run (the run did not re-parse or re-fetch the source for that record)
- **THEN** the connector SHALL be able to read the prior fingerprint carrier's value for that field and carry it forward
- **AND** the field SHALL NOT be overwritten with null solely because this run did not re-derive it
- **AND** when the carried-forward body is otherwise byte-identical modulo run-clock fields, `shouldEmit` SHALL return `false`

### Requirement: First-party polyfill stream coverage SHALL be provenance-honest
The reference implementation SHALL distinguish verified owner-account connector data from seed, fixture, demo, scaffolded, or blocked connector data when using first-party polyfill connectors as evidence of reference behavior.

#### Scenario: A connector has local rows from a fixture path
- **WHEN** local records for a connector were produced by seed or demo data rather than verified owner-account ingestion
- **THEN** the reference SHALL NOT present those rows as owner-account evidence
- **AND** the connector status, documentation, or task tracking SHALL mark the data as untrusted until purged and re-ingested from a verified source

### Requirement: Layer 2 stream additions SHALL be connector-scoped and test-backed
Each Layer 2 stream addition for a first-party polyfill connector SHALL include manifest schema updates, connector extraction logic, and tests or live-smoke evidence appropriate to the data source.

#### Scenario: A new local-file stream is added
- **WHEN** a local-file connector gains a new stream
- **THEN** tests SHALL cover parsing, primary-key stability, incremental behavior, and manifest validation

#### Scenario: A browser-backed stream is added
- **WHEN** a browser-backed connector gains a new stream
- **THEN** the change SHALL record whether verification used real owner interaction, scrubbed fixtures, or synthetic fixtures

### Requirement: Low-risk reference stores expose semantic production interfaces

The reference implementation SHALL expose production storage interfaces for pending consent, owner device authorization, connector state, connector schedules, and active-run coordination only after the relevant semantics have conformance coverage and at least one non-SQLite or Postgres-oriented proof.

#### Scenario: A low-risk store is extracted

**WHEN** a storage seam for pending consent, owner device authorization, connector state, schedules, or active runs is promoted into production code
**THEN** callers SHALL depend on a semantic store interface rather than raw SQLite handles, prepared statements, or query builders.

#### Scenario: A production SQLite store is accepted

**WHEN** the reference implementation provides a SQLite-backed implementation of one of these stores
**THEN** that implementation SHALL pass the existing conformance suite for the capability through a production-store-backed test adapter.

#### Scenario: Runtime backend selection is requested

**WHEN** a change wants to select SQLite, Postgres, or any other storage backend at runtime
**THEN** that behavior SHALL be proposed separately and SHALL NOT be introduced by the low-risk store extraction.

#### Scenario: A harder storage/search surface is considered

**WHEN** code touches record reads, record writes, disclosure-spine storage, lexical retrieval, semantic retrieval, hybrid retrieval, or blob byte storage
**THEN** it SHALL NOT reuse the low-risk store extraction as sufficient proof and SHALL require a separate contract and evidence gate.

### Requirement: Connector child stdio failures SHALL be handled at the runtime boundary

When the connector runtime spawns a connector child process, it SHALL attach `error` listeners to the child's `stdin`, `stdout`, and `stderr` streams before performing the first write or read. A closed-pipe error (`code` in the set `{ 'EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END' }`) on any of those owned streams SHALL be downgraded to a typed operational outcome on the run; it SHALL NOT propagate as an uncaught exception. Any other error class on those streams SHALL still terminate the run with the existing failure shape.

The runtime SHALL also guard `proc.stdin.write` call sites against a non-writable stdin (`proc.stdin.writable === false`) and SHALL surface that condition as the same typed operational outcome rather than as a thrown synchronous exception.

The runtime SHALL distinguish two terminal_reason values for runs that fail without a DONE message, depending on whether the runtime observed the failed write:

- **`connector_stdin_closed`** — the runtime observed a stdin write rejection (the helper either saw `proc.stdin.writable === false` or caught a closed-pipe `error` event on the stdin stream). The resolved outcome and persisted `run.failed` data SHALL also carry `stdin_closed_at_phase` naming the protocol phase the failed write was attempting (`start` for the initial START message, `interaction_response` for an INTERACTION_RESPONSE delivery, or `unknown` when the runtime only observed an asynchronous stream error).
- **`connector_exit_without_done`** — the child exited without DONE but the kernel pipe absorbed every parent write before the child closed, so the runtime never observed a write rejection. This is the existing failure shape.

In both cases, the parent process SHALL NOT emit an `uncaughtException`, and the resolved outcome SHALL carry one of these typed terminal_reason values.

#### Scenario: Connector child exits before reading START — runtime observed the EPIPE
- **WHEN** the runtime spawns a connector and writes START to a stdin whose far side has already closed
- **AND** the helper sees the failed write (either via `writable === false` or via a closed-pipe `error` event)
- **THEN** the resolved outcome's `terminal_reason` SHALL be `connector_stdin_closed`
- **AND** the resolved outcome SHALL include `stdin_closed_at_phase: 'start'`
- **AND** the parent process SHALL NOT emit an `uncaughtException`

#### Scenario: Connector child exits before reading START — kernel absorbed the write
- **WHEN** the runtime spawns a connector and writes START to a stdin whose kernel pipe accepts the bytes before the child closes
- **AND** the child then exits without sending DONE
- **THEN** the resolved outcome's `terminal_reason` SHALL be `connector_exit_without_done`
- **AND** the parent process SHALL NOT emit an `uncaughtException`

#### Scenario: Connector child closes stdin during INTERACTION_RESPONSE delivery
- **WHEN** the runtime tries to write an `INTERACTION_RESPONSE` to a connector whose stdin has already closed
- **AND** the runtime helper observes the failed write
- **THEN** the resolved outcome's `terminal_reason` SHALL be `connector_stdin_closed`
- **AND** the resolved outcome SHALL include `stdin_closed_at_phase: 'interaction_response'`
- **AND** the run lifecycle SHALL still drain to a terminal record via the existing `'close'` handler

#### Scenario: Non-EPIPE error on connector stdio is not downgraded
- **WHEN** the runtime's `proc.stdin` listener receives an `error` whose `code` is not in the closed-pipe set (for example a `TypeError` synthesized by Node)
- **THEN** the runtime SHALL terminate the run via its existing failure path and the error SHALL surface to the run's caller, not be silently swallowed

#### Scenario: A successful DONE outranks any later stdin-close on teardown
- **WHEN** the connector emits DONE and the runtime later observes a stdin write rejection during cleanup
- **THEN** the resolved outcome's `terminal_reason` SHALL reflect the DONE status (`connector_reported_failed`, `connector_reported_cancelled`, or null on success), not `connector_stdin_closed`

### Requirement: Postgres proof service SHALL be profile-gated and runtime-independent

The repository MAY ship a Compose Postgres service to support env-gated conformance proofs (notably `reference-implementation/test/connector-state-scheduler-conformance-postgres.test.js`). Any such service SHALL be gated behind a Compose profile, SHALL NOT be started by a default `docker compose up`, and SHALL NOT be wired into the runtime storage path of any production reference service.

#### Scenario: Default Compose stack does not include the proof service

- **WHEN** an operator runs `docker compose --env-file .env.docker up`
- **THEN** the Postgres proof service SHALL NOT start
- **AND** the rendered `docker compose --env-file .env.docker config` output SHALL NOT include the proof service

#### Scenario: Proof service started explicitly

- **WHEN** an operator runs `docker compose --profile postgres --env-file .env.docker up -d postgres`
- **THEN** the Postgres proof service SHALL start with a persistent named volume and a `pg_isready` healthcheck
- **AND** the host port SHALL be configurable via an env var defaulting to a nonstandard local port to avoid colliding with operator-installed Postgres on `5432`
- **AND** the service SHALL bind to a loopback host (`127.0.0.1`) by default so that default-credential proof runs are not reachable from LAN or WAN

#### Scenario: LAN exposure requires deliberate opt-in

- **WHEN** an operator wants to reach the proof service from another host on the network
- **THEN** they SHALL change the documented bind-host env var to a non-loopback address
- **AND** the documentation SHALL state that this opt-in is only safe when the default credentials are also replaced
- **AND** the default Compose mapping SHALL NOT bind the proof service to all interfaces

#### Scenario: Reference services remain SQLite-backed

- **WHEN** the Postgres proof service is started or stopped
- **THEN** the `reference` service SHALL NOT depend on it via `depends_on` or runtime env wiring
- **AND** the reference runtime SHALL continue to use its SQLite-backed storage path
- **AND** no `PDPP_STORAGE_BACKEND` or `PDPP_DATABASE_URL` runtime contract SHALL be introduced by this change

#### Scenario: Proof service is documented as proof-only

- **WHEN** the Postgres proof service is documented in `.env.docker.example` or the README
- **THEN** the documentation SHALL state that the service exists for env-gated conformance/proof use only
- **AND** the documentation SHALL NOT claim operator-facing Postgres storage support
- **AND** the documentation SHALL show the exact `PDPP_TEST_POSTGRES_URL` value that targets the proof service

### Requirement: Postgres storage proofs SHALL stay capability-scoped

The reference implementation SHALL introduce Postgres storage support in no
more than two implementation slices: first capability-scoped low-risk storage
proofs, then records/search runtime storage. The low-risk storage proof slice
SHALL cover only storage capability families with executable conformance
harnesses and SHALL NOT migrate records, blobs, disclosure spine, lexical
retrieval, semantic retrieval, hybrid retrieval, or default runtime storage.

#### Scenario: Low-risk storage proof

- **WHEN** a Postgres adapter is added for connector state, scheduler, consent,
  or owner-device-auth storage
- **THEN** the adapter SHALL pass the same conformance harness used by the
  SQLite baseline or a memory adapter
- **AND** the conformance harness SHALL remain falsifiable through a deliberately
  broken driver or equivalent negative proof

#### Scenario: Runtime default remains SQLite

- **WHEN** the low-risk Postgres storage proof is present in the repository
- **THEN** SQLite SHALL remain the default reference runtime backend
- **AND** Postgres execution SHALL require explicit environment configuration
- **AND** default tests SHALL NOT require a running Postgres service

#### Scenario: Records and search are deferred to the second slice

- **WHEN** implementing this low-risk storage proof slice
- **THEN** records, blobs, disclosure spine, lexical retrieval, semantic
  retrieval, hybrid retrieval, cursor semantics, version allocation, and
  record-change semantics SHALL remain out of scope
- **AND** any attempt to migrate those surfaces SHALL require the second and
  final Postgres slice with its own records/search evidence

#### Scenario: Operations remain storage-driver agnostic

- **WHEN** an operation consumes a storage-backed capability covered by this
  slice
- **THEN** the operation SHALL depend on the explicit capability contract rather
  than importing SQLite, Postgres, `pg`, concrete store modules, process
  environment, or test-only drivers

### Requirement: Reference operation modules SHALL be gated by a discovery-based boundary test

The reference implementation SHALL gate every canonical reference operation module under `reference-implementation/operations/<name>/index.ts` against forbidden host, storage, and process-environment dependencies through a discovery-based test, so that adding a new operation module without an explicit per-operation test does not silently bypass the gate.

#### Scenario: A new operation module is added

- **WHEN** a developer adds `reference-implementation/operations/<new-name>/index.ts`
- **THEN** the discovery-based boundary test SHALL include that module
- **AND** the test SHALL fail if the module statically imports Fastify, Express, Next, SQLite, Postgres, a raw SQL handle, a generic repository, sandbox UI/page code, `_demo/` builders, or the Node `process` module, or if the module references `process.env` in executable source outside of comments

#### Scenario: An operation module imports a forbidden concrete

- **WHEN** any operation module under `reference-implementation/operations/<name>/index.ts` introduces a static import that resolves a specifier of `fastify`, `express`, `next/`, `better-sqlite3`, `pg`, `./db`, `../db`, `../lib/db`, `../server/db`, `../server/records`, `../server/auth`, `../server/index`, `apps/site`, `_demo/`, `node:process`, or `process`
- **AND** the import takes any standard ES static-import shape — bare side-effect (`import "<x>";`), default (`import x from "<x>";`), namespace (`import * as x from "<x>";`), named (`import { x } from "<x>";`), type-only (`import type { X } from "<x>";`), or re-export (`export { x } from "<x>";`, `export * from "<x>";`)
- **THEN** the discovery-based boundary test SHALL fail with a message that names the module and the forbidden import

#### Scenario: An operation module accesses the process environment

- **WHEN** any operation module under `reference-implementation/operations/<name>/index.ts` references the process environment in executable source — either by spelling `process.env` directly outside of comments, or by statically importing the Node `process` module under the bare specifier (`process`) or the `node:` specifier (`node:process`) in any standard ES static-import shape
- **THEN** the discovery-based boundary test SHALL fail
- **AND** the test SHALL strip block and line comments before checking the literal `process.env` shape so module headers that document the rule do not trip the guard
- **AND** the failure message SHALL name the module and either the literal `process.env` rule or the forbidden Node `process` specifier
- **AND** dynamic imports of the Node `process` module (e.g., `await import("node:process")`) are intentionally out of scope for this static gate; this is a documented trade-off, not a guarantee

#### Scenario: The operations directory layout changes

- **WHEN** the discovery-based boundary test runs
- **THEN** it SHALL discover at least one operation module
- **AND** it SHALL fail loudly if zero operation modules are discovered, so a refactor that moves or renames the directory cannot silently neuter the gate

### Requirement: The reference implementation ships an operator self-host onboarding lane

The reference implementation SHALL ship an operator-facing self-host onboarding runbook that names at least one substrate beyond a generic Docker host and that scopes substrate-specific constraints honestly. The runbook SHALL NOT adopt hosted-service framing.

#### Scenario: A self-hoster reads the quick-start

- **WHEN** an operator opens `docs/operator/selfhost-quickstart.md`
- **THEN** they SHALL find at least two named lanes — one generic Docker host lane and one substrate-specific lane (RunPod CPU Pod for the SLVP) — each stating the minimum environment variables that must change from defaults, the dashboard verification step, and the wiring to `docs/operator/hosted-mcp-setup.md` for MCP grant package issuance
- **AND** the runbook SHALL state, for the substrate-specific lane, what that substrate does and does not provide (single-container vs. multi-container compose, HTTP proxy vs. native TLS, UDP support, port exposure model) without implying capabilities the substrate lacks

#### Scenario: The runbook scopes out hosted-service language

- **WHEN** the runbook describes the reference deployment
- **THEN** it SHALL address the reader as the operator of their own instance and SHALL NOT use "sign up", "our service", "we sync", or otherwise imply that PDPP-the-protocol or its stewards operate a hosted backend for end users

### Requirement: The deployment dashboard surfaces first-boot readiness

The reference implementation operator dashboard SHALL surface a structured deployment readiness view that presents existing diagnostic state as first-boot self-check rows. The view SHALL be presentation-only: it MAY consume `/_ref/deployment`, the in-browser origin, and the deployment's published OAuth metadata, but SHALL NOT introduce new owner control-plane mutations.

#### Scenario: An operator visits the dashboard on first boot

- **WHEN** an operator visits `/dashboard/deployment` after starting a fresh reference deployment
- **THEN** they SHALL see a readiness view that includes at minimum the following checks, each rendered with a status of `ok`, `warn`, `error`, `info`, or `unknown` and a one-line remediation hint:
  - owner-password gate (whether `PDPP_OWNER_PASSWORD` is configured)
  - reference-origin alignment (whether `PDPP_REFERENCE_ORIGIN` matches the URL the operator is currently viewing)
  - storage backend health
  - embedding cache state
  - hosted MCP refresh-token advertisement at the deployment's authorization-server metadata endpoint

#### Scenario: The owner password is unset on a reachable dashboard

- **WHEN** the operator opens `/dashboard/deployment` against a deployment whose `PDPP_OWNER_PASSWORD` is empty
- **THEN** the owner-password row SHALL render with `status = error` and a hint that explicitly states that `/owner`, `/device`, `/consent`, and `/dashboard` are reachable without authentication until the variable is set and the deployment is restarted

#### Scenario: The dashboard is reached via a proxy URL different from the configured origin

- **WHEN** the operator opens `/dashboard/deployment` at an origin (for example `https://<podid>-3002.proxy.runpod.net`) that does not match the server-reported `PDPP_REFERENCE_ORIGIN`
- **THEN** the reference-origin row SHALL render with `status = warn` and a hint that names the observed origin and recommends setting `PDPP_REFERENCE_ORIGIN` to that origin to avoid OAuth callback and MCP routing failures

#### Scenario: The reference image is too old to advertise `refresh_token`

- **WHEN** the deployment's `/.well-known/oauth-authorization-server` does not advertise `refresh_token` in `grant_types_supported`
- **THEN** the readiness view SHALL render the MCP refresh-token row with `status = error` and a hint that the image must be updated to a revision that advertises `refresh_token`

#### Scenario: The readiness view introduces no new control plane

- **WHEN** the readiness view is rendered
- **THEN** the implementation SHALL NOT expose a new `/_ref/*` mutation endpoint, a new owner action, or a credential-entry affordance through this view; surfacing existing state is the sole responsibility of the view

### Requirement: Remote surface package SHALL be almost push-button OSS-publishable

`@pdpp/remote-surface` SHALL have an architecture and package shape that is almost push-button OSS-publishable as a standalone package that external consumers can install from a packed artifact, typecheck, import, and evaluate without a PDPP monorepo checkout or unpublished workspace dependencies. The package MAY remain unpublished and `private: true` until release preparation.

#### Scenario: A consumer installs the package outside the monorepo

- **WHEN** an external consumer installs the packed `@pdpp/remote-surface` artifact in a clean project
- **THEN** installation SHALL succeed without requiring `workspace:*` dependency resolution, relative monorepo paths, private package names, or unpublished sibling packages
- **AND** all runtime dependencies required by the public package SHALL be declared as publishable dependencies, peer dependencies, optional dependencies, or bundled implementation details

#### Scenario: A consumer imports public entrypoints

- **WHEN** a clean consumer imports every documented public entrypoint
- **THEN** the imports SHALL resolve to compiled package artifacts
- **AND** TypeScript declarations SHALL exist for every exported public API
- **AND** the consumer SHALL NOT need to compile raw package source from the repository

#### Scenario: The package tarball is inspected

- **WHEN** maintainers inspect the package tarball before publication
- **THEN** it SHALL include only intentional public artifacts such as package metadata, README, license, compiled runtime files, declaration files, and required runtime assets
- **AND** it SHALL NOT include package-local tests, private/raw source intended only for the monorepo build, fixtures, build caches, internal audit notes, or unrelated repository files unless explicitly justified as public package content

#### Scenario: Maintainers defer the release switch

- **WHEN** maintainers complete the package-shape implementation for this change
- **THEN** the package SHALL NOT be required to publish to a registry
- **AND** the package SHALL NOT be required to switch from `private: true` to `private: false` until release preparation

### Requirement: Remote surface public APIs SHALL be host-neutral

`@pdpp/remote-surface` SHALL expose public API names, types, documentation, and examples that describe generic remote-surface host concepts rather than PDPP reference-runtime internals.

#### Scenario: Public artifacts are scanned for PDPP reference leakage

- **WHEN** maintainers scan public package artifacts, generated declarations, README examples, and exported type names
- **THEN** `_ref`, `run_id`, and `interaction_id` SHALL NOT appear as public remote-surface concepts
- **AND** any remaining occurrence SHALL be limited to an explicitly labeled PDPP reference adapter, migration note, or compatibility test that is not presented as the default external consumer contract

#### Scenario: A non-PDPP host integrates the package

- **WHEN** a host that does not implement the PDPP reference runtime integrates `@pdpp/remote-surface`
- **THEN** the package SHALL let that host provide its own routing, authorization, persistence, lifecycle, and identifier model through host-neutral interfaces
- **AND** the host SHALL NOT need to expose or emulate PDPP `_ref` endpoints, PDPP run identifiers, or PDPP interaction identifiers to use the primary package API

### Requirement: Remote surface store and lease contracts SHALL be host-owned

Server store and lease APIs exposed by `@pdpp/remote-surface` SHALL describe host-owned persistence and surface lifecycle contracts instead of binding external consumers to PDPP reference runtime storage or operator-control semantics.

#### Scenario: A host implements persistence

- **WHEN** an external host implements the remote-surface server store contract
- **THEN** the contract SHALL describe the data the package requires using generic surface, session, lease, action, and lifecycle terms
- **AND** it SHALL NOT require the host to persist PDPP event-spine rows, `_ref` timeline records, reference run rows, or reference interaction rows as part of the primary package contract

#### Scenario: A host implements lease lifecycle

- **WHEN** an external host implements remote-surface lease acquisition, renewal, release, cancellation, expiry, or recovery
- **THEN** the lease API SHALL be expressible without PDPP runtime-specific identifiers or endpoint names
- **AND** lease state transitions SHALL be documented well enough for a host to implement them without importing app/runtime code

### Requirement: Remote surface publication checks SHALL prove release readiness

The repository SHALL maintain automated checks that prove `@pdpp/remote-surface` is architecturally ready for standalone publication before maintainers publish it.

#### Scenario: Publication validation runs in CI

- **WHEN** package publication validation runs
- **THEN** it SHALL verify tarball hygiene, public exports, declaration coverage, dependency publishability, package-local tests, host-neutral public artifact scans, and clean-consumer install/import/typecheck from the packed artifact
- **AND** a failure in any of those checks SHALL block publication readiness

#### Scenario: Maintainers run a publication dry run

- **WHEN** a maintainer prepares to publish `@pdpp/remote-surface`
- **THEN** the documented dry-run path SHALL produce an inspectable package artifact or file list without publishing
- **AND** the dry run SHALL expose enough evidence to confirm that private source, tests, workspace-only dependencies, and PDPP reference-only concepts are not leaking into the public package

#### Scenario: Maintainers prepare launch documentation

- **WHEN** maintainers perform release preparation for `@pdpp/remote-surface`
- **THEN** polished README examples, cookbook documentation, final registry metadata, the `private: false` switch, and actual publication SHALL be handled as release-prep work rather than as prerequisites for this package-shape change

### Requirement: Time-bucket aggregation SHALL use calendar `date_trunc` semantics with a UTC default zone
The reference implementation SHALL support grouping a single-stream aggregation into time buckets over a declared date or date-time field via `group_by_time=<field>`. `granularity` SHALL be required when `group_by_time` is present and forbidden otherwise, and SHALL be one of `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year`, computed with calendar-aware `date_trunc` semantics (weeks start Monday). An optional `time_zone` SHALL select the IANA zone used to compute bucket boundaries; when omitted the effective zone SHALL be `UTC`. The response SHALL echo the effective `time_zone`, the `group_by_time` field, and the `granularity`. Records whose time field is null or unparseable SHALL be collected into a single bucket with `key: null` and SHALL NOT be silently dropped.

#### Scenario: Day buckets in the default zone
- **WHEN** a client requests `group_by_time=<date_field>&granularity=day` without `time_zone`
- **THEN** the response SHALL report `time_zone: "UTC"`, `granularity: "day"`, and `group_by_time: "<date_field>"`
- **AND** each bucket key SHALL be the ISO start of a UTC day with the count of records in that day

#### Scenario: Explicit time zone shifts bucket boundaries
- **WHEN** a client requests `group_by_time=<date_field>&granularity=day&time_zone=America/New_York`
- **THEN** the response SHALL report `time_zone: "America/New_York"`
- **AND** bucket boundaries SHALL be computed in that zone

#### Scenario: Missing or invalid granularity is rejected
- **WHEN** a client requests `group_by_time=<date_field>` without `granularity`, or with a `granularity` outside the supported set, or supplies `granularity` without `group_by_time`
- **THEN** the reference SHALL reject the request with an `invalid_request` query error

#### Scenario: Null time values bucket explicitly
- **WHEN** a `group_by_time` aggregation includes records whose time field is null or unparseable
- **THEN** those records SHALL appear in a single bucket with `key: null`
- **AND** they SHALL NOT be omitted from the response

### Requirement: `count_distinct` SHALL count distinct non-null values exactly in the reference floor
The reference implementation SHALL support a `count_distinct` metric that requires a manifest-declared, grant-authorized `field` and returns the number of distinct non-null values of that field across the filtered, grant-visible record set. Null values SHALL NOT be counted as a distinct value. The reference SHALL compute this exactly and SHALL report `approximate: false`. A future accelerated path MAY estimate the cardinality and SHALL then report `approximate: true`; capability metadata SHALL NOT advertise `count_distinct` as approximate on a server that computes it exactly.

#### Scenario: Exact distinct over a declared field
- **WHEN** a client requests `metric=count_distinct&field=<field>` and `<field>` is declared and granted
- **THEN** the response `value` SHALL equal the number of distinct non-null values of `<field>` in the filtered set
- **AND** the response SHALL report `approximate: false`

#### Scenario: Null is not a distinct value
- **WHEN** records include null values for `<field>`
- **THEN** the null value SHALL NOT contribute to the `count_distinct` result

### Requirement: The aggregate response SHALL carry additive time-bucket and distinct fields
The public aggregation response SHALL include the additive fields `group_by_time`, `granularity`, `time_zone`, and `approximate`. For non-time, non-distinct aggregations these fields SHALL be `null`/`false` so existing response payloads remain compatible. `group_by_time` and `granularity` SHALL be populated only for time-bucket groupings; `time_zone` SHALL be the echoed effective zone for time-bucket groupings; `approximate` SHALL reflect whether the reported metric is an estimate.

#### Scenario: Scalar aggregation omits time-bucket meaning
- **WHEN** a client requests a `count`, `sum`, `min`, `max`, or scalar `group_by` aggregation
- **THEN** `group_by_time` and `granularity` SHALL be `null`
- **AND** `approximate` SHALL be `false`

### Requirement: Aggregate capability discovery SHALL advertise time-bucket and distinct support
`GET /v1/schema` and stream metadata SHALL advertise the new aggregation capabilities. The stream `query.aggregations` block SHALL surface `group_by_time` and `count_distinct` declared field lists. The per-field `aggregation` descriptor SHALL include `group_by_time` and `count_distinct` `{declared, usable}` flags consistent with the existing `sum`/`min`/`max`/`group_by` flags. Capability metadata SHALL NOT over-promise: a field is `usable` for a capability only when it is declared and authorized under the caller's grant.

#### Scenario: Time-bucketable field advertises group_by_time
- **WHEN** a caller reads stream metadata for a stream that declares a date field under `query.aggregations.group_by_time`
- **AND** the caller is authorized for that field
- **THEN** the field's `aggregation.group_by_time` SHALL report `declared: true, usable: true`

#### Scenario: Undeclared distinct field advertises unusable
- **WHEN** a field is not listed under `query.aggregations.count_distinct`
- **THEN** the field's `aggregation.count_distinct` SHALL report `declared: false, usable: false`

### Requirement: The MCP aggregate tool SHALL mirror the canonical aggregate contract
The reference MCP server SHALL expose an `aggregate` tool that forwards `metric`, `field`, `group_by`, `group_by_time`, `granularity`, `time_zone`, `limit`, `filter`, and `connection_id` to `GET /v1/streams/{stream}/aggregate` and mirrors the resource server response body into `structuredContent`. The tool input schema SHALL encode the metric set (`count`, `sum`, `min`, `max`, `count_distinct`) and the granularity set, and SHALL document the single grouping dimension rule. The tool SHALL forward supported arguments verbatim and SHALL NOT silently drop an argument the resource server would reject, nor describe parameters the resource server does not support.

#### Scenario: Tool forwards a time-bucket aggregation
- **WHEN** an MCP client calls `aggregate` with `stream`, `metric=count`, `group_by_time`, and `granularity`
- **THEN** the tool SHALL issue the corresponding `GET /v1/streams/{stream}/aggregate` request
- **AND** the resource server aggregation body SHALL be returned in `structuredContent.data`

#### Scenario: Tool preserves a resource server rejection
- **WHEN** an MCP client calls `aggregate` with a request the resource server rejects (for example two grouping dimensions)
- **THEN** the tool SHALL surface the resource server error envelope rather than silently succeeding

### Requirement: The reference SHALL expose an owner/operator-only historical record-changes compaction tool

The reference implementation SHALL provide an owner/operator-only operational tool that removes provably-redundant adjacent historical `record_changes` rows under a per-stream compaction policy that mirrors the connector's own no-op fingerprint definition. The tool is reference-implementation maintenance, not protocol behavior. It SHALL NOT affect PDPP Core semantics, public record reads, public `changes_since` responses, or grant enforcement.

The tool SHALL be authorized by direct database access (`PDPP_DATABASE_URL` or `PDPP_TEST_POSTGRES_URL`). It SHALL NOT be exposed via an HTTP route, a scheduler, or any automatic background job.

The tool SHALL maintain a registry of `(connector_id, stream)` compaction policies in code. Each policy SHALL declare the per-stream fingerprint definition (`excludeKeys` list, where an empty list means stable-stringify of the full `record_json`). The registry SHALL cover three policy families:

- **Connector fingerprint mirror.** Gmail `threads`, Gmail `labels` (with `excludeKeys` empty — the connector's per-label fingerprint hashes the stored body after excluding a synthetic keying `id` that is not part of `record_json`), Slack `workspace` (with `fetched_at` excluded from the fingerprint), Slack `users`, Slack `files`, Slack `channel_memberships` (with `fetched_at` excluded from the fingerprint — the only other fields, `id`/`channel_id`/`user_id`, are the membership identity itself), YNAB `payee_locations`, YNAB `budgets` (with `last_month` and `last_modified_on` excluded from the fingerprint), USAA `statements` (with `fetched_at` excluded from the fingerprint), Chase `accounts` (with `fetched_at` excluded from the fingerprint), Chase `statements` (with `fetched_at` excluded from the fingerprint), Chase `transactions` (with `fetched_at` excluded from the fingerprint), USAA `accounts` (with `fetched_at` excluded from the fingerprint), USAA `credit_card_billing` (with `fetched_at` excluded from the fingerprint), USAA `transactions` (with `fetched_at` excluded from the fingerprint), USAA `inbox_messages` (with `fetched_at` excluded from the fingerprint), Chase `current_activity` (with `fetched_at` excluded from the fingerprint), and Amazon `orders` (with `fetched_at` excluded from the fingerprint). Each policy SHALL declare the same fingerprint definition the corresponding connector uses to suppress no-op emits. For Chase `statements`, the record body carries content-addressed PDF references (`document_url`/`pdf_path`/`pdf_sha256`, whose path embeds the sha256) and immutable statement identity; for Chase `transactions`, the body carries immutable posted-transaction source fields (`date`, `amount`, `name`, `memo`, `type`, …) keyed by `account_id|fitid`. In both cases only the run-clock `fetched_at` is excluded — every real source field remains a fingerprint boundary that is never collapsed. For USAA `accounts` and USAA `credit_card_billing`, the record body carries real point-in-time financial fields (balances, available credit, rewards, APRs, billing status) that are NOT excluded — only the run-clock `fetched_at` is excluded, so any move in a real field remains a fingerprint boundary that is never collapsed. For USAA `transactions`, the body carries immutable posted-transaction source fields (`date`, `amount`, `original_description`, `balance_after_cents`, …) keyed by a hash of `accountId|date|amount|original|#ord`, shared across the CSV-export and PDF-statement emit paths; for USAA `inbox_messages`, the body carries a message keyed by `hashId(date_short|preview[:120])` whose only mutable field is the read/unread `status`; for Chase `current_activity`, the body carries a dashboard activity row keyed by `account_id|ui_transaction_id` (or an account-scoped fallback hash) whose mutable fields are the pending → posted transition (`status`/`posted_date`/`amount`); for Amazon `orders`, the body carries an order keyed by the immutable order id with a fixed total whose only mutable fields are the in-transit `delivery_status`/`status_detail`. In every case only the run-clock `fetched_at` is excluded — every real source field remains a fingerprint boundary that is never collapsed.
- **Exact stable-JSON identity for local-device connectors.** Codex (`messages`, `function_calls`, `sessions`, `skills`, `prompts`, `rules`) and Claude Code (`messages`, `attachments`, `sessions`, `skills`, `memory_notes`, `slash_commands`). Each policy SHALL declare an empty `excludeKeys` list. The policy is justified per-stream by verifying the `record_json` payload contains no `fetched_at`-style volatile field — adjacent versions with byte-identical canonical JSON are then strictly more conservative than the connector's own no-op-emit semantics could be.
- **Inventory churn gate for local-device inventory streams.** The `inventory_only`/`defer` metadata streams whose record bodies are produced by `buildLocalSourceInventory` / `listDirectoryInventory` and carry the incidental file-stat fields `mtime_epoch` and `size_bytes`: Claude Code (`backup_inventory`, `cache_inventory`, `config_inventory`, `file_history`) and Codex (`history`, `session_index`, `shell_snapshots`, `config_inventory`, `cache_inventory`, `logs`). Each policy SHALL declare `excludeKeys: ["mtime_epoch", "size_bytes"]`, mirroring the connector-side `openInventoryFingerprintCursor`. The inventory meaning of the record — its `relative_path`/`path_hash`, `type`, `classification`, and `reason` — remains inside the fingerprint and is never collapsed; only an adjacent version that differs solely in the incidental `mtime_epoch`/`size_bytes` file-stat metadata is removable. The freshness of the store (whether it exists and when the collector last looked) is carried by the `coverage_diagnostics` stream and the per-stream STATE `fetched_at`, not by re-versioning the inventory record.

Registering a new policy SHALL be a code-review gate that either references a connector-side fingerprint already in production (families 1 and 3) or documents the per-stream proof that the record payload contains no volatile field that would force exact-JSON identity to over-classify (family 2). A family-1 policy that excludes a run-clock field from a body containing real point-in-time state or immutable source data SHALL NOT exclude any real-state or source field; excluding only the run-clock field is lossless because any real change yields a distinct fingerprint that is retained as a version boundary. A family-3 policy SHALL exclude only the incidental `mtime_epoch`/`size_bytes` file-stat fields; excluding them is lossless because any real inventory transition (a store appearing or disappearing, a file becoming a directory, a path-hash move, or a classification/reason change) yields a distinct fingerprint that is retained as a version boundary.

The connector-side forward gate for a **partial-scan** stream (one whose run observes only an incremental window of records, not the full set — e.g. Chase `transactions` and USAA `transactions`, which download a per-account window starting at the prior watermark; Chase `current_activity`, which renders only the dashboard's recent rows; Amazon `orders`, which year-freezes historical years) SHALL NOT prune fingerprints for records it did not observe this run. Pruning a partial scan would drop fingerprints for records outside the window and re-emit them on the next overlapping window. Full-scan streams (e.g. Chase `accounts`, Chase `statements`, USAA `accounts`, USAA `inbox_messages`) MAY prune so a removed-then-re-added record re-emits.

The connector-side inventory fingerprint cursor enumerates the known stores under the source home as a **full scan**, so it SHALL prune fingerprints for stores not observed this run; a store that disappears drops out of the cursor and re-emits exactly once when it returns.

The tool SHALL default to dry-run mode. In dry-run mode, for each in-scope `(connector_instance_id, stream)` it SHALL report `scannedKeys`, `scannedVersions`, `removableVersions`, `retainedVersionsAfter`, and `estimatedRemovedBytes`, and SHALL NOT modify any row.

The tool SHALL mutate rows only when invoked with an explicit `--apply` flag. With `--apply` it SHALL:

- create a per-run backup table `compact_record_history_backup_<runId>` with the same column shape as `record_changes` plus a `compacted_at` column;
- inside a single Postgres transaction per `(connector_instance_id, stream)` scope, INSERT every removable `record_changes` row into the backup table and DELETE those same rows from `record_changes`;
- assert the inserted and deleted row counts match before commit and SHALL roll back and exit non-zero if they do not.

The tool SHALL apply the following retention rule per `(connector_instance_id, stream, record_key)`:

- never remove the current row's version (the version present in `records`);
- never remove a tombstone (`deleted = TRUE`) row;
- never remove a non-tombstone row whose immediately-prior surviving row is a tombstone, even if their fingerprints match (tombstones bound compaction);
- never remove the first version for the key;
- never remove the most recent prior version whose fingerprint differs from the current row's fingerprint;
- remove a non-tombstone row whose immediately-prior surviving row is a non-tombstone with the same policy fingerprint and is not the current row.

The tool SHALL NOT mutate, delete, or insert any row in `records`. The tool SHALL NOT mutate `version_counter`. The tool SHALL NOT cross `(connector_instance_id, stream, record_key)` boundaries when comparing fingerprints. The tool SHALL NOT operate on any `(connector_id, stream)` pair that is not present in the registered compaction policies.

After a successful apply against a `(connector_instance_id, stream)` scope, the tool SHALL invalidate the retained-size projection for that scope so the existing rebuild path corrects retained-size accounting on the next pass.

#### Scenario: Dry-run reports removable versions without mutating

- **WHEN** the operator invokes the tool in dry-run mode for a `(connector_instance_id, stream)` scope containing a known-redundant series of adjacent same-fingerprint historical versions under a registered policy
- **THEN** the tool SHALL print a summary line with a non-zero `removableVersions` count and a non-zero `estimatedRemovedBytes`
- **AND** `record_changes`, `records`, `version_counter`, and the retained-size projection SHALL be byte-identical to their pre-invocation state

#### Scenario: Apply removes only removable versions, atomically, with a backup

- **WHEN** the operator invokes the tool with `--apply` against the same scope
- **THEN** the tool SHALL create `compact_record_history_backup_<runId>` and SHALL INSERT every removable row into it before DELETE-ing those rows from `record_changes`, inside a single transaction
- **AND** the surviving `record_changes` rows for each in-scope key SHALL be byte-identical to their pre-apply values
- **AND** the current `records` row for each in-scope key SHALL be byte-identical to its pre-apply payload
- **AND** `version_counter.max_version` for the scope SHALL be unchanged
- **AND** the retained-size projection for the scope SHALL be marked dirty for rebuild

#### Scenario: Tombstones bound compaction

- **WHEN** a key's `record_changes` history contains a tombstone row between two same-fingerprint non-tombstone rows
- **THEN** the tool SHALL NOT collapse the two non-tombstone rows into one
- **AND** the tombstone row SHALL be retained

#### Scenario: Unknown stream is refused

- **WHEN** the operator invokes the tool against a `(connector_id, stream)` pair not in the registered compaction policies
- **THEN** the tool SHALL exit non-zero before mutating any row
- **AND** the message SHALL name the registered policies

#### Scenario: Apply without database credentials is refused

- **WHEN** the operator invokes the tool with `--apply` but `PDPP_DATABASE_URL` and `PDPP_TEST_POSTGRES_URL` are both unset
- **THEN** the tool SHALL exit non-zero
- **AND** SHALL NOT create a backup table or modify any row

#### Scenario: The YNAB budgets policy collapses calendar-only churn but preserves genuine summary edits

- **WHEN** a `ynab/budgets` key's history contains adjacent versions whose only differences are `last_month` and `last_modified_on`
- **THEN** the tool SHALL classify those adjacent versions as removable under the `["last_month", "last_modified_on"]` fingerprint exclusion, matching the connector's `BUDGET_FINGERPRINT_EXCLUDE` no-op-emit definition
- **AND** a version that changes any retained budget-summary field (for example the budget `name`, currency locale, date format, or `first_month`) SHALL remain a fingerprint boundary that is never collapsed

#### Scenario: The run-clock / stored-body policies collapse pure run-clock churn but preserve genuine source changes

- **WHEN** a `gmail/labels`, `usaa/statements`, `chase/accounts`, or `slack/channel_memberships` key's history contains adjacent versions whose only difference is the run-clock field (`fetched_at` for statements/accounts/channel_memberships) or is byte-identical under the stored body (labels)
- **THEN** the tool SHALL classify those adjacent versions as removable under the policy's `excludeKeys` (`[]` for `gmail/labels`, `["fetched_at"]` for `usaa/statements`, `chase/accounts`, and `slack/channel_memberships`), matching the connector's per-record fingerprint no-op-emit definition
- **AND** a version that changes any retained source field (for example a renamed Gmail label, a re-hydrated USAA statement with a different `pdf_sha256`, a renamed Chase account, or a Slack membership whose `channel_id`/`user_id` changes) SHALL remain a fingerprint boundary that is never collapsed

#### Scenario: The Chase run-clock policies collapse pure run-clock churn but preserve every real transaction and statement change

- **WHEN** a `chase/statements` or `chase/transactions` key's history contains adjacent versions whose only difference is the run-clock `fetched_at`
- **THEN** the tool SHALL classify those adjacent versions as removable under the policy's `excludeKeys` (`["fetched_at"]`), matching the connector's per-record fingerprint no-op-emit definition
- **AND** a version that changes any retained real field — for example a corrected `amount` or `name` on a transaction, or a newly-hydrated `pdf_path`/`pdf_sha256`/`document_url` or a changed `title` on a statement — SHALL remain a fingerprint boundary that is never collapsed
- **AND** every distinct real value that ever appeared in the history SHALL survive as a retained version boundary

#### Scenario: The Chase transactions forward gate never prunes its partial incremental window

- **WHEN** a Chase run downloads a per-account QFX window that does not include an older transaction the connector emitted on a prior run
- **THEN** the connector's `transactions` fingerprint cursor SHALL retain that older transaction's fingerprint (it SHALL NOT `pruneStale` it)
- **AND** when a later, wider window re-downloads that older transaction unchanged, the retained fingerprint SHALL suppress the re-emit rather than appending a new run-clock-only version

#### Scenario: The USAA real-field run-clock policies collapse pure run-clock churn but preserve every real financial state change

- **WHEN** a `usaa/accounts` or `usaa/credit_card_billing` key's history contains adjacent versions whose only difference is the run-clock `fetched_at`
- **THEN** the tool SHALL classify those adjacent versions as removable under the policy's `excludeKeys` (`["fetched_at"]`), matching the connector's per-record fingerprint no-op-emit definition
- **AND** a version that changes any retained real financial field — for example `balance_cents` on an account, or `current_balance_cents`, `cash_rewards_cents`, `available_credit_cents`, or `annual_percent_rate` on a credit-card billing record — SHALL remain a fingerprint boundary that is never collapsed
- **AND** every distinct real-state value that ever appeared in the history SHALL survive as a retained version boundary

#### Scenario: The remaining run-clock policies collapse pure run-clock churn but preserve every real change

- **WHEN** a `usaa/transactions`, `usaa/inbox_messages`, `chase/current_activity`, or `amazon/orders` key's history contains adjacent versions whose only difference is the run-clock `fetched_at`
- **THEN** the tool SHALL classify those adjacent versions as removable under the policy's `excludeKeys` (`["fetched_at"]`), matching the connector's per-record fingerprint no-op-emit definition
- **AND** a version that changes any retained real field — for example a `balance_after_cents` move on a transaction, a read/unread `status` flip on an inbox message, a pending → posted transition (`status`/`posted_date`) on a current-activity row, or a `delivery_status` move on an order — SHALL remain a fingerprint boundary that is never collapsed
- **AND** every distinct real value that ever appeared in the history SHALL survive as a retained version boundary

#### Scenario: The partial-scan forward gates never prune records outside the current run's window

- **WHEN** a USAA, Chase, or Amazon run observes only a subset of a partial-scan stream's records (an overlapping incremental transaction window, the dashboard's recent current-activity rows, or the unfrozen subset of order years)
- **THEN** the connector's `usaa/transactions`, `chase/current_activity`, and `amazon/orders` fingerprint cursors SHALL retain the fingerprints of records not observed this run (they SHALL NOT `pruneStale` them)
- **AND** when a later run re-surfaces an unchanged record from outside the prior window, the retained fingerprint SHALL suppress the re-emit rather than appending a new run-clock-only version
- **AND** the full-scan `usaa/inbox_messages` cursor MAY prune a message no longer listed so a re-appearance re-emits exactly once

#### Scenario: The inventory churn-gate policies collapse pure file-stat churn but preserve every inventory transition

- **WHEN** a `claude-code/backup_inventory`, `codex/history`, or any other registered inventory churn-gate stream key's history contains adjacent versions whose only difference is the incidental `mtime_epoch`/`size_bytes` file-stat metadata
- **THEN** the tool SHALL classify those adjacent versions as removable under the policy's `excludeKeys` (`["mtime_epoch", "size_bytes"]`), matching the connector's `openInventoryFingerprintCursor` no-op-emit definition
- **AND** a version that changes any retained inventory field — the `relative_path`/`path_hash`, `type`, `classification`, or `reason` — SHALL remain a fingerprint boundary that is never collapsed
- **AND** the connector-side inventory fingerprint cursor SHALL prune a store no longer present so its re-appearance re-emits exactly once

### Requirement: The reference AS SHALL support RFC 7592 client deletion for dynamic clients

The reference AS SHALL expose `DELETE /oauth/register/{client_id}` to delete a dynamically-registered OAuth client. The endpoint SHALL be authenticated by the owner session cookie (the dashboard is the operator-facing caller; PDPP does not issue RFC 7592 registration access tokens). Deletion SHALL cascade-revoke every `grants` row tied to the deleted client and every owner self-export token row tied to the deleted client so that bearer tokens issued against it become inactive on subsequent introspect.

#### Scenario: Owner deletes a client they registered

- **WHEN** an operator with a valid owner session POSTs to `DELETE /oauth/register/{client_id}` for a `registration_mode = 'dynamic'` client whose `metadata.issuer_subject_id` matches the operator's session subject
- **THEN** the AS SHALL revoke every grant where `client_id = {client_id}` via the existing `revokeGrant` codepath
- **AND** SHALL revoke every owner self-export token where `client_id = {client_id}`
- **AND** SHALL delete the `oauth_clients` row
- **AND** SHALL emit a `client.deleted` spine event with the cascade summary
- **AND** SHALL respond 204

#### Scenario: Owner attempts to delete a different operator's client

- **WHEN** an operator's owner session subject does not match the target client's `metadata.issuer_subject_id`
- **THEN** the AS SHALL respond 403 `forbidden`
- **AND** SHALL NOT delete the client or revoke any grants

#### Scenario: Owner attempts to delete a pre-registered client

- **WHEN** the target client's `registration_mode` is not `'dynamic'`
- **THEN** the AS SHALL respond 403 `forbidden`
- **AND** SHALL NOT delete the client or revoke any grants

#### Scenario: Idempotent delete

- **WHEN** the operator deletes the same `client_id` twice
- **THEN** the second call SHALL respond 404 `not_found`
- **AND** SHALL NOT 5xx

#### Scenario: Bearers issued against a deleted client introspect as inactive

- **WHEN** a bearer was issued via the device flow against a now-deleted dynamic client
- **THEN** subsequent `POST /introspect` for that owner self-export bearer SHALL return `{ active: false, inactive_reason: 'token_revoked' }`

#### Scenario: Grant-bound client bearers issued against a deleted client introspect as grant-revoked

- **WHEN** a grant-bound client bearer was issued against a now-deleted dynamic client
- **THEN** subsequent `POST /introspect` for that grant-bound bearer SHALL return `{ active: false, inactive_reason: 'grant_revoked' }`

### Requirement: The reference AS SHALL stamp `issuer_subject_id` metadata on DCR registrations from owner-authed callers

The reference AS SHALL stamp and persist `issuer_subject_id` on `POST /oauth/register` requests when the request carries a valid owner session cookie. The persisted value SHALL equal the requesting owner session's subject. The AS SHALL NOT trust a caller-supplied `issuer_subject_id`; anonymous DCR requests SHALL silently drop `issuer_subject_id` if present in the body.

#### Scenario: Owner-authed DCR with issuer_subject_id

- **WHEN** the dashboard POSTs `/oauth/register` with `{ client_name, token_endpoint_auth_method: 'none' }` while carrying a valid owner session cookie
- **THEN** the AS SHALL persist `client_name` and AS-stamped `issuer_subject_id` on the new `oauth_clients` row
- **AND** SHALL return the registered client metadata in the response

#### Scenario: Anonymous DCR cannot set issuer_subject_id

- **WHEN** an anonymous caller POSTs `/oauth/register` with `issuer_subject_id` in the body
- **THEN** the AS SHALL register the client without persisting `issuer_subject_id`
- **AND** the registered client SHALL NOT appear in any operator's `GET /_ref/clients?owner=true` listing

### Requirement: The reference AS SHALL expose an operator-issued client listing under `/_ref/clients`

The reference AS SHALL expose `GET /_ref/clients?owner=true`, owner-session-gated, returning the dynamic clients whose `metadata.issuer_subject_id` matches the requesting owner session's subject. Each list entry SHALL include `client_id`, `client_name`, `created_at`, and the count of currently-active bearer tokens tied to the client.

#### Scenario: Operator lists their own dashboard-issued clients

- **WHEN** an operator with a valid owner session GETs `/_ref/clients?owner=true`
- **THEN** the AS SHALL return `{ object: 'list', data: [{ client_id, client_name, created_at, active_token_count }, ...] }`
- **AND** the data SHALL contain only clients with `registration_mode = 'dynamic'` and `metadata.issuer_subject_id` equal to the operator's session subject
- **AND** SHALL NOT include pre-registered clients (e.g. `pdpp-web-dashboard`, `cli_longview`)

#### Scenario: Owner-session-gated

- **WHEN** a caller GETs `/_ref/clients?owner=true` without a valid owner session
- **THEN** the AS SHALL respond 401 `owner_session_required`

### Requirement: Query capability discovery is self-service

The reference RS SHALL expose a public schema/capability discovery surface that lets a bearer enumerate the queryable sources and streams visible to that bearer without relying on out-of-band connector IDs or prior stream knowledge.

#### Scenario: Owner token discovers polyfill schemas

- **WHEN** an owner-token caller requests the schema/capability discovery endpoint in polyfill mode
- **THEN** the response SHALL include the owner-visible connectors and their streams
- **AND** each stream entry SHALL include schema, query declarations, field capabilities, expansion capabilities, and freshness metadata where available
- **AND** the caller SHALL NOT need to provide a `connector_id` to discover the connector IDs.

#### Scenario: Client token discovers only grant scope

- **WHEN** a client-token caller requests the schema/capability discovery endpoint
- **THEN** the response SHALL include only the source and streams authorized by the grant
- **AND** field capabilities SHALL mark unavailable operations consistently with the per-stream metadata endpoint.

#### Scenario: Discovery uses the existing capability model

- **WHEN** the discovery endpoint reports stream field or expansion capabilities
- **THEN** those values SHALL be derived from the same manifest, grant, and metadata rules used by `GET /v1/streams/:stream`
- **AND** the implementation SHALL NOT maintain a second independent field-capability source of truth.

#### Scenario: Core documentation names schema discovery

- **WHEN** a reader consults Core Section 8 for the Resource Server query surface
- **THEN** the documentation SHALL name `GET /v1/schema` as the bearer-scoped schema and capability discovery endpoint
- **AND** it SHALL describe the response envelope with `object: "schema"`, bearer scope, connectors, and stream metadata entries.

### Requirement: Query affordance documentation is copy-pasteable

The reference documentation SHALL provide working examples for the currently supported query affordances, including stream-scoped search filters, range-filtered record listing, aggregation calls, first `changes_since` sync, `expand[]`, and `blob_ref.fetch_url`.

#### Scenario: A caller uses the wrong search filter spelling

- **WHEN** a caller needs to filter search results to a stream
- **THEN** the documentation SHALL show the supported `streams[]` request shape
- **AND** it SHALL NOT imply that `filter[stream]` or `filter[connector_id]` are valid search filters.

#### Scenario: A caller needs attachment bytes

- **WHEN** a record includes a visible `data.blob_ref.fetch_url`
- **THEN** the documentation SHALL describe that URL as the supported byte-fetch path
- **AND** it SHALL NOT imply that attachment-specific content endpoints exist unless they are implemented and tested.

#### Scenario: A caller discovers aggregate support

- **WHEN** a caller reads Core Section 8 stream metadata and aggregate documentation
- **THEN** the documentation SHALL describe `field_capabilities`, `expand_capabilities`, and `query.aggregations`
- **AND** it SHALL describe `GET /v1/streams/{stream}/aggregate` with `metric`, `field`, `group_by`, and `filter[...]` parameters.

#### Scenario: A caller bootstraps change tracking

- **WHEN** a caller reads Core Section 8 incremental-sync documentation
- **THEN** the documentation SHALL name `changes_since=beginning` as the initial-session bootstrap sentinel
- **AND** it SHALL tell clients to persist the terminal page's `next_changes_since` for later sessions.

#### Scenario: A caller starts from protected-resource metadata

- **WHEN** a caller reads Core Section 8 discovery guidance
- **THEN** the documentation SHALL describe `pdpp_discovery_hints` as the protected-resource metadata block that points to schema discovery, query base, aggregate templates, the change-tracking bootstrap sentinel, and blob indirection.

#### Scenario: A caller lands on the superseded companion page

- **WHEN** a reader opens the historical Data Query API companion page
- **THEN** the page SHALL contain no independent normative endpoint contract
- **AND** it SHALL redirect the reader to Core Section 8 as the authoritative Resource Server query interface.

### Requirement: An unauthenticated discovery index points cold-start callers at the next hop

The reference AS and RS SHALL expose an unauthenticated `GET /` JSON pointer that names the well-known endpoint, the running reference revision, and (on the RS) the schema endpoint and core query base. The pointer SHALL NOT duplicate the well-known capability document; it SHALL only direct the caller to it.

#### Scenario: A cold-start caller probes the RS root

- **WHEN** an unauthenticated caller requests `GET /` on the resource server
- **THEN** the response SHALL be a 200 JSON document with `object: "pdpp_discovery_index"` and `role: "resource_server"`
- **AND** the document SHALL include a `links.well_known` value pointing to `/.well-known/oauth-protected-resource`
- **AND** the document SHALL include `links.schema` pointing to `/v1/schema`
- **AND** the document SHALL include `links.core_query_base` pointing to `/v1`
- **AND** the document SHALL include a `reference_revision` value matching the `PDPP-Reference-Revision` response header on the same server.

#### Scenario: A cold-start caller probes the AS root

- **WHEN** an unauthenticated caller requests `GET /` on the authorization server
- **THEN** the response SHALL be a 200 JSON document with `object: "pdpp_discovery_index"` and `role: "authorization_server"`
- **AND** the document SHALL include a `links.well_known_authorization_server` value pointing to `/.well-known/oauth-authorization-server`
- **AND** the document SHALL include a `reference_revision` value matching the `PDPP-Reference-Revision` response header on the same server.

#### Scenario: The discovery index is unauthenticated

- **WHEN** the discovery index is requested without an `Authorization` header
- **THEN** the server SHALL return the index document with status 200
- **AND** the server SHALL NOT redirect to a login flow or return 401.

### Requirement: Protected-resource metadata SHALL include explicit discovery hints

The resource server's protected-resource metadata document SHALL include a `pdpp_discovery_hints` block that names the canonical first-call shapes a caller needs after reading the document. The block SHALL be derived from the same runtime state that drives capability advertisement so it cannot drift from live behavior.

#### Scenario: Hints name the schema and query bases

- **WHEN** a caller reads `/.well-known/oauth-protected-resource`
- **THEN** the response SHALL include `pdpp_discovery_hints.schema_endpoint` equal to `/v1/schema`
- **AND** `pdpp_discovery_hints.query_base` equal to `/v1`.

#### Scenario: Hints name the search scoping shape

- **WHEN** the lexical retrieval extension is advertised on the resource server
- **THEN** `pdpp_discovery_hints.search.endpoint` SHALL equal `/v1/search`
- **AND** `pdpp_discovery_hints.search.scope_param` SHALL equal `streams[]`
- **AND** `pdpp_discovery_hints.search.filter_requires_single_stream` SHALL be `true` while the v1 single-stream constraint applies.

#### Scenario: Hints name the aggregate path

- **WHEN** a caller reads the protected-resource metadata
- **THEN** `pdpp_discovery_hints.aggregate.endpoint_template` SHALL equal `/v1/streams/{stream}/aggregate`.

#### Scenario: Hints name the bootstrap sentinel and blob indirection

- **WHEN** a caller reads the protected-resource metadata
- **THEN** `pdpp_discovery_hints.changes_since_bootstrap` SHALL equal `beginning`
- **AND** `pdpp_discovery_hints.blob_indirection` SHALL equal `data.blob_ref.fetch_url`.

#### Scenario: Hybrid pagination support is reported when hybrid is advertised

- **WHEN** the hybrid retrieval extension is advertised on the resource server
- **THEN** `pdpp_discovery_hints.hybrid_pagination_supported` SHALL match the live `capabilities.hybrid_retrieval.cursor_supported` value
- **AND** when hybrid retrieval is not advertised, the field SHALL be omitted rather than set to a default.

#### Scenario: Hints name the connector and stream metadata endpoints

- **WHEN** a caller reads the protected-resource metadata
- **THEN** `pdpp_discovery_hints.connectors_endpoint` SHALL equal `/v1/connectors`
- **AND** `pdpp_discovery_hints.streams_endpoint_template` SHALL equal `/v1/streams/{stream}`.

#### Scenario: Hints name the owner polyfill connector_id requirement

- **WHEN** the resource server is configured without a native manifest (i.e. owner reads are scoped to polyfilled connectors)
- **THEN** `pdpp_discovery_hints.owner_polyfill_requires_connector_id` SHALL be `true`
- **AND** when the resource server is configured with a native manifest (single-source mode), the field SHALL be omitted rather than set to `false`.

### Requirement: The discovery index links to the connector listing

The unauthenticated `GET /` discovery index on the resource server SHALL include a `links.connectors` value pointing to the canonical connector-listing endpoint, so cold-start callers can discover connector identifiers without guessing.

#### Scenario: A cold-start caller probes the RS root and discovers connectors

- **WHEN** an unauthenticated caller requests `GET /` on the resource server
- **THEN** the response SHALL include `links.connectors` equal to `/v1/connectors`.

### Requirement: Malformed `changes_since` errors SHALL name legal forms

When the resource server rejects a `changes_since` parameter as malformed, the error message SHALL name the two legal forms a caller can use: the `beginning` bootstrap sentinel and the `next_changes_since` cursor returned by a previous changes-feed response. This converts an opaque rejection into a self-teaching error that points the caller at the next valid call.

#### Scenario: Caller passes a non-cursor literal value such as an ISO timestamp

- **WHEN** a caller requests `GET /v1/streams/{stream}/records?changes_since=2024-01-01T00:00:00Z`
- **THEN** the resource server SHALL return a 400 response with `error.code` `invalid_cursor`
- **AND** the error message SHALL name `beginning` as the bootstrap sentinel
- **AND** the error message SHALL name `next_changes_since` as the cursor source returned by a prior changes-feed response.

### Requirement: Public CLI command surface SHALL use explicit namespaces
The reference implementation SHALL treat `@pdpp/cli` as the single public owner
of the `pdpp` binary. Public delegated-access commands and reference-operator
diagnostic commands SHALL share one command tree with explicit namespaces rather
than requiring two ambiguous `pdpp` installations.

#### Scenario: A user installs the public CLI
- **WHEN** a user installs or runs `@pdpp/cli`
- **THEN** the installed `pdpp` command SHALL expose public delegated-access commands such as `connect`
- **AND** reference-only diagnostic commands, if shipped, SHALL appear under an explicit reference namespace such as `pdpp ref ...`

#### Scenario: A reference diagnostic command is advertised
- **WHEN** docs, dashboard, or CLI help advertise a run, grant, or trace diagnostic command
- **THEN** the command SHALL include the explicit reference namespace
- **AND** it SHALL NOT use a top-level command shape that could be mistaken for a core PDPP protocol command

#### Scenario: A repo-local compatibility alias remains
- **WHEN** the repo-local reference wrapper preserves an old top-level operator alias
- **THEN** that alias SHALL be treated as compatibility behavior
- **AND** new public metadata, docs, and dashboard copy SHALL NOT advertise it

### Requirement: Publishable reference CLI commands SHALL be dependency-bounded
Reference/operator commands shipped in the public CLI package SHALL be limited
to commands whose implementation can run outside this repository without
importing reference-server internals, connector runtimes, Docker orchestration,
databases, local fixture directories, or deployment-only assets.

#### Scenario: A reference read command is moved into the public package
- **WHEN** a command such as `pdpp ref run timeline`, `pdpp ref grant timeline`, or `pdpp ref trace show` is shipped in `@pdpp/cli`
- **THEN** it SHALL call documented reference-designated HTTP routes
- **AND** it SHALL NOT bypass the server with direct database reads or local filesystem assumptions

#### Scenario: A command depends on local reference internals
- **WHEN** a command depends on local seed fixtures, server runtime modules, Docker topology, connector runtime internals, or repository-only setup
- **THEN** it SHALL remain repo-local or be excluded from public package help until a separate publishability review proves the boundary safe

### Requirement: Reference CLI owner authentication SHALL be operator-safe
The CLI SHALL support owner-session authentication for reference diagnostic
commands without requiring agents or users to paste owner bearer tokens or print
owner-session cookies into logs.

#### Scenario: Owner auth is enabled
- **WHEN** a caller runs a `pdpp ref ...` command against a reference deployment that requires owner auth
- **THEN** the CLI SHALL send an owner-session cookie from an explicit option, environment variable, or project-local owner-session cache
- **AND** it SHALL fail with an actionable login/session message when no valid owner session is available

#### Scenario: Owner session is persisted
- **WHEN** the CLI stores an owner session for reference-operator use
- **THEN** it SHALL store the session in the project-local PDPP cache with secret file permissions
- **AND** it SHALL NOT print the session cookie value in normal output

#### Scenario: A command needs a public client token
- **WHEN** a user runs public delegated-access commands such as `connect` or `token`
- **THEN** the CLI SHALL continue to use scoped client credentials rather than owner sessions
- **AND** the reference-operator owner-session mechanism SHALL NOT become the routine delegated-access fallback

### Requirement: Reference scheduler lifecycle is explicit

The reference server SHALL own the lifecycle for automatic scheduled connector
runs in long-lived local and Docker deployments.

#### Scenario: Scheduler starts after internal origins are known
- **WHEN** the reference server starts automatic scheduling
- **THEN** it SHALL start the scheduler only after AS and RS listeners have
  populated server-side loopback origins for connector children
- **AND** automatic scheduled runs SHALL use the same internal AS/RS origins as
  controller-managed manual runs

#### Scenario: Scheduler uses persisted schedule state
- **WHEN** a connector schedule is enabled
- **THEN** the scheduler SHALL derive automatic run cadence from the persisted
  schedule row
- **AND** disabled or deleted schedule rows SHALL NOT launch automatic runs

#### Scenario: Scheduler shares controller state
- **WHEN** an automatic scheduled run starts
- **THEN** it SHALL share controller/runtime state for connector path
  resolution, owner token issuance, active-run conflict prevention, connector
  state, needs-human state, and run-history persistence

#### Scenario: Scheduler shuts down safely
- **WHEN** the reference server begins graceful shutdown
- **THEN** it SHALL stop the scheduler before waiting for connector drain
- **AND** stopped scheduler retry/backoff timers SHALL NOT launch new connector
  attempts

#### Scenario: Docker runs the same scheduler lifecycle
- **WHEN** the Docker reference service runs the standard
  `reference-implementation/server/index.js` entrypoint
- **THEN** enabled persisted schedules SHALL execute through the same server-owned
  scheduler lifecycle as non-Docker long-lived startup

#### Scenario: Schedule projection reflects durable history after restart
- **WHEN** an operator-facing schedule projection is built for a persisted
  connector schedule (e.g. via `controller.listSchedules` or
  `controller.getSchedule`)
- **AND** no in-memory active-run row currently exists for that connector
- **THEN** the projection's `last_started_at`, `last_finished_at`,
  `last_successful_at`, and `last_error_code` fields SHALL reflect the
  durable `scheduler_run_history` (and `scheduler_last_run_times`) records
  for that connector when they exist
- **AND** the projection's `next_due_at` field SHALL be the projected next
  dispatch instant computed from the persisted last-run timestamp plus the
  configured interval whenever the persisted last-run anchor exists and the
  schedule is enabled
- **AND** a persisted schedule with neither an active run nor any persisted
  history SHALL retain null last-run/next-due fields so consumers can still
  identify genuinely never-fired schedules

### Requirement: Browser-surface substrate SHALL be isolated from reference-owned runtime integrations

The reference implementation SHALL consume backend-agnostic remote-surface lease/state-machine substrate from a private internal package. That package SHALL own remote-surface types, browser-surface lease state transitions, capacity policy, fencing tokens, queue ordering, restart reconciliation policy, and backend allocator interfaces. The package SHALL NOT import reference implementation, server, Docker, dashboard/Next-deployable, or connector modules.

Reference-owned code SHALL continue to own persistence adapters, spine and run events, connector launch integration, Docker Compose wiring, and allocator sidecar process implementation.

#### Scenario: Reference runtime acquires a browser-surface lease

- **WHEN** reference controller code needs browser-surface lease policy
- **THEN** it SHALL use the package-backed substrate implementation
- **AND** reference-specific storage, event emission, and connector launch env assembly SHALL remain outside the package

#### Scenario: Dynamic allocator work adds backend lifecycle support

- **WHEN** dynamic n.eko allocation adds allocator lifecycle behavior
- **THEN** allocator contracts MAY be defined in the substrate package
- **AND** Docker Engine access, Compose wiring, and the allocator sidecar process SHALL remain reference-owned

#### Scenario: Package dependency boundaries are checked

- **WHEN** `packages/remote-surface` is inspected
- **THEN** it SHALL NOT import from `reference-implementation`, server modules, Docker implementation code, the public-site or operator-console deployable (`apps/site`, `apps/console`), or connector modules

### Requirement: n.eko browser surfaces SHALL be leased before connector launch

When a connector run requires an n.eko-backed browser surface, the reference implementation SHALL acquire or queue a browser-surface lease before spawning the connector child process. The connector SHALL receive the selected surface through controller-owned launch metadata rather than discovering an arbitrary unmanaged browser surface as the production path.

#### Scenario: A connector is configured for managed n.eko

- **WHEN** reference configuration declares a connector id as requiring managed n.eko
- **THEN** each run for that connector SHALL request a browser-surface lease before connector spawn
- **AND** the reference SHALL fail fast on invalid managed n.eko capacity or static-profile configuration rather than silently falling back to unmanaged browser launch

#### Scenario: A connector is not configured for managed n.eko

- **WHEN** a connector is not declared as requiring managed n.eko
- **THEN** the reference MAY use the existing local browser launch or development remote-CDP override paths
- **AND** the connector SHALL NOT be placed into browser-surface queueing solely because n.eko support exists

#### Scenario: A compatible surface is available

- **WHEN** a connector run requires n.eko and a ready idle surface with a compatible profile key is available
- **THEN** the reference SHALL lease that surface before spawning the connector process
- **AND** the connector process SHALL receive lease-scoped browser metadata including a remote CDP URL
- **AND** the run SHALL NOT use an unrelated browser profile or surface

#### Scenario: Capacity is available but no surface exists

- **WHEN** a connector run requires n.eko, no compatible ready surface exists, and the active n.eko surface count is below the configured cap
- **THEN** the reference MAY start or allocate a compatible n.eko surface before connector launch
- **AND** the run SHALL remain in a surface-starting or waiting state until the surface is ready and leased

#### Scenario: The surface cap is full

- **WHEN** a connector run requires n.eko and the configured active-surface cap is already full
- **THEN** the reference SHALL queue the run before connector launch with an operator-visible waiting state
- **AND** the reference SHALL NOT spawn the connector child process until a compatible surface is leased
- **AND** the reference SHALL NOT silently fall back to headless, local, or shared-profile browser launch

#### Scenario: A queued run has not been promoted

- **WHEN** a connector run is waiting for a browser surface before connector spawn
- **THEN** the reference SHALL represent it as a queued launch request or pending browser-surface lease
- **AND** the reference SHALL NOT persist it in the active-run registry used for spawned connector children
- **AND** the reference SHALL NOT create active child-process state, active interaction state, a streaming nonce, or a `run.started` event

#### Scenario: A legacy remote-CDP override exists for a managed run

- **WHEN** a connector run requires managed n.eko and no lease-scoped CDP URL has been issued
- **THEN** the connector browser launch SHALL fail closed with runtime-resource classification
- **AND** it SHALL NOT satisfy the managed requirement by using `PDPP_<PROFILE>_REMOTE_CDP_URL`, headless launch, or local launch

### Requirement: n.eko browser-surface leasing SHALL be atomic and fenced

The reference implementation SHALL enforce browser-surface cap, lease ownership, queued-run uniqueness, and release behavior atomically so concurrent run starts cannot over-allocate n.eko surfaces or corrupt profile isolation.

#### Scenario: Concurrent runs request the final available surface

- **WHEN** two managed n.eko runs concurrently request browser-surface capacity and only one compatible surface slot is available
- **THEN** exactly one run SHALL receive or start a leased surface
- **AND** the other run SHALL remain queued or deferred according to policy
- **AND** the configured active-surface cap SHALL NOT be exceeded

#### Scenario: A surface is already leased

- **WHEN** a browser surface has a non-terminal leased row
- **THEN** the reference SHALL NOT issue a second active lease for that same surface
- **AND** any waiting run SHALL be queued, deferred, or rejected according to profile compatibility and wait policy

#### Scenario: A run already has a pending lease

- **WHEN** a run id already has a non-terminal browser-surface lease
- **THEN** the reference SHALL NOT create a duplicate non-terminal lease for the same run
- **AND** a duplicate launch request for the same connector/profile SHALL return or reference the existing pending run rather than enqueue unbounded duplicate work

#### Scenario: A stale release arrives after a newer lease

- **WHEN** a release request uses an old lease id or fencing token for a surface that has since been leased again
- **THEN** the reference SHALL ignore or reject the stale release
- **AND** it SHALL NOT release the newer lease or unblock another queued run from stale state

### Requirement: n.eko surface queueing SHALL preserve operator clarity

The reference implementation SHALL expose queued, leased, released, deferred, expired, and cancelled browser-surface lease states through reference-only run/operator artifacts so the owner can distinguish resource backpressure from connector failure.

#### Scenario: A queued run is inspected

- **WHEN** the owner inspects a run waiting for an n.eko surface
- **THEN** the reference SHALL show browser-surface status such as queued, starting, leased, deferred, expired, or cancelled
- **AND** active-run status SHALL remain reserved for spawned connector children
- **AND** the status SHALL NOT be reported as a connector authentication failure, protocol failure, or invisible hang

#### Scenario: A queued run times out

- **WHEN** a queued browser-surface run exceeds the configured wait policy
- **THEN** the reference SHALL mark the run or lease as deferred with retry metadata and runtime-resource classification
- **AND** the failure SHALL be classified as runtime resource backpressure rather than as connector output failure

#### Scenario: An owner cancels a queued run

- **WHEN** the owner cancels a run that is waiting for a browser surface
- **THEN** the reference SHALL mark the browser-surface lease as cancelled
- **AND** it SHALL NOT spawn the connector after cancellation

#### Scenario: Browser-surface capacity becomes available

- **WHEN** a leased surface is released and compatible queued runs exist
- **THEN** the reference SHALL select the next run by priority class and FIFO order
- **AND** it SHALL promote the selected queued run through the normal active-run spawn path
- **AND** it SHALL emit browser-surface lease events before any connector `run.started` event

### Requirement: n.eko surface leases SHALL preserve profile isolation

The reference implementation SHALL associate each n.eko surface with a stable profile key and SHALL NOT share a live browser surface across incompatible profile keys. The profile key MAY initially be connector-scoped, but the architecture SHALL leave room for account-scoped profile keys.

#### Scenario: Two connectors require browser surfaces

- **WHEN** two connector runs have different profile keys
- **THEN** the reference SHALL NOT reuse the same live n.eko browser surface for both runs
- **AND** any queueing decision SHALL preserve the profile boundary rather than trading it for throughput

#### Scenario: Static single-surface mode receives an incompatible profile key

- **WHEN** the first tranche static n.eko mode is configured with one fixed profile key
- **AND** a managed run requests a different profile key
- **THEN** the reference SHALL defer or reject the run with runtime-resource classification
- **AND** it SHALL NOT wait forever, reprofile the static surface, or reuse the incompatible profile

#### Scenario: Multi-account support is added later

- **WHEN** the reference gains multiple accounts for one browser-backed connector
- **THEN** the browser-surface lease model SHALL support account-distinct profile keys without requiring a new browser-surface concept

### Requirement: n.eko surface leases SHALL reconcile after restart

The reference implementation SHALL persist enough browser-surface lease state to reconcile queued, starting, and leased runs after reference restart without deleting browser profile state.

#### Scenario: A leased run is not active after restart

- **WHEN** the reference starts and finds a persisted leased browser surface whose run is no longer active
- **THEN** the reference SHALL release the stale lease if the surface is healthy, or expire it if the surface is missing
- **AND** it SHALL preserve the associated browser profile volume or directory

#### Scenario: A surface is missing after restart

- **WHEN** the reference starts and finds a persisted lease whose n.eko surface is no longer live or healthy
- **THEN** the reference SHALL mark a missing-surface lease expired and an unhealthy-surface lease surface-failed with runtime-resource classification
- **AND** it SHALL free capacity for future runs

#### Scenario: A queued run is recovered after restart

- **WHEN** the reference starts and finds a queued browser-surface run that has not expired or been cancelled
- **THEN** the reference SHALL keep it queued if it is within wait policy, defer it if it exceeded wait policy, or defer it if static profile compatibility cannot ever satisfy it
- **AND** it SHALL NOT report it as an already-running connector child

#### Scenario: Reconciliation runs before new launches

- **WHEN** the reference process boots with persisted browser-surface leases
- **THEN** it SHALL reconcile those leases after storage initialization and before routes or schedules can start new connector runs
- **AND** queued-but-not-started runs SHALL NOT be classified as abandoned active connector runs

### Requirement: Remote-surface package exports SHALL define an OSS-spinnable boundary

The reference implementation SHALL define `@pdpp/remote-surface` package exports around host-neutral remote-surface concepts before moving full streaming architecture code into the package. Exported APIs SHALL be organized by protocol, server broker, client viewer/controllers, backend adapters, diagnostics, leases, and test utilities rather than by PDPP route names or dashboard file structure.

#### Scenario: Package exports are introduced

- **WHEN** implementation adds full streaming architecture exports to `@pdpp/remote-surface`
- **THEN** the exports SHALL provide stable destinations for protocol schemas, server broker interfaces, client controllers, backend adapters, diagnostics, leases, and testing fakes
- **AND** new generic streaming code SHALL NOT be added to reference-only modules when a package export destination already exists

#### Scenario: Package documentation is inspected

- **WHEN** the package README or API docs describe the remote-surface architecture
- **THEN** they SHALL describe host-neutral remote-surface concepts and implemented package exports
- **AND** they SHALL NOT claim implemented controllers are scaffold-only or require PDPP `_ref` routes, run timelines, owner auth, connector registration, or Docker lifecycle as package concepts

### Requirement: Remote-surface streaming primitives SHALL be package-owned and host-adapted

The reference implementation SHALL extract backend-neutral remote-surface streaming primitives into `@pdpp/remote-surface` before treating the architecture as OSS-spinnable. The package SHALL own generic protocol shapes, session broker interfaces, client viewer interfaces, backend adapter interfaces, input/viewport/clipboard channel shapes, diagnostics schema, and allocator/session seams. The reference implementation SHALL remain the host adapter for PDPP-specific routes, run timelines, auth, persistence, and connector handoff.

#### Scenario: A host creates a remote-surface session

- **WHEN** reference owner auth has authorized a stream mint request for a pending run interaction
- **THEN** the reference SHALL map that authorized request into a package remote-surface session creation call
- **AND** the package session descriptor SHALL use generic remote-surface identity and capability fields
- **AND** PDPP `run_id`, `interaction_id`, owner auth, spine event names, and `_ref` route paths SHALL remain host-owned metadata and routing concerns

#### Scenario: The in-memory session broker is extracted

- **WHEN** the package provides a default in-memory session broker
- **THEN** it SHALL preserve token minting, idempotency replay, attach and authorize semantics, expiry, revocation, and invalidation behavior through package conformance tests
- **AND** hosts SHALL remain able to supply a durable store or host-specific persistence adapter

#### Scenario: A browser client opens a stream

- **WHEN** the dashboard opens a stream through reference `_ref` routes
- **THEN** the reference SHALL adapt the request to package attach, authorize, event-channel, input-channel, viewport-channel, clipboard-channel, and diagnostics primitives
- **AND** the browser-visible descriptor SHALL expose only scoped remote-surface capabilities and token-scoped proxy/session information
- **AND** it SHALL NOT expose raw CDP WebSocket URLs, allocator credentials, Docker hostnames, or connector-owned backend lifecycle authority

#### Scenario: Package dependency boundaries are checked

- **WHEN** `packages/remote-surface` is inspected
- **THEN** it SHALL NOT import from `reference-implementation`, the public-site or operator-console deployable (`apps/site`, `apps/console`), `packages/polyfill-connectors`, Docker implementation code, or server route modules

### Requirement: Remote-surface client behavior SHALL be reusable outside the dashboard

The package SHALL expose client APIs for mounting and unmounting a viewer, dispatching pointer/keyboard/text/clipboard input, managing mobile keyboard and IME behavior, reporting viewport and layout changes, enforcing clipboard capability policy, and subscribing to telemetry. Dashboard React components, owner-facing copy, URL resolution, route actions, and styling SHALL remain outside the package.

#### Scenario: The dashboard mounts a n.eko-backed viewer

- **WHEN** the dashboard receives a n.eko-capable stream descriptor
- **THEN** it SHALL mount the viewer through the package client API
- **AND** n.eko client implementation details SHALL remain behind the package adapter boundary
- **AND** dashboard code SHALL remain responsible only for React lifecycle, layout, owner messaging, and route-specific URL resolution

#### Scenario: Mobile input requires IME handling

- **WHEN** a mobile owner focuses a remote text field and enters text through a software keyboard or IME
- **THEN** package-owned client controllers SHALL translate keyboard, composition, and text-commit behavior into backend-neutral remote-surface input operations
- **AND** dashboard-only handlers SHALL NOT be the only implementation of IME, text commit, or keysym behavior

#### Scenario: Clipboard access is constrained

- **WHEN** a viewer copies from or pastes into the remote browser
- **THEN** the package client API SHALL model clipboard capabilities and explicit fallback paths
- **AND** host and dashboard code MAY decide how to present prompts or manual fallback UI
- **AND** clipboard contents SHALL NOT be written to diagnostics by default

### Requirement: Backend adapters SHALL hide backend authority behind capabilities

The package SHALL expose backend adapter interfaces that normalize n.eko, CDP fallback, and future remote-surface backends behind capability declarations. Backend-specific authority such as raw CDP targets, n.eko upstream origins, allocator credentials, Docker resources, or browser automation control SHALL remain server-side or host-owned unless explicitly represented as a safe scoped capability.

#### Scenario: n.eko is selected for an owner-operated browser session

- **WHEN** a package broker or host adapter selects a n.eko backend
- **THEN** the client-visible configuration SHALL route through token-scoped same-origin proxy/session information
- **AND** n.eko upstream origins and sidecar credentials SHALL be constrained by host-approved allowlists

#### Scenario: CDP fallback is selected

- **WHEN** a CDP-backed stream is used for fallback, debug, or automation-friendly sessions
- **THEN** raw CDP HTTP and WebSocket URLs SHALL remain server-side
- **AND** browser clients SHALL interact only with package event/input/viewport/clipboard channels exposed by the host adapter

#### Scenario: A future backend is added

- **WHEN** a CDP/VNC/Kasm-like backend is added later
- **THEN** it SHALL implement the package backend adapter interface and capability model
- **AND** it SHALL NOT require dashboard or connector code to learn backend-specific lifecycle authority

### Requirement: Dynamic n.eko allocation SHALL consume package seams without owning streaming extraction

Dynamic n.eko allocation SHALL depend on package-owned lease, allocator, session, target descriptor, and diagnostics seams. Docker Engine access, Compose wiring, allocator sidecar implementation, image pins, labels, networks, profile storage, readiness probes, and operator configuration SHALL remain reference-owned unless a later OpenSpec change extracts a backend allocator package.

#### Scenario: Dynamic allocation creates a surface

- **WHEN** dynamic mode ensures or starts a n.eko browser surface
- **THEN** it SHALL produce package-compatible lease/session/target descriptors for the reference streaming host adapter
- **AND** the connector SHALL receive only lease-scoped browser metadata needed for its run
- **AND** Docker lifecycle authority SHALL NOT be granted to connector code or browser clients

#### Scenario: Dynamic allocation work proceeds before full streaming extraction

- **WHEN** `add-dynamic-neko-surface-allocation` is implemented before this full streaming extraction is complete
- **THEN** it SHALL consume the existing package lease substrate and define only the minimal package-compatible streaming descriptors it needs
- **AND** it SHALL NOT absorb server broker, dashboard viewer, clipboard, keyboard, telemetry, or generic backend adapter extraction into the dynamic allocation tranche

#### Scenario: A backend allocator package is considered later

- **WHEN** the project decides Docker-backed dynamic allocation should become independently reusable
- **THEN** that decision SHALL be proposed as a separate OpenSpec change
- **AND** it SHALL NOT be implied by extracting `@pdpp/remote-surface`

### Requirement: Remote-surface extraction SHALL preserve behavioral parity by tranche

Each remote-surface extraction tranche SHALL include package conformance tests, reference parity tests, and import-boundary checks before it is marked complete. The reference SHALL preserve current `_ref` route behavior and dashboard owner UX until package-backed replacements are proven equivalent.

#### Scenario: Protocol parsing moves into the package

- **WHEN** event, frame, input, viewport, clipboard, target, or diagnostics parsing moves from reference or dashboard code into `@pdpp/remote-surface`
- **THEN** package tests SHALL include fixture cases generated from the current reference/dashboard payload shapes
- **AND** reference tests SHALL prove the existing route or viewer behavior still accepts and emits the same externally visible payloads

#### Scenario: Client viewer policy moves into the package

- **WHEN** viewport classification, geometry, clipboard policy, media-settle, visual-quality, keyboard, IME, or pointer policy moves into `@pdpp/remote-surface`
- **THEN** package tests SHALL preserve the current focused behavior tests
- **AND** dashboard code SHALL remain responsible for React lifecycle, route URL resolution, product copy, styling, and owner-specific affordances

#### Scenario: An extraction tranche completes

- **WHEN** an implementation tranche is reported complete
- **THEN** the report SHALL include an import-boundary sweep showing the package does not import reference, dashboard, connector, Docker, or server-route modules
- **AND** it SHALL identify any compatibility shim left in the reference implementation

### Requirement: Dynamic n.eko surfaces SHALL be allocated behind the lease boundary

The reference implementation SHALL allocate dynamic n.eko browser surfaces through a controller-owned allocator boundary when configured for dynamic managed n.eko mode. Connectors SHALL receive only lease-scoped browser metadata and SHALL NOT create, select, or stop n.eko containers directly.

#### Scenario: Dynamic mode has capacity

- **WHEN** a managed n.eko connector run requests a profile key with no compatible ready idle surface
- **AND** the active n.eko surface count is below the configured cap
- **THEN** the reference SHALL create or ensure a dynamic surface for that profile key before connector launch
- **AND** the connector child SHALL NOT be spawned until the dynamic surface is ready and leased

#### Scenario: Dynamic mode is not configured correctly

- **WHEN** managed n.eko dynamic mode is enabled without allocator configuration, valid capacity, profile storage policy, or stream proxy configuration
- **THEN** reference startup SHALL fail fast with a runtime configuration error
- **AND** managed connectors SHALL NOT silently fall back to static, local, headless, or unmanaged remote-CDP browser launch

#### Scenario: Connector code runs with a dynamic surface

- **WHEN** a dynamic n.eko surface is leased for a connector run
- **THEN** the connector process SHALL receive lease-scoped surface metadata including the lease id, surface id, profile key, remote CDP URL, and stream base URL
- **AND** the connector SHALL NOT receive Docker lifecycle authority as part of the browser binding

### Requirement: Dynamic n.eko surfaces SHALL preserve browser profile isolation

The reference implementation SHALL associate each dynamic n.eko surface with persistent profile storage derived from the lease profile key. A live dynamic surface SHALL NOT be shared across incompatible profile keys.

#### Scenario: Two managed connectors use different profile keys

- **WHEN** two managed n.eko connector runs request different profile keys
- **THEN** the reference SHALL allocate or reuse separate dynamic surfaces for those profile keys
- **AND** it SHALL NOT satisfy either run by sharing the other run's live browser profile

#### Scenario: A dynamic surface becomes idle

- **WHEN** a dynamic n.eko surface has no active lease
- **THEN** the reference MAY keep the surface warm until idle TTL expires
- **AND** idle cleanup SHALL stop the container without deleting the persistent profile storage

#### Scenario: Docker resources are named

- **WHEN** the allocator creates containers, volumes, or directories for a profile key
- **THEN** it SHALL derive resource names from a sanitized or hashed representation
- **AND** it SHALL NOT embed raw connector URLs, account identifiers, or owner data directly in Docker resource names

### Requirement: Dynamic n.eko lease promotion SHALL be readiness gated

The reference implementation SHALL classify a dynamic n.eko surface as leaseable only after container/network, n.eko HTTP, CDP, and browser readiness checks pass. Stream descriptor authorization SHALL remain server-side, and authenticated stream readiness SHALL be verified by the interaction adapter when an interaction starts.

#### Scenario: Surface startup is in progress

- **WHEN** a dynamic n.eko surface has been requested but readiness checks have not passed
- **THEN** the corresponding lease SHALL remain in a pre-spawn starting or waiting browser-surface state
- **AND** the reference SHALL NOT emit `run.started` for that connector run

#### Scenario: Readiness succeeds

- **WHEN** the allocator reports that container/network, n.eko HTTP, CDP, and browser readiness checks have passed
- **THEN** the reference SHALL mark the lease `leased`
- **AND** it SHALL emit browser-surface lease events before spawning the connector child

#### Scenario: Readiness fails

- **WHEN** a dynamic surface fails startup or readiness checks before connector launch
- **THEN** the reference SHALL mark the lease as `surface_failed` or `deferred` with runtime-resource classification
- **AND** it SHALL NOT report the failure as connector authentication failure, connector protocol failure, or connector output failure

### Requirement: Dynamic n.eko capacity SHALL include starting and idle surfaces

The reference implementation SHALL enforce the configured active n.eko surface cap across starting, ready idle, leased, and unhealthy dynamic surfaces until those surfaces are stopped or reconciled out of the active set.

#### Scenario: A surface is starting

- **WHEN** a dynamic surface container has been requested but is not yet ready
- **THEN** it SHALL count against the configured active-surface cap
- **AND** another run SHALL NOT over-allocate capacity by ignoring the starting surface

#### Scenario: Capacity is full with idle surfaces

- **WHEN** the configured active-surface cap is full because of ready idle dynamic surfaces
- **THEN** the reference MAY stop idle surfaces according to idle TTL policy
- **AND** runs that still cannot obtain compatible capacity SHALL remain queued or deferred according to wait policy

#### Scenario: Capacity becomes available

- **WHEN** a dynamic surface is released, stopped after idle TTL, or reconciled as expired
- **THEN** the reference SHALL run the browser-surface queue pump
- **AND** queued runs SHALL be promoted by priority class and FIFO order only after compatible capacity is available

### Requirement: Dynamic n.eko surfaces SHALL reconcile after restart

The reference implementation SHALL reconcile persisted browser-surface leases and surface rows with allocator/container state after reference restart and before accepting new managed n.eko launches.

#### Scenario: A live healthy surface exists after restart

- **WHEN** the reference starts and finds a live healthy dynamic n.eko container for a persisted surface
- **THEN** it SHALL retain that surface if it is under cap and profile-compatible
- **AND** it SHALL release stale leases whose connector run is no longer active without deleting profile storage

#### Scenario: A starting surface exists after restart

- **WHEN** the reference starts and finds a persisted `starting_surface` lease
- **THEN** it SHALL resume readiness reconciliation if the allocator still has the corresponding container
- **AND** it SHALL fail or defer the lease with runtime-resource classification if the container is missing or unhealthy

#### Scenario: A dynamic container is missing after restart

- **WHEN** the reference starts and a persisted non-terminal lease references a missing dynamic container
- **THEN** it SHALL mark the lease expired or surface-failed according to policy
- **AND** it SHALL preserve the profile volume or directory for future runs

### Requirement: Dynamic n.eko allocation SHALL be constrained to reference-owned resources

The reference implementation SHALL restrict dynamic allocator operations to reference-owned n.eko containers, networks, and profile volumes identified by explicit configuration and labels.

#### Scenario: The allocator lists containers

- **WHEN** the allocator discovers existing Docker containers or volumes
- **THEN** it SHALL manage only resources carrying the expected reference-owned labels
- **AND** it SHALL ignore or reject operations against unlabeled or foreign resources

#### Scenario: The n.eko image is selected

- **WHEN** dynamic mode starts an n.eko container
- **THEN** it SHALL use the configured pinned image or locally built tagged image
- **AND** it SHALL NOT pull or run an arbitrary image name supplied by connector code or run input

#### Scenario: A stream descriptor is produced

- **WHEN** the allocator returns stream metadata for a dynamic surface
- **THEN** the descriptor SHALL route through reference-approved proxy or WebRTC configuration
- **AND** it SHALL NOT expose arbitrary allocator/container hostnames to the owner-facing client

### Requirement: Reference AS/RS semantics SHALL be operation-owned

The reference implementation SHALL define AS, RS, and `_ref` behavior through canonical operation implementations that can be mounted by multiple hosts. HTTP frameworks, website route handlers, tests, and sandbox surfaces SHALL call those operations rather than reimplementing their semantics.

#### Scenario: Same operation mounted by multiple hosts

- **WHEN** the same reference operation is exposed by the native local server and by a sandbox route host
- **THEN** both hosts SHALL execute the same operation implementation
- **AND** host-specific code SHALL be limited to request adaptation, response adaptation, origin resolution, and environment profile selection

#### Scenario: Host attempts to reimplement reference behavior

- **WHEN** a host or UI surface constructs an AS/RS response that corresponds to a canonical reference operation
- **THEN** the change SHALL be rejected unless it is explicitly marked as a fixture-only test helper and cannot be reached as a public reference surface

### Requirement: Environment profiles SHALL compose dependencies, not fork behavior

The reference implementation SHALL model local, Docker, sandbox, and test environments as profiles that provide concrete dependencies to the same reference operations. Profiles SHALL NOT define alternate AS/RS semantics.

#### Scenario: Sandbox fixture profile

- **WHEN** the sandbox exposes `/sandbox/v1/**`, `/sandbox/_ref/**`, or `/sandbox/.well-known/**`
- **THEN** those routes SHALL mount reference operations using a sandbox fixture profile
- **AND** the sandbox fixture profile SHALL provide deterministic storage, deterministic clock/ids, fixture search indexes, and disabled or scripted connector execution

### Requirement: Storage and retrieval contracts SHALL be capability-specific

Storage and search abstractions used by reference operations SHALL be named around PDPP capabilities and obligations. Generic repository or table-shaped abstractions SHALL NOT be introduced as operation dependencies.

#### Scenario: Record listing abstraction

- **WHEN** `rs.records.list` needs data access
- **THEN** it SHALL depend on a record-capability contract such as `RecordStore.listGrantedRecords`
- **AND** it SHALL NOT depend on a generic table repository, raw SQLite handle, raw Postgres pool, or query-builder instance

#### Scenario: Retrieval abstraction

- **WHEN** lexical, semantic, or hybrid retrieval is implemented through an adapter
- **THEN** the adapter contract SHALL preserve retrieval-mode-specific score semantics, index identity, filtering, freshness state, and fallback behavior
- **AND** operation code SHALL NOT collapse those modes into an ambiguous generic search provider

### Requirement: Paginated reference contracts SHALL use explicit cursor semantics

Reference-runtime contracts SHALL NOT depend on implicit SQLite `rowid` behavior. Any paginated capability method SHALL define an explicit stable tiebreaker and SHALL treat cursors as opaque adapter-owned tokens.

#### Scenario: Adapter without implicit rowid

- **WHEN** a reference operation is backed by an adapter that does not expose SQLite `rowid`
- **THEN** the operation SHALL still paginate deterministically using the capability contract's explicit ordering and tiebreaker
- **AND** operation code SHALL NOT inspect or construct database-specific cursor internals

### Requirement: Record storage contracts SHALL own ordering and version semantics

Record storage contracts SHALL define cursor-field comparison semantics, missing-value bucket semantics, and per-stream version allocation. These semantics SHALL NOT be inherited accidentally from a database engine's JSON extraction, collation, or single-writer behavior.

#### Scenario: Record cursor field is database JSON

- **WHEN** an adapter stores record data as JSON or JSONB
- **THEN** `RecordStore` SHALL preserve the manifest-declared cursor ordering and missing-value behavior regardless of the database's native JSON value affinity
- **AND** unsupported cursor comparison modes SHALL fail or fall back explicitly rather than silently changing page order

#### Scenario: Concurrent record ingest

- **WHEN** two records are ingested for the same `(connector_id, stream)`
- **THEN** the adapter SHALL allocate monotonically increasing versions in the same atomic unit that writes the live record and change-log row
- **AND** the reference operation SHALL not rely on SQLite's single-writer behavior for correctness

### Requirement: Retrieval contracts SHALL disclose backend identity

Lexical and semantic retrieval contracts SHALL expose backend identity and score semantics needed for truthful capability advertisement. Retrieval adapters SHALL NOT hide tokenizer, ranker, vector-index, distance, model, or recall-determinism differences behind a generic search interface.

#### Scenario: Lexical backend changes

- **WHEN** lexical retrieval is backed by an engine other than SQLite FTS5
- **THEN** the capability advertisement and result scores SHALL disclose the backend's score direction and implementation-relative semantics
- **AND** drift detection SHALL account for tokenizer or ranker identity when that identity affects indexed content or ranking

#### Scenario: Semantic backend is approximate

- **WHEN** semantic retrieval is backed by an approximate vector index
- **THEN** the capability advertisement SHALL disclose index kind and recall determinism
- **AND** the adapter SHALL NOT present approximate recall as exact flat-index behavior

### Requirement: The reference SHALL gate grant revocation on a valid owner or grant-scoped client bearer
`POST /grants/:grantId/revoke` SHALL require an `Authorization: Bearer <token>` header and SHALL accept the request only when the introspected token is one of:

- an owner bearer (`pdpp_token_kind === 'owner'`) whose token row is real and is not token-level-revoked (`inactive_reason === 'token_revoked'`) or token-level-expired (`inactive_reason === 'token_expired'`); or
- a client bearer (`pdpp_token_kind === 'client'`, or an inactive introspection that still resolves to a `grant_id` because the inactive reason is grant-state-only) whose introspection-resolved `grant_id` exactly equals the URL `:grantId` parameter.

A client bearer whose grant has become malformed (`grant_invalid`), already revoked (`grant_revoked`), or expired (`grant_expired`) SHALL still authenticate the holder for the purpose of revoking that grant — the bearer string itself is authentic and the only legitimate use of such a token is to revoke the grant the client holds.

The reference SHALL perform this check before any grant lookup, before any state mutation, and before any `grant.revoke_*` spine event is emitted on the success path. A request that fails the check SHALL NOT mutate `grants.status` or `tokens.revoked`.

#### Scenario: Revoke without an Authorization header
- **WHEN** a caller submits `POST /grants/:grantId/revoke` with no `Authorization` header
- **THEN** the response status SHALL be `401`
- **AND** the response body SHALL be a PDPP error envelope with `error.code === 'authentication_error'`
- **AND** the grant's `status` and the grant's tokens' `revoked` columns SHALL remain unchanged

#### Scenario: Revoke with an unknown bearer
- **WHEN** a caller submits `POST /grants/:grantId/revoke` with an `Authorization: Bearer …` whose value does not match any row in the tokens table
- **THEN** the response status SHALL be `401`
- **AND** the grant SHALL remain unchanged

#### Scenario: Revoke with a token-level revoked or expired bearer
- **WHEN** a caller submits `POST /grants/:grantId/revoke` with a bearer whose introspection returns `active: false` with `inactive_reason` of `token_revoked` or `token_expired`
- **THEN** the response status SHALL be `401`
- **AND** the grant SHALL remain unchanged

#### Scenario: Revoke with a client bearer bound to a different grant
- **WHEN** a caller submits `POST /grants/:grantId/revoke` with a client bearer whose introspected `grant_id` differs from `:grantId`
- **THEN** the response status SHALL be `403`
- **AND** the response body SHALL be a PDPP error envelope with `error.code === 'permission_error'`
- **AND** the targeted grant SHALL remain unchanged

#### Scenario: Revoke with the grant's own client bearer
- **WHEN** a caller submits `POST /grants/:grantId/revoke` with a valid client bearer whose introspected `grant_id` equals `:grantId`
- **THEN** the response status SHALL be `200`
- **AND** the response body SHALL be `{ "revoked": true }`
- **AND** subsequent introspection of the same token SHALL return `active: false`

#### Scenario: Revoke with the grant's own client bearer for a malformed grant
- **WHEN** a caller submits `POST /grants/:grantId/revoke` with a client bearer whose introspection returns `active: false` with `inactive_reason: 'grant_invalid'` and whose introspection-resolved `grant_id` equals `:grantId`
- **THEN** the request SHALL pass the auth gate
- **AND** the response SHALL be the existing PDPP `grant_invalid` error envelope produced by the revoke handler (status `403`)
- **AND** the auth gate SHALL NOT short-circuit to `401`

#### Scenario: Revoke with an owner bearer
- **WHEN** a caller submits `POST /grants/:grantId/revoke` with a valid owner bearer
- **THEN** the response status SHALL be `200`
- **AND** the response body SHALL be `{ "revoked": true }`
- **AND** the grant's `status` SHALL be `'revoked'` regardless of which client originally held it

### Requirement: AS hosted-UI responses SHALL carry clickjacking-defense headers
Every response from the reference Authorization Server's HTTP application SHALL include the headers `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`. The reference SHALL set both headers (the modern CSP form for current browsers and the legacy header for older browsers and embedded webviews).

#### Scenario: A browser fetches the owner-login page
- **WHEN** a browser issues `GET /owner/login`
- **THEN** the response SHALL carry `X-Frame-Options: DENY`
- **AND** the response SHALL carry `Content-Security-Policy: frame-ancestors 'none'`

#### Scenario: A browser fetches the consent shell with a request_uri
- **WHEN** a browser issues `GET /consent?request_uri=…`
- **THEN** the response SHALL carry `X-Frame-Options: DENY`
- **AND** the response SHALL carry `Content-Security-Policy: frame-ancestors 'none'`

#### Scenario: A non-HTML JSON endpoint is requested
- **WHEN** a caller issues a JSON request such as `POST /introspect`
- **THEN** the response SHALL still carry both clickjacking-defense headers
- **AND** the headers SHALL NOT change the response body or content type

### Requirement: Hosted owner forms SHALL be protected by a signed double-submit CSRF token

When the reference owner-auth placeholder is enabled (`PDPP_OWNER_PASSWORD` set), every state-changing form POST originating from a server-rendered hosted owner page SHALL be rejected unless the caller submits a CSRF token that:

1. is present both in the `pdpp_owner_csrf` cookie and in an `_csrf` form field;
2. has a valid HMAC signature over its nonce when verified with the server-side CSRF secret;
3. matches the cookie value byte-for-byte under a constant-time comparison.

The server-side CSRF secret SHALL NOT be derived from `PDPP_OWNER_PASSWORD` or any other user-supplied authentication credential. The reference SHALL default to a fresh random 32-byte secret minted per process when owner-auth is enabled. Implementations MAY accept an explicit deployment-supplied CSRF secret (high-entropy and unrelated to any password) for use cases that require a stable secret across restarts, but SHALL NOT use a password-derived value.

The CSRF cookie SHALL be marked `HttpOnly`, `Path=/`, `SameSite=Lax` (or `Strict` when `PDPP_OWNER_SAMESITE=strict`), and `Secure` whenever the request is observed over TLS (`req.secure` or `X-Forwarded-Proto: https`) **or** when `PDPP_OWNER_FORCE_SECURE_COOKIES=1` is set. The hidden field name is `_csrf`. Tokens have the shape `<base64url-nonce>.<base64url-hmac>` and are issued on every hosted-form GET that does not already carry a verifying cookie.

The protected POST surfaces SHALL include at least:

- `POST /owner/login`
- `POST /owner/logout`
- `POST /consent/approve`
- `POST /consent/deny`
- `POST /device/approve`
- `POST /device/deny`

Pure JSON callers SHALL remain exempt: a request whose `Content-Type` is exactly `application/json` (parameters such as `; charset=utf-8` permitted) SHALL pass through `requireCsrf` without a CSRF check, because browsers cannot forge a cross-origin JSON POST without a CORS preflight. The exemption SHALL NOT extend to structured-syntax variants such as `application/problem+json` until the reference body parser actually decodes them as JSON. CLIs and server-to-server clients keep their existing programmatic contract.

Every other browser-submittable POST — including `application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`, and a request with no `Content-Type` header — SHALL require a valid CSRF pair when owner-auth is enabled. The exemption SHALL NOT be defined as "form-encoded only," because the HTML form spec admits `text/plain` as a third valid `enctype`, which a browser can submit cross-origin without a CORS preflight; exempting only the two strict form encodings would leave a `text/plain` bypass.

The CSRF cookie SHALL be rotated on auth-state change (login success and logout) so a token captured before sign-in cannot be reused after it.

The owner session cookie (`pdpp_owner_session`) SHALL also honor the `PDPP_OWNER_SAMESITE` and `PDPP_OWNER_FORCE_SECURE_COOKIES` knobs so deployments behind TLS-terminating proxies can force `Secure` and stricter SameSite without code changes.

This requirement supersedes the prior "P2 follow-up" deferral noted in the original `harden-reference-auth-surfaces` design.

#### Scenario: A browser-form POST `/owner/login` arrives without a CSRF cookie or `_csrf` field
- **WHEN** a browser submits `POST /owner/login` with `Content-Type: application/x-www-form-urlencoded` and no `pdpp_owner_csrf` cookie or `_csrf` body field
- **THEN** the response status SHALL be `403`
- **AND** the response SHALL NOT issue a `pdpp_owner_session` Set-Cookie
- **AND** the response body SHALL NOT leak whether the submitted password would have been correct

#### Scenario: A text/plain POST `/owner/login` is rejected before the password check
- **WHEN** a caller submits `POST /owner/login` with `Content-Type: text/plain` and no CSRF pair
- **THEN** the response status SHALL be `403`
- **AND** the response SHALL NOT issue a `pdpp_owner_session` Set-Cookie even when the body would have carried a correct password

#### Scenario: A JSON POST `/owner/login` reaches the password branch without a CSRF token
- **WHEN** a programmatic JSON caller submits `POST /owner/login` with `Content-Type: application/json` and a JSON body containing `password` but no `_csrf` field
- **THEN** the request SHALL not be rejected by the CSRF gate because JSON callers cannot be cross-origin-forged from a browser without a CORS preflight
- **AND** an incorrect password SHALL produce a `401`
- **AND** a correct password SHALL produce a `302` redirect to `return_to` and SHALL issue a `pdpp_owner_session` Set-Cookie

#### Scenario: A browser-form POST `/owner/login` arrives with a valid CSRF pair and a wrong password
- **WHEN** a browser submits `POST /owner/login` with a `pdpp_owner_csrf` cookie and matching `_csrf` field that both verify against the server secret, but the submitted password is incorrect
- **THEN** the response status SHALL be `401`
- **AND** the response SHALL NOT issue a `pdpp_owner_session` Set-Cookie

#### Scenario: A browser-form POST `/owner/login` arrives with a valid CSRF pair and the correct password
- **WHEN** a browser submits `POST /owner/login` with a verifying CSRF pair and the correct password
- **THEN** the response status SHALL be `302`
- **AND** the response SHALL issue a `pdpp_owner_session` Set-Cookie
- **AND** the response SHALL also issue a rotation Set-Cookie that clears the prior `pdpp_owner_csrf` cookie

#### Scenario: A browser-form POST `/consent/approve` arrives from an authenticated owner without a CSRF token
- **WHEN** an authenticated owner submits `POST /consent/approve` with `Content-Type: application/x-www-form-urlencoded` and no verifying CSRF pair
- **THEN** the response status SHALL be `403`
- **AND** the pending consent request SHALL remain pending

#### Scenario: A browser-form POST `/device/approve` arrives from an authenticated owner without a CSRF token
- **WHEN** an authenticated owner submits `POST /device/approve` with `Content-Type: application/x-www-form-urlencoded` and no verifying CSRF pair
- **THEN** the response status SHALL be `403`
- **AND** the device authorization SHALL remain pending

#### Scenario: A text/plain POST `/consent/approve` arrives from an authenticated owner without a CSRF token
- **WHEN** an authenticated owner submits `POST /consent/approve?request_uri=…` with `Content-Type: text/plain`, `Accept: text/html`, a session cookie, a non-empty body, and no `pdpp_owner_csrf` cookie or `_csrf` field
- **THEN** the response status SHALL be `403`
- **AND** the pending consent request SHALL remain pending (a subsequent JSON `POST /consent/approve` for the same `request_uri` SHALL still succeed)

#### Scenario: A text/plain POST `/device/approve` arrives from an authenticated owner without a CSRF token
- **WHEN** an authenticated owner submits `POST /device/approve` with `Content-Type: text/plain`, a session cookie, and no CSRF token
- **THEN** the response status SHALL be `403`
- **AND** the device authorization SHALL remain pending

#### Scenario: A POST with no Content-Type arrives from an authenticated owner without a CSRF token
- **WHEN** an authenticated owner submits a state-changing POST with a session cookie, no `Content-Type` header (a "browser fetch with no body" shape), and no CSRF token
- **THEN** the response status SHALL be `403`

#### Scenario: A JSON POST `/consent/approve` arrives from an authenticated owner without a CSRF token
- **WHEN** an authenticated owner submits `POST /consent/approve` with `Content-Type: application/json` and no `_csrf` field
- **THEN** the response SHALL be processed as before
- **AND** the response status SHALL be `200`
- **AND** the response body SHALL still return `{ grant_id, token, grant }`

#### Scenario: A CSRF token signed with a password-derived secret is rejected
- **WHEN** an attacker fetches `GET /owner/login` to capture one (nonce, signature) sample, derives `sha256("pdpp-owner-csrf:" + PDPP_OWNER_PASSWORD)` (or any other password-derived helper), forges a `<nonce>.<sig>` token with that secret, and submits it as both the `pdpp_owner_csrf` cookie and the `_csrf` form field on an authenticated POST `/consent/approve`
- **THEN** the response status SHALL be `403`
- **AND** the rendered CSRF token in `GET /consent` SHALL NOT equal the password-derived token

#### Scenario: A forged CSRF cookie/field pair without a valid signature is rejected
- **WHEN** a caller submits `POST /consent/approve` (form-encoded) with a `pdpp_owner_csrf` cookie and `_csrf` form field that match each other byte-for-byte but whose signature does not verify against the server secret
- **THEN** the response status SHALL be `403`
- **AND** no grant SHALL be issued

#### Scenario: An operator opts into stricter cookie posture
- **WHEN** the server starts with `PDPP_OWNER_SAMESITE=strict`
- **THEN** every owner session and CSRF Set-Cookie SHALL carry `SameSite=Strict`

#### Scenario: An operator forces `Secure` cookies behind a TLS-terminating proxy
- **WHEN** the server starts with `PDPP_OWNER_FORCE_SECURE_COOKIES=1`
- **THEN** every owner session and CSRF Set-Cookie SHALL carry `Secure` even when the inbound request appears as plain HTTP to the Node process

#### Scenario: Local plain-HTTP development still works without configuration
- **WHEN** the server runs over plain HTTP without `PDPP_OWNER_FORCE_SECURE_COOKIES`
- **THEN** owner cookies SHALL omit `Secure` so a browser will accept and send them
- **AND** the hosted owner form flows SHALL still issue and validate CSRF tokens normally

### Requirement: Hosted consent UI SHALL disclose effective access risk

The reference Authorization Server's hosted consent UI SHALL render authorization requests in terms of the effective access the owner is approving, not only in terms of request shorthand. A stream wildcard SHALL NOT be rendered as a bare `*`; the UI SHALL disclose that all streams for the requested source are in scope and SHALL show the resolved stream count and names when the source manifest is available. Long-lived `continuous` access SHALL receive a distinct risk affordance, especially when no expiry or retention bound is present.

Requests for `purpose_category: "ai_training"` SHALL require explicit affirmative consent. When that consent is missing, the AS SHALL reject the request with a typed PDPP error envelope rather than an untyped internal server error.

#### Scenario: Hosted consent receives a wildcard stream request
- **WHEN** the AS renders `GET /consent?request_uri=...` for a pending request whose authorization details include a stream selection of `*`
- **THEN** the HTML SHALL NOT render a bare `*` as the stream name
- **AND** the HTML SHALL indicate that all streams for the requested source are in scope
- **AND** when the source manifest is known, the HTML SHALL include the resolved stream count and resolved stream names

#### Scenario: Hosted consent receives a continuous grant request
- **WHEN** the AS renders hosted consent for a request whose effective `access_mode` is `continuous`
- **THEN** the HTML SHALL include a distinct long-lived-access warning
- **AND** when no expiry or retention bound is present, the warning SHALL state that the requested access has no explicit expiry

#### Scenario: AI-training request lacks affirmative consent
- **WHEN** a caller submits an authorization request for `purpose_category: "ai_training"` without the reference's explicit affirmative consent marker
- **THEN** the AS SHALL reject the request with a typed PDPP error envelope
- **AND** the response SHALL NOT be a generic `500` internal server error

### Requirement: Host-derived AS/RS metadata SHALL be trusted only for local/private or allowlisted hosts

The reference SHALL pin AS/RS metadata to configured public origins when present. When metadata would derive its origin from request `Host` or `X-Forwarded-Host`, the reference SHALL accept the request only if the resolved request hostname is local/private or matches `PDPP_TRUSTED_HOSTS` (or an equivalent startup option). `PDPP_TRUSTED_HOSTS` entries SHALL be comma/whitespace separated; bare hostnames and URL entries SHALL match exact hostnames; `host:port` entries SHALL also match the request port; wildcard entries of the form `*.example.com` SHALL match subdomains and SHALL NOT match the apex hostname. Rejections SHALL use HTTP `421` and a PDPP error envelope with `error.code` equal to `misdirected_request`.

#### Scenario: Explicit public origins are configured and a hostile forwarded host is sent
- **WHEN** AS/RS metadata is requested with `X-Forwarded-Host: evil.example`
- **AND** explicit non-loopback AS/RS public origins are configured
- **THEN** the metadata document SHALL publish the configured origins
- **AND** the hostile forwarded host SHALL NOT appear in the issuer, resource, registration endpoint, or PDPP query-base URLs

#### Scenario: No public origin is configured and a private LAN host is sent
- **WHEN** AS/RS metadata is requested with a private LAN `Host`
- **AND** no explicit AS/RS public origin is configured
- **THEN** the metadata document SHALL be allowed
- **AND** the issuer/resource URLs SHALL derive from that private LAN host

#### Scenario: No public origin is configured and an unknown public host is sent
- **WHEN** AS/RS metadata is requested with a public `Host` or `X-Forwarded-Host`
- **AND** that host does not match `PDPP_TRUSTED_HOSTS`
- **THEN** the reference SHALL reject the request with HTTP `421`
- **AND** the response body SHALL be a PDPP error envelope with `error.code` equal to `misdirected_request`

#### Scenario: A trusted public host is configured
- **WHEN** AS/RS metadata is requested with a public `Host` or `X-Forwarded-Host`
- **AND** that host matches `PDPP_TRUSTED_HOSTS`
- **THEN** the metadata document SHALL be allowed
- **AND** the issuer/resource URLs MAY derive from that trusted public host

### Requirement: Runtime Postgres storage SHALL be explicit and default-safe

The reference implementation SHALL keep SQLite as the default runtime storage
backend and SHALL only use Postgres storage when explicitly configured.

#### Scenario: Default runtime remains SQLite

- **WHEN** the reference runtime starts without `PDPP_STORAGE_BACKEND`
- **THEN** it SHALL use the existing SQLite-backed storage path
- **AND** it SHALL NOT require `PDPP_DATABASE_URL`
- **AND** existing SQLite tests SHALL continue to pass without Postgres.

#### Scenario: Postgres runtime requires an explicit database URL

- **WHEN** `PDPP_STORAGE_BACKEND=postgres` is configured without
  `PDPP_DATABASE_URL`
- **THEN** startup SHALL fail fast with a configuration error
- **AND** it SHALL NOT silently fall back to SQLite.

#### Scenario: Postgres runtime uses runtime dependency scope

- **WHEN** Postgres runtime storage is enabled
- **THEN** the reference runtime SHALL be able to import and use `pg` from
  runtime dependency scope
- **AND** test-only Postgres proof drivers SHALL remain env-gated.

### Requirement: Postgres runtime storage SHALL cover records, blobs, spine, and retrieval

The Postgres runtime backend SHALL provide backing storage for live records,
record changes, blob rows and bindings, disclosure spine events, lexical
retrieval state, semantic retrieval state, and hybrid search composition inputs.

#### Scenario: Record and blob APIs preserve public behavior

- **WHEN** records and blobs are ingested, read, listed, deleted, and expanded
  while `PDPP_STORAGE_BACKEND=postgres`
- **THEN** public response envelopes, error codes, blob-reference decoration,
  pagination cursors, and grant filtering SHALL match the SQLite-backed
  behavior for the same fixtures.

#### Scenario: Disclosure spine APIs preserve public behavior

- **WHEN** disclosure events are emitted and read while
  `PDPP_STORAGE_BACKEND=postgres`
- **THEN** event ids, event sequence pagination, correlation summaries, trace
  timelines, run timelines, and public redaction semantics SHALL match the
  SQLite-backed behavior for the same fixtures.

#### Scenario: Search APIs preserve public behavior

- **WHEN** lexical, semantic, or hybrid search is executed while
  `PDPP_STORAGE_BACKEND=postgres`
- **THEN** the returned records SHALL be grant-safe
- **AND** response envelopes and pagination semantics SHALL match the existing
  public search contracts
- **AND** scoring implementation details MAY differ only where the public
  contract does not require exact score equality.

### Requirement: Postgres runtime writes SHALL preserve durable ordering guarantees

The Postgres runtime backend SHALL preserve the durable write ordering,
transactionality, and post-commit index-maintenance boundaries currently
required for record mutations and disclosure spine events.

#### Scenario: Record mutation transaction remains atomic

- **WHEN** concurrent writers mutate the same `(connector_id, stream)` in
  Postgres mode
- **THEN** per-stream versions SHALL be unique and monotonically increasing
- **AND** live-record updates and `record_changes` appends SHALL commit or roll
  back together
- **AND** lexical and semantic index maintenance SHALL occur after the durable
  record transaction.

#### Scenario: Spine event sequence remains stable

- **WHEN** disclosure events are emitted in Postgres mode
- **THEN** each event SHALL receive a stable monotonic `event_seq`
- **AND** timeline pagination SHALL use that logical sequence rather than a
  backend-specific physical row identifier.

### Requirement: Postgres runtime storage SHALL cover AS and control-plane durable state

The explicit Postgres runtime backend SHALL provide Postgres-backed storage for
durable authorization-server, resource-server, and operator-control state
needed to run the reference server without a local persistent SQLite database
acting as a second durable authority.

#### Scenario: Authorization state is durable in Postgres mode

- **WHEN** `PDPP_STORAGE_BACKEND=postgres` is configured
- **THEN** OAuth clients, grants, tokens, pending consent requests, and owner
  device-authorization requests SHALL be written to and read from Postgres
- **AND** token introspection, grant revocation, client deletion cascades,
  consent approval/denial, and owner-device polling SHALL preserve existing
  public response shapes and error codes.

#### Scenario: Connector and controller state is durable in Postgres mode

- **WHEN** `PDPP_STORAGE_BACKEND=postgres` is configured
- **THEN** connector manifests, connector sync state, schedules, active runs,
  search cursor snapshots, and reference read models SHALL be written to and
  read from Postgres
- **AND** reference routes that list connectors, approvals, schedules, active
  runs, search pages, or dashboard summaries SHALL not require durable rows in
  SQLite.

#### Scenario: Postgres runtime does not serve stale SQLite read models

- **WHEN** `PDPP_STORAGE_BACKEND=postgres` is configured
- **AND** local SQLite contains older or divergent derived read-model rows
- **THEN** reference routes SHALL NOT serve those SQLite rows as current
  Postgres runtime state
- **AND** derived read-model freshness metadata SHALL describe the active
  backend's projection state.

#### Scenario: Remaining SQLite use is explicitly classified

- **WHEN** runtime code can still initialize or touch SQLite while
  `PDPP_STORAGE_BACKEND=postgres` is configured
- **THEN** that use SHALL be classified as guarded SQLite-backend code,
  explicitly ephemeral/test-only compatibility, or a known violation tracked by
  the active Postgres-boundary change
- **AND** unclassified persistent SQLite reads SHALL fail validation before the
  implementation is considered complete.

#### Scenario: Postgres runtime names are storage-neutral

- **WHEN** runtime code constructs blob, consent, owner-device, connector-state,
  scheduler, dataset-summary, or other durable reference stores
- **THEN** production call sites SHALL use storage-neutral factory names
- **AND** SQLite-specific factory names MAY remain as compatibility aliases only
  for tests or older imports.

### Requirement: Postgres runtime validation SHALL be evidence-backed

The Postgres runtime backend SHALL be validated through env-gated tests that run
against a real Postgres service and through SQLite default tests that prove the
default runtime remains unchanged.

#### Scenario: Postgres-gated runtime tests execute against the Compose service

- **WHEN** `PDPP_TEST_POSTGRES_URL` is set to the profile-gated Compose
  Postgres service
- **THEN** Postgres runtime storage tests SHALL exercise authorization state,
  connector/control state, records, blobs, disclosure spine, lexical search,
  semantic search, and hybrid search behavior
- **AND** those tests SHALL fail on semantic drift rather than only checking
  successful connection.

#### Scenario: SQLite default tests still pass without Postgres

- **WHEN** `PDPP_TEST_POSTGRES_URL` is unset
- **THEN** Postgres-specific tests SHALL skip or remain unregistered by explicit
  env gate
- **AND** the existing SQLite-backed test suite SHALL continue to pass.

### Requirement: Reference storage and runtime SHALL use canonical connector keys

The reference implementation SHALL use canonical `connector_key` values for connector-backed storage bindings, source bindings, runtime configuration, state namespaces, record namespaces, blob bindings, schedules, runs, diagnostics, search indexes, semantic indexes, and owner-facing read URLs. URL-shaped manifest identifiers SHALL be metadata only.

#### Scenario: New connector state is written

- **WHEN** a connector run, local collector upload, scheduler operation, grant issuance, search index update, or event-subscription write persists connector-backed state
- **THEN** the persisted connector type field SHALL contain the canonical `connector_key`
- **AND** it SHALL NOT contain the manifest registry URI.

#### Scenario: Owner search returns record URLs

- **WHEN** an owner or grant-scoped client receives a record URL or hydration hint from search, Explore, MCP, or a dashboard API
- **THEN** the URL or hint SHALL carry the canonical connector key and the concrete `connection_id` when needed
- **AND** it SHALL NOT rely on URL-shaped connector ids to hydrate the record.

#### Scenario: Local-device exporter persists records and state

- **WHEN** a local-device exporter enrolls, ingests record batches, or writes device-scoped sync state for a connector type whose owner-supplied id is a legacy alias such as `claude_code`
- **THEN** the catalog `connectors` row, the `connector_instances` row, the `device_source_instances` row, and the persisted record/state/version/blob rows SHALL all use the bare canonical `connector_key` (e.g. `claude-code`)
- **AND** the persisted connector type field SHALL NOT carry a `local-device:` storage-namespace prefix
- **AND** isolation between a local-device connection and an account connection for the same connector type SHALL be carried by `connector_instance_id`, not by a storage-key prefix.

#### Scenario: Grant-scoped or owner read resolves a connection from a legacy storage binding

- **WHEN** a grant-scoped client read, owner self-export read, or blob fetch resolves the active connection set from a storage binding whose `connector_id` still carries a legacy URL-shaped first-party id (e.g. `https://registry.pdpp.org/connectors/gmail`)
- **THEN** the admission resolver SHALL canonicalize that `connector_id` to its `connector_key` (e.g. `gmail`) before enumerating active `connector_instances`
- **AND** it SHALL resolve the same connection set it would for the bare canonical key, because records, blob bindings, and `connector_instances` are all keyed by `connector_key`
- **AND** it SHALL NOT return `connection_not_found` solely because the storage binding carried the legacy URL alias rather than the canonical key.

### Requirement: Reference forms SHALL NOT delimiter-parse connector identifiers

Reference forms and route handlers SHALL use structured, validated, or opaque identifiers for connector and connection selections. They SHALL NOT parse concatenated raw connector identifiers with delimiters that may appear inside registry URLs or future custom ids.

#### Scenario: Hosted MCP package selector submits a connection

- **WHEN** the hosted MCP package consent form submits an approved connection selection
- **THEN** the server SHALL resolve that selection from an opaque connection id or a structured payload
- **AND** it SHALL NOT split a raw `connector_id` string such as `connection:<connector_id>:<connection_id>`.

#### Scenario: Malformed selector is submitted

- **WHEN** a selector cannot be validated as one available owner-visible connection or connector group
- **THEN** the server SHALL reject it with a typed invalid-selection error
- **AND** it SHALL NOT guess by truncating or partially parsing the selector.

### Requirement: Reference docs SHALL not teach URL ids as active keys

Reference implementation docs, operator copy, CLI help, MCP tool descriptions, and dashboard examples SHALL use canonical connector keys and connection ids. Manifest registry URIs MAY appear only as manifest provenance or registry links.

#### Scenario: Operator reads a setup example

- **WHEN** an operator reads a reference setup, consent, CLI, MCP, or local-collector example
- **THEN** the example SHALL use `connector_key` values such as `gmail`, `slack`, or `claude-code`
- **AND** it SHALL label any `https://registry...` value as `manifest_uri` or registry provenance, not as the operational connector id.

### Requirement: Post-migration active code SHALL not depend on legacy connector aliases

After the canonical connector-key migration lands, active reference code SHALL NOT require `legacy`, `legacy_default`, URL alias lookup, or stale local-collector alias equivalence to provide normal owner/client functionality.

#### Scenario: Owner opens the connection picker

- **WHEN** the owner opens the hosted MCP consent picker, connection dashboard, grant package flow, or event-subscription flow
- **THEN** stale alias rows SHALL NOT appear as selectable sources
- **AND** owner-visible labels SHALL be based on connector display name and connection display name, not on legacy storage markers.

#### Scenario: Runtime needs to classify old data

- **WHEN** code needs to mention old identifier shapes for migration diagnostics or tests
- **THEN** that code SHALL be isolated to migration, backup, or test fixtures
- **AND** normal runtime branches SHALL operate on canonical keys.

### Requirement: Public read operations SHALL use a canonical response envelope
The reference implementation SHALL use one canonical envelope family for grant-authorized public read operations. List-like responses SHALL include `object`, `data`, `has_more`, `links`, and `meta`; non-list responses SHALL use the same `object`, `data`, `links`, and `meta` vocabulary without `has_more` unless list semantics apply.

#### Scenario: List response returns canonical envelope
- **WHEN** a grant-authorized client calls a public list operation such as records list or search
- **THEN** the response SHALL include `object`, `data`, `has_more`, `links`, and `meta`
- **AND** `links.self` SHALL represent the effective request
- **AND** `links.next` SHALL be either an opaque next-page URL or `null`
- **AND** `meta.warnings` SHALL be present as an array when the operation has non-fatal warnings to report.

#### Scenario: Single-record response uses the same vocabulary
- **WHEN** a grant-authorized client fetches a single record or stream metadata object
- **THEN** the response SHALL use `object`, `data`, `links`, and `meta`
- **AND** it SHALL NOT invent a different envelope vocabulary for the same public read contract.

### Requirement: Public record identity SHALL be connection-scoped
Every public read result that carries or addresses a record SHALL be scoped by `(connection_id, stream, record_id)`. `connection_id` is the canonical public noun for an owner-configured concrete data source account, device, or profile. `connector_id` identifies the connector or manifest type, and `display_name` carries the owner-facing connection label.

#### Scenario: Record-bearing result carries identity
- **WHEN** a grant-authorized client receives a record-bearing response item from records list, records detail, search, expansion, or blob metadata
- **THEN** the item SHALL carry `connection_id`, `connector_id`, `stream`, and `record_id` or their operation-specific equivalents
- **AND** the item SHALL carry `display_name` when the response needs to name the connection to a human or LLM caller.

#### Scenario: Search hit carries record identity
- **WHEN** a grant-authorized client receives a search hit
- **THEN** the hit SHALL carry enough identity to fetch the same record without inference: `connection_id`, `stream`, and `record_id`
- **AND** clients SHALL NOT need to reconstruct connection identity from connector type, dashboard state, or result ordering.

#### Scenario: Deprecated connector-instance alias is compatibility-only
- **WHEN** a response carries `connector_instance_id` during the migration window
- **THEN** it SHALL also carry canonical `connection_id`
- **AND** generated docs and MCP tools SHALL describe `connector_instance_id` as deprecated compatibility, not the primary public noun.

### Requirement: Public read parameters SHALL be strictly validated
The reference implementation SHALL reject unsupported public read parameters, fields, filter operators, sort fields, and expansion targets with typed errors rather than silently ignoring them. Temporary compatibility behavior SHALL be reported through structured warnings.

#### Scenario: Unknown parameter is rejected
- **WHEN** a grant-authorized client sends an unsupported query parameter to a public read operation
- **THEN** the operation SHALL fail with a typed `unknown_parameter` or equivalent invalid-request error
- **AND** the error SHALL identify the invalid parameter
- **AND** the error SHOULD include the valid parameter names for that operation.

#### Scenario: Unsupported filter field is rejected
- **WHEN** a client filters on a field not advertised as filterable in `/v1/schema`
- **THEN** the operation SHALL fail with a typed filter error
- **AND** it SHALL NOT return unfiltered results.

#### Scenario: Temporary compatibility emits warning
- **WHEN** the reference accepts deprecated or lossy behavior during a compatibility window
- **THEN** the response SHALL include a structured `meta.warnings` entry identifying the behavior and recovery path.

### Requirement: Public read projection SHALL use one field allowlist primitive
The reference implementation SHALL expose one projection primitive, `fields`, for public read operations. The field allowlist SHALL be machine-readable, SHALL support dotted paths where applicable, and SHALL apply consistently to top-level records and expanded child records.

#### Scenario: Client requests a subset of fields
- **WHEN** a grant-authorized client passes `fields` to a public record-list or record-detail operation
- **THEN** the response SHALL omit non-requested record fields except fields required by the envelope and identity model
- **AND** the response SHALL preserve the canonical record identity fields required to refetch or attribute the record.

#### Scenario: Projection field is not known
- **WHEN** a client passes a field path not advertised for the stream
- **THEN** the operation SHALL reject the request with a typed field error
- **AND** it SHALL NOT silently widen or ignore the projection.

### Requirement: Public read expansion SHALL be one-hop, inline, and grant-safe
The reference implementation SHALL expose `expand[]` only for manifest-declared, grant-safe, one-hop parent-to-child relations. Expanded child collections SHALL be inline, depth-capped at one, and bounded by `expand_limit` for has-many relations.

#### Scenario: Client expands a declared child relation
- **WHEN** a client requests `expand[]=<relation>` for a stream whose schema advertises that relation as expandable
- **AND** the caller's grant authorizes the child stream and projected child fields
- **THEN** the response SHALL embed the child records inline under the parent result
- **AND** the embedded children SHALL preserve their own identity and projection constraints.

#### Scenario: Client requests unsupported expansion
- **WHEN** a client requests an expansion target not advertised for the stream
- **THEN** the operation SHALL fail with a typed expansion error
- **AND** it SHALL NOT silently omit the relation while returning success.

#### Scenario: Reverse relation remains unsupported
- **WHEN** a client attempts reverse, belongs-to, nested, or arbitrary graph traversal expansion
- **THEN** the reference SHALL reject the request unless a future OpenSpec change explicitly adds that relation type.

### Requirement: Public read filters SHALL use a small advertised operator vocabulary
The reference implementation SHALL support exact filters and operator filters through a single canonical vocabulary: `filter[field]=value` for equality and `filter[field][op]=value` for advertised operators. Legal operators SHALL be declared per field in `/v1/schema`.

#### Scenario: Client uses an advertised operator
- **WHEN** `/v1/schema` advertises operator `gte` for field `sent_at`
- **AND** the client calls records list with `filter[sent_at][gte]=2026-01-01T00:00:00Z`
- **THEN** the operation SHALL enforce that range filter.

#### Scenario: Client uses an unadvertised operator
- **WHEN** a client uses an operator not declared for the field in `/v1/schema`
- **THEN** the operation SHALL fail with a typed filter-operator error
- **AND** it SHALL NOT return results as if the filter had been applied.

### Requirement: Public read sorting SHALL use advertised sign-prefix fields
The reference implementation SHALL expose sorting through a canonical sign-prefix `sort` parameter, where `sort=-field` means descending and `sort=field` means ascending. Sortable fields and default ordering SHALL be advertised in `/v1/schema`.

#### Scenario: Client sorts by advertised field
- **WHEN** `/v1/schema` advertises `emitted_at` as sortable for a stream
- **AND** the client passes `sort=-emitted_at`
- **THEN** the response SHALL be ordered by `emitted_at` descending with a deterministic tie-breaker suitable for cursor pagination.

#### Scenario: Client sorts by unsupported field
- **WHEN** a client passes a `sort` field not advertised as sortable
- **THEN** the operation SHALL fail with a typed sort error.

### Requirement: Public read pagination SHALL use opaque cursors and server links
The canonical public read contract SHALL use `limit`, opaque `cursor`, `has_more`, and server-constructed `links.next`. Cursor contents SHALL NOT be client contract.

#### Scenario: Response has another page
- **WHEN** a public list operation has more results after the returned page
- **THEN** `has_more` SHALL be `true`
- **AND** `links.next` SHALL contain an opaque server-built URL or token-bearing link that the client can follow without reconstructing query state.

#### Scenario: Cursor is reused across incompatible query shape
- **WHEN** a client reuses a cursor with incompatible filters, sort, search mode, stream, or connection scope
- **THEN** the operation SHALL reject the cursor with a typed stale or invalid cursor error
- **AND** it SHALL NOT return a plausible but incorrect page.

### Requirement: Public read counts SHALL be opt-in and cost-graded
The reference implementation SHALL NOT force exact counts on every public list response. Clients MAY request a count using a graded contract equivalent to `Prefer: count=none|estimated|exact`, and responses SHALL report `meta.count.kind` and, when available, `meta.count.value`.

#### Scenario: Client omits count preference
- **WHEN** a client calls a public list operation without a count preference
- **THEN** the response SHALL be allowed to omit a count value
- **AND** `meta.count.kind` SHALL be `none` or an equivalent explicit no-count marker.

#### Scenario: Client requests estimated count
- **WHEN** a client requests an estimated count for a stream where the reference has a maintained projection or safe estimate
- **THEN** the response SHALL include `meta.count.kind = "estimated"` and a numeric `meta.count.value`
- **AND** the response SHALL NOT imply the estimate is exact.

#### Scenario: Requested count is downgraded
- **WHEN** a client requests an exact count and the reference can only safely return an estimate or no count
- **THEN** the response SHALL state the actual `meta.count.kind`
- **AND** it SHALL include a structured warning explaining the downgrade.

### Requirement: `/v1/schema` SHALL be the canonical public read capability document
The reference implementation SHALL expose public read capabilities through `GET /v1/schema`. Tool descriptions, docs, and dashboards MAY summarize the contract, but `/v1/schema` SHALL be the machine-readable source of truth for stream fields, filter operators, sortable fields, expansions, projection support, search modes, pagination, count support, and granted connection identities.

#### Scenario: Client discovers field capabilities
- **WHEN** a client calls `/v1/schema` under a grant
- **THEN** the response SHALL identify every granted stream and its field capabilities, including filterable fields and legal operators
- **AND** a client that uses only advertised capabilities SHALL NOT hit a silent no-op.

#### Scenario: Client discovers connection identities
- **WHEN** a client calls `/v1/schema` under a grant that spans multiple connections
- **THEN** the response SHALL include the granted `connection_id`, `connector_id`, and `display_name` values needed to scope or explain subsequent reads.

#### Scenario: Client discovers search pagination support
- **WHEN** a search mode does not support cursor pagination
- **THEN** `/v1/schema` SHALL advertise that limitation instead of requiring the client to discover it by failed calls.

### Requirement: Public read warnings SHALL be structured and closed over known non-fatal outcomes
The reference implementation SHALL report non-fatal lossiness, compatibility behavior, approximation, skipped sources, partial results, or a clamped page limit through structured `meta.warnings` entries with stable codes. Warnings SHALL NOT become a prose-only catch-all.

#### Scenario: Source is skipped as not applicable
- **WHEN** a multi-source public read skips a source because the requested stream or field is not applicable
- **THEN** the response MAY still succeed for applicable sources
- **AND** it SHALL include a structured warning identifying the skipped source and reason.

#### Scenario: Deprecated alias is accepted
- **WHEN** a request succeeds because the server accepted a deprecated compatibility alias
- **THEN** the response SHALL include a warning code for deprecated alias usage unless the operation's migration window explicitly suppresses warnings for that alias.

#### Scenario: Records-list limit is clamped to the page maximum
- **WHEN** a records-list read receives a `limit` greater than the contract maximum page size (100)
- **THEN** the response SHALL return at most the maximum page size of records rather than rejecting the request
- **AND** the response SHALL include a structured `meta.warnings` entry with the stable code `limit_clamped` and `detail.requested_limit` / `detail.max_limit` values identifying the requested limit and the effective maximum
- **AND** a request whose `limit` is within the maximum (including exactly the maximum) SHALL NOT include a `limit_clamped` warning
- **AND** a request whose `limit` is absent, non-positive, or unparseable SHALL fall back to the default page size and SHALL NOT include a `limit_clamped` warning
- **AND** under multi-connection fan-in the response SHALL include at most one `limit_clamped` warning regardless of how many connections were queried.

#### Scenario: Search-retrieval limit is clamped to the page maximum
- **WHEN** a direct-REST search read (`/v1/search`, `/v1/search/semantic`, or `/v1/search/hybrid`) receives a `limit` greater than the advertised maximum page size (100, as published in `capabilities.{lexical,semantic,hybrid}_retrieval.max_limit`)
- **THEN** the response SHALL return at most the maximum page size of hits rather than rejecting the request
- **AND** the response SHALL include a structured `meta.warnings` entry with the stable code `limit_clamped` and `detail.requested_limit` / `detail.max_limit` values identifying the requested limit and the effective maximum, carried on the same canonical `meta.warnings[]` envelope slot the search operations already use for `deprecated_alias_used` and `source_skipped_not_applicable`
- **AND** a request whose `limit` is within the maximum (including exactly the maximum) SHALL NOT include a `limit_clamped` warning
- **AND** a request whose `limit` is absent, non-positive, or unparseable SHALL fall back to the default page size and SHALL NOT include a `limit_clamped` warning
- **AND** the hybrid mode, which composes lexical and semantic sources under one request, SHALL include at most one `limit_clamped` warning regardless of how many underlying sources were queried
- **AND** the native REST host SHALL carry the search operation's `meta.warnings` through to the response envelope rather than dropping it at the host boundary, so a direct REST caller observes the `limit_clamped`, `deprecated_alias_used`, and `source_skipped_not_applicable` warnings the operation produced.

### Requirement: Public read semantics SHALL be operation-owned and adapter-shared

The reference implementation SHALL implement public read semantics in canonical
resource-server operations or shared pure read-surface transforms. REST route
handlers, hosted package helpers, MCP tools, and CLI commands SHALL delegate to
that shared substrate for visibility, source resolution, schema projection,
filter validation, projection, sorting, pagination, fan-in limiting, warnings,
and typed error construction. Adapters SHALL own only transport concerns:
authentication lookup, argument parsing/serialization, protocol input-schema
validation, and presentation.

#### Scenario: Adapter handles a read request
- **WHEN** a REST route, MCP tool, hosted package read helper, or CLI command
  performs a public read
- **THEN** visibility, source disambiguation, query validation, projection,
  pagination, warning construction, and error classification SHALL be produced
  by canonical operations or shared read-surface transforms
- **AND** the adapter SHALL NOT reimplement those semantics locally

#### Scenario: Adapter adds presentation
- **WHEN** a transport needs presentation-specific output such as MCP
  `content[]`, CLI table formatting, or REST links
- **THEN** the adapter MAY add that presentation after receiving the canonical
  result
- **AND** it SHALL NOT change the canonical query semantics or source identity

### Requirement: Schema source scoping SHALL be transport-invariant

The canonical schema-discovery primitive SHALL support compact global
discovery, stream-name scoping, and source scoping by canonical
`connection_id`. REST, hosted package reads, MCP, and CLI SHALL expose or
consume the same primitive so common stream names can be narrowed to one
configured source without loading a broad full-schema document.

#### Scenario: Caller scopes schema by stream and connection
- **WHEN** a grant-authorized caller requests schema for a stream and a
  `connection_id`
- **THEN** the canonical schema operation or shared schema transform SHALL
  return only the matching configured source and stream
- **AND** REST, MCP, and CLI SHALL NOT compute different source-scoped schema
  documents for the same grant and request

#### Scenario: Caller requests full detail for an ambiguous stream
- **WHEN** a full-detail schema request names a stream that exists under more
  than one granted source and omits `connection_id`
- **THEN** the read surface SHALL return a typed ambiguity response identifying
  `connection_id` as the retry selector
- **AND** it SHALL NOT return a multi-source full-schema dump as the default
  fallback

### Requirement: Read-surface parity SHALL be verified across REST, MCP, and CLI

The reference implementation SHALL include regression coverage that exercises
REST, MCP, and CLI against the same grant-scoped read matrix. The matrix SHALL
cover schema discovery, source identity, strict projection, fan-in search
limits, pagination/count handles, typed ambiguity, and owner-token exclusion.
Transport-specific assertions SHALL remain isolated to the transport they
describe.

#### Scenario: Shared read behavior regresses in one adapter
- **WHEN** REST, MCP, or CLI diverges on canonical read behavior for the same
  grant, stream, source, and query shape
- **THEN** the read-surface parity tests SHALL fail
- **AND** the failure SHALL identify the divergent surface

#### Scenario: Transport-specific behavior is tested
- **WHEN** a behavior is protocol-specific, such as MCP `tools/list`
  membership, MCP `content[]` handles, CLI token-cache hygiene, or REST
  `links.next`
- **THEN** the behavior SHALL be tested as a transport-specific assertion
- **AND** it SHALL NOT be used to justify divergent canonical read semantics

### Requirement: MCP read tools SHALL mirror the canonical public read contract

The in-repo MCP server and hosted MCP gateway SHALL mirror the canonical public
read contract instead of defining a separate read API. MCP tool input schemas
SHALL expose the same public arguments as REST where the normal MCP surface
includes the corresponding operation, including the same documented bounds.
For canonical structured read tools, `structuredContent` SHALL carry the
canonical operation body and prose `content[]` SHALL be a concise summary only.
MCP-only presentation wrappers, including document-shaped `fetch`, SHALL be
generated from canonical public read results and SHALL NOT define a separate
record-detail semantic contract.

#### Scenario: MCP structured tool returns structured content
- **WHEN** an MCP client calls a canonical structured read tool such as
  `query_records`, `search`, `schema`, or `aggregate`
- **THEN** the tool response SHALL include `structuredContent` matching the canonical read envelope or operation body
- **AND** any text content SHALL be a human or model-visible summary rather than
  a second divergent contract

#### Scenario: MCP fetch uses document presentation
- **WHEN** an MCP client calls `fetch`
- **THEN** the tool MAY return the MCP/OpenAI document shape required by the
  search-fetch contract
- **AND** the document SHALL be rendered from canonical record/search data
- **AND** canonical structured record retrieval SHALL remain available through
  `query_records` or the REST record-detail contract

#### Scenario: MCP validates arguments through the same contract
- **WHEN** an MCP client supplies filters, fields, sort, expand, count, cursor, or `connection_id`
- **THEN** the MCP server SHALL forward or validate them according to the same canonical public read contract as REST
- **AND** it SHALL NOT silently drop arguments that the REST surface would reject

#### Scenario: MCP enforces the records-list limit cap at input validation
- **WHEN** an MCP client calls `query_records` with a `limit` greater than the contract maximum page size (100)
- **THEN** the MCP `query_records` input schema SHALL advertise the maximum as an inclusive bound of 100
- **AND** the MCP server SHALL reject the over-max `limit` at input validation rather than forwarding it to the RS to be silently clamped
- **AND** a `limit` within the maximum (including exactly the maximum) SHALL be accepted and forwarded

#### Scenario: MCP enforces the search limit cap at input validation
- **WHEN** an MCP client calls `search` with a `limit` greater than the advertised maximum page size (100)
- **THEN** the MCP `search` input schema SHALL advertise the maximum as an inclusive bound of 100
- **AND** the MCP server SHALL reject the over-max `limit` at input validation rather than forwarding it to the RS to be silently clamped
- **AND** a `limit` within the maximum (including exactly the maximum) SHALL be accepted and forwarded
- **AND** the MCP `search` path SHALL NOT rely on the REST `limit_clamped`
  warning, because it rejects an over-max `limit` before any clamp occurs

### Requirement: The reference's hosted consent-approval HTML SHALL NOT embed a live client bearer

When `POST /consent/approve` produces an HTML response (the human-hosted owner-approval surface), the response body, response headers, and any embedded scripts or attributes SHALL NOT contain the bearer string the AS just issued for that approval.

The HTML response SHALL instead embed an opaque single-use **consent exchange code** scoped to the freshly issued grant. The code SHALL be redeemable for the bearer exactly once at the reference-only redemption endpoint defined below.

The JSON branch of `POST /consent/approve` is not affected by this requirement and SHALL continue to return `{ grant_id, token, grant }` directly. The exchange code SHALL only be minted on the HTML branch.

#### Scenario: A human approves consent in the browser

- **WHEN** a browser submits `POST /consent/approve` for a pending consent request and the AS would have rendered the HTML success page
- **THEN** the response body SHALL NOT contain the bearer string the AS just issued for the resulting grant
- **AND** the response body SHALL contain an opaque consent exchange code prefixed `cex_`
- **AND** the response SHALL display the resulting `grant_id`

#### Scenario: A test harness or programmatic client approves with JSON

- **WHEN** a caller submits `POST /consent/approve` with `Content-Type: application/json` (or otherwise negotiates JSON)
- **THEN** the response SHALL be JSON of shape `{ grant_id, token, grant }` with the bearer in the `token` field
- **AND** the JSON response SHALL NOT include a consent exchange code

### Requirement: The reference SHALL expose a single-use consent-code redemption endpoint

The reference SHALL expose `POST /consent/exchange` as a reference-only redemption endpoint.

The endpoint SHALL accept `{ code }` in the request body, look up the in-memory consent-exchange entry, and on the first successful redemption SHALL return `{ grant_id, token, grant }` with the same shape as the JSON branch of `POST /consent/approve`.

The endpoint SHALL NOT require additional authentication beyond possession of the code; possession of a freshly minted single-use code is the only authority required to redeem the bearer the AS just issued for that consent request.

The endpoint SHALL enforce single-use semantics: after a successful redemption the code SHALL be invalidated and any subsequent redemption attempt SHALL fail. The endpoint SHALL also enforce a short TTL (default 5 minutes); a redemption attempt against an expired code SHALL fail.

Failure responses SHALL be PDPP error envelopes and SHALL NOT include the bearer string.

#### Scenario: Redeeming a freshly issued code

- **WHEN** a caller submits `POST /consent/exchange` with a `code` that was just minted by an HTML `POST /consent/approve`
- **THEN** the response status SHALL be `200`
- **AND** the response body SHALL be `{ grant_id, token, grant }` describing the same grant the approval issued
- **AND** the returned `token` SHALL be a valid client bearer for that grant (i.e. introspection SHALL return `active: true` for it)

#### Scenario: Replaying a consumed code

- **WHEN** a caller submits `POST /consent/exchange` with a `code` that was already redeemed once
- **THEN** the response status SHALL be a 4xx PDPP error envelope
- **AND** the response body SHALL NOT contain the bearer string of the originally issued grant

#### Scenario: Redeeming an expired code

- **WHEN** a caller submits `POST /consent/exchange` with a `code` whose TTL has elapsed
- **THEN** the response status SHALL be a 4xx PDPP error envelope
- **AND** the response body SHALL NOT contain the bearer string of the originally issued grant

#### Scenario: Redeeming an unknown code

- **WHEN** a caller submits `POST /consent/exchange` with a `code` the AS never issued
- **THEN** the response status SHALL be a 4xx PDPP error envelope

### Requirement: Local device exporters remain reference-only
The reference implementation SHALL support local device exporters as a reference-only ingestion mechanism and SHALL NOT present their enrollment, credential, or ingest routes as PDPP Core client API or Collection Profile protocol surface.

#### Scenario: Device exporter routes are exposed
- **WHEN** the reference implementation exposes local device exporter enrollment, heartbeat, or ingest routes
- **THEN** those routes SHALL be documented and implemented as reference-only surfaces
- **AND** they SHALL NOT be exposed under the public client `/v1` query/read contract

#### Scenario: Public grant artifacts are emitted
- **WHEN** records pushed by a local device exporter are later queried through existing grant-scoped RS routes
- **THEN** public artifacts SHALL continue to identify the data source as `{ kind: "connector", id: <connector_id> }`
- **AND** they SHALL NOT expose a public `source_instance_id` unless a later accepted protocol or profile change adds that contract

### Requirement: Device exporter credentials are narrowly scoped
The reference implementation SHALL use a dedicated device-scoped ingest credential for local device exporters. Device credentials SHALL be revocable and SHALL authorize only the enrolled device's heartbeat and ingest operations.

#### Scenario: Owner enrolls a device
- **WHEN** an owner-authenticated operator creates a local device exporter enrollment
- **THEN** the reference implementation SHALL issue a short-lived one-time enrollment code
- **AND** exchanging that code SHALL create a server-assigned `device_id` and a device-scoped ingest credential

#### Scenario: Device credential is used outside ingest
- **WHEN** a caller presents a device-scoped ingest credential to owner routes, public client read/query routes, consent approval routes, grant mutation routes, or other devices' ingest routes
- **THEN** the reference implementation SHALL reject the request

#### Scenario: Device is revoked
- **WHEN** an owner revokes an enrolled device
- **THEN** subsequent heartbeat or ingest attempts using that device credential SHALL fail
- **AND** existing grant/query behavior for already-ingested records SHALL remain unchanged

### Requirement: Device ingest is source-instance isolated
The reference implementation SHALL store local device exporter records with source-instance-aware identity before they enter existing record query and index maintenance paths.

#### Scenario: Two devices push the same connector record key
- **WHEN** two enrolled devices push records for the same `connector_id`, stream, and record key under different source instances
- **THEN** the reference implementation SHALL preserve both records without silently overwriting or conflating them

#### Scenario: Device submits an unknown source instance
- **WHEN** a device submits a batch for a `source_instance_id` not assigned to that device
- **THEN** the reference implementation SHALL reject the batch
- **AND** it SHALL record a machine-readable rejection reason for diagnostics

### Requirement: Device ingest batches are idempotent
The reference implementation SHALL make local device exporter batch ingest idempotent by storing outcomes keyed by `(device_id, batch_id, body_hash)`.

#### Scenario: Device retries the same batch
- **WHEN** a device submits the same `batch_id` with the same `body_hash` after a prior successful or rejected attempt
- **THEN** the reference implementation SHALL return the original stored outcome without duplicating records

#### Scenario: Device reuses a batch id with different content
- **WHEN** a device submits a previously seen `batch_id` with a different `body_hash`
- **THEN** the reference implementation SHALL reject the request as a batch conflict
- **AND** it SHALL NOT ingest records from the conflicting body

### Requirement: Local exporter agents retry durably
The local device exporter agent SHALL keep a bounded durable retry queue for batches that could not be delivered, preserve per-source-instance ordering, and report permanent failures through device diagnostics.

#### Scenario: Remote server is temporarily unavailable
- **WHEN** the local exporter cannot deliver a batch because the reference server is unavailable or returns a retryable error
- **THEN** the exporter SHALL keep the batch in its local durable queue
- **AND** it SHALL retry later without reordering batches for the same source instance

#### Scenario: Batch is permanently invalid
- **WHEN** the reference server rejects a batch with a permanent validation error
- **THEN** the exporter SHALL stop retrying that batch indefinitely
- **AND** it SHALL report the failure in local state and device heartbeat diagnostics

### Requirement: Device exporter diagnostics are owner-visible
The reference implementation SHALL expose owner/operator diagnostics for local device exporters without weakening dashboard owner authentication.

#### Scenario: Owner views device exporters
- **WHEN** an owner opens the live dashboard device exporter surface
- **THEN** the dashboard SHALL show enrolled devices, source instances, last heartbeat, last successful ingest, accepted and rejected counts, stale or revoked state, and last error

#### Scenario: Owner auth is enabled
- **WHEN** owner authentication is configured for the reference instance
- **THEN** local device exporter diagnostics and enrollment controls SHALL require owner access

### Requirement: Local collector execution remains reference-control-plane behavior

The reference implementation SHALL treat local collector execution as a reference/control-plane collection path, not as PDPP Core Resource Server behavior. Collector enrollment, heartbeat, run execution, upload, diagnostics, and revocation SHALL remain outside the Resource Server read/query surface unless a future Collection Profile explicitly standardizes them.

#### Scenario: A connector requires local execution

- **WHEN** a connector requires a browser, local filesystem, local device state, or owner-assisted runtime capability that the provider/control-plane runtime does not advertise
- **THEN** the reference SHALL NOT run that connector inside the Resource Server
- **AND** it SHALL place the connector in an eligible local collector runtime or fail before spawn with an actionable runtime capability diagnostic

#### Scenario: A clean API connector is eligible for provider execution

- **WHEN** a connector's declared requirements are satisfied by the provider/control-plane runtime
- **THEN** the reference MAY run the connector in that provider/control-plane runtime without requiring a local collector
- **AND** Resource Server reads SHALL continue to operate only over records already accepted into storage

#### Scenario: Collection Profile semantics are not frozen

- **WHEN** the reference exposes collector enrollment, heartbeat, upload, or diagnostics before Collection Profile normativity is settled
- **THEN** the reference SHALL label those surfaces as reference/control-plane behavior
- **AND** it SHALL NOT describe them as PDPP Core requirements

### Requirement: Runtime capability advertisement gates connector spawn

The reference implementation SHALL compare connector runtime requirements against runtime-advertised capabilities before spawning connector code. Missing required capabilities SHALL produce typed diagnostics before connector execution starts.

#### Scenario: A required binding is absent

- **WHEN** a connector declares a required runtime binding and the selected runtime does not advertise that binding
- **THEN** the reference SHALL fail the run before spawn
- **AND** it SHALL record a diagnostic that names the missing capability without exposing credentials or owner data

#### Scenario: Placement is derived from existing semantics

- **WHEN** the reference decides whether a connector can run in the provider/control-plane runtime or local collector runtime
- **THEN** it SHALL derive that decision from connector requirements and runtime capabilities
- **AND** it SHALL NOT require a broad, manually-maintained runtime-mode taxonomy unless existing primitives prove insufficient

### Requirement: Local collector credentials are device-scoped

The reference implementation SHALL reuse the device-scoped credential boundary for local collector upload and heartbeat. Collector credentials SHALL NOT substitute for owner tokens or client grant tokens.

#### Scenario: A collector uploads data

- **WHEN** a local collector submits records, blobs, run events, diagnostics, or heartbeat data
- **THEN** the reference SHALL authenticate it with a device-scoped credential
- **AND** that credential SHALL NOT authorize record reads, consent approval, grant issuance, owner-token minting, or mutation of unrelated devices

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

### Requirement: Dynamic n.eko surfaces SHALL be reconciled against the allocator before serving acquires

After reference restart, the lease manager SHALL prove every in-memory dynamic n.eko surface still corresponds to a live, healthy allocator container before the first managed acquire can lease it.

#### Scenario: Allocator does not know a persisted surface

- **WHEN** the reference boots and a persisted dynamic n.eko surface row marked `health: "ready"` has no corresponding container reported by the allocator
- **THEN** the lease manager SHALL evict that surface row from the in-memory map before accepting any acquire request
- **AND** the persisted surface row SHALL be updated to reflect the eviction
- **AND** any active lease referencing the evicted surface SHALL transition to `surface_failed` with `wait_reason = "surface_unhealthy"`

#### Scenario: Allocator reports a persisted surface as starting or stopping

- **WHEN** the reference boots and a persisted dynamic n.eko surface row marked `health: "ready"` is reported by the allocator with health `"starting"` or `"stopping"`
- **THEN** the lease manager SHALL downgrade the in-memory health to match the allocator's report
- **AND** the persisted surface row SHALL be updated to reflect the downgrade
- **AND** the next acquire SHALL NOT treat that surface as a ready idle candidate
- **AND** a surface downgraded to `"stopping"` SHALL NOT consume dynamic surface capacity

#### Scenario: Allocator reports a persisted surface as unhealthy

- **WHEN** the reference boots and a persisted dynamic n.eko surface row marked `health: "ready"` is reported by the allocator with health `"unhealthy"`
- **THEN** the lease manager SHALL evict that surface row from the in-memory map before accepting any acquire request
- **AND** the persisted surface row SHALL be updated to reflect the eviction
- **AND** any active lease referencing the evicted surface SHALL transition to `surface_failed` with `wait_reason = "surface_unhealthy"`

#### Scenario: Static n.eko mode boots

- **WHEN** the reference boots in static n.eko surface mode
- **THEN** allocator-aware reconciliation SHALL be a no-op
- **AND** the configured static surface SHALL remain available unchanged

### Requirement: Readiness-probe failure SHALL invalidate the in-memory surface

When the controller's pre-spawn readiness probe fails for a leased managed n.eko surface, the lease manager SHALL invalidate the surface row in addition to releasing the lease, so the next acquire cannot reuse the surface in a tight loop.

#### Scenario: Probe failure on a leased surface

- **WHEN** the controller's readiness probe returns a typed failure code for a leased managed n.eko surface
- **THEN** the lease manager SHALL evict the surface row from the in-memory map
- **AND** the controller SHALL release the lease and emit `run.browser_surface_released`
- **AND** the eviction SHALL be persisted by upserting the surface row with `health: "unhealthy"`

#### Scenario: Probe failure with a dynamic allocator configured

- **WHEN** the readiness probe fails and a dynamic allocator is configured
- **THEN** the controller SHALL call `allocator.stopSurface({ reason: "surface_failed" })` for the failing surface
- **AND** the allocator SHALL remove the underlying container so the next `ensureSurface` request creates a fresh one
- **AND** persistent profile storage for the surface SHALL be preserved

#### Scenario: Probe failure with no dynamic allocator

- **WHEN** the readiness probe fails and only static n.eko mode is configured
- **THEN** the lease manager SHALL still evict the in-memory surface row
- **AND** no allocator stop request SHALL be issued

### Requirement: The n.eko allocator SHALL replace stale exited containers rather than restart them

When `ensureSurface` finds an existing reference-owned n.eko container that is not currently running, the allocator SHALL remove and recreate that container before returning a surface. The allocator SHALL NOT silently restart an exited carcass whose CDP, network, or browser-process state may be unrecoverable.

#### Scenario: An exited container exists for a requested surface

- **WHEN** the allocator's `ensureSurface` request matches an existing reference-owned container that is not in `running` state
- **THEN** the allocator SHALL remove that container via the Docker engine before creating a fresh one
- **AND** persistent profile storage for the surface SHALL be preserved across replacement
- **AND** the returned surface SHALL describe the fresh container, not the removed carcass

#### Scenario: A running container exists for a requested surface

- **WHEN** the allocator's `ensureSurface` request matches an existing reference-owned container that is in `running` state
- **THEN** the allocator SHALL reuse that container without removal

#### Scenario: stopSurface is called with reason surface_failed

- **WHEN** the allocator receives `stopSurface({ reason: "surface_failed" })`
- **THEN** it SHALL stop the underlying container and then remove it via the Docker engine
- **AND** the returned surface description SHALL indicate the container has been removed

#### Scenario: stopSurface is called with a non-failure reason

- **WHEN** the allocator receives `stopSurface({ reason: "idle_ttl" })`, `"capacity_pressure"`, `"reconcile"`, or `"operator"`
- **THEN** it SHALL stop the underlying container but SHALL NOT remove it
- **AND** a subsequent `ensureSurface` call for the same surface SHALL be allowed to replace the stopped container according to the stale-carcass rule above

### Requirement: Gmail attachment backfill is explicit and gap-aware

The reference implementation SHALL provide an explicit Gmail attachment backfill path for historical mail that is independent of the normal `messages` stream cursor. The implementation SHALL NOT claim complete Gmail attachment hydration merely because new-message sync hydrates attachments.

#### Scenario: Attachment hydration is enabled after message state advanced

- **WHEN** Gmail `messages.all_mail.uidnext` has advanced past historical messages that contain attachments
- **AND** an operator requests Gmail attachment backfill
- **THEN** the reference SHALL revisit the historical All Mail UID range needed for the `attachments` stream without rewinding the normal `messages` cursor
- **AND** it SHALL emit attachment records with populated `blob_ref` for bytes that Gmail still makes accessible

#### Scenario: Attachment backfill is interrupted

- **WHEN** a Gmail attachment backfill run stops before completing the historical UID range
- **THEN** the reference SHALL preserve enough `attachments` stream state to resume from the last durably completed window
- **AND** it SHALL NOT mark an unprocessed UID range as complete

#### Scenario: Attachment bytes cannot be fetched

- **WHEN** a historical Gmail attachment is inaccessible, too large, malformed, throttled, or otherwise cannot be hydrated
- **THEN** the reference SHALL preserve a metadata attachment record with a truthful `hydration_status`
- **AND** any diagnostic field or timeline summary SHALL be bounded and SHALL NOT include attachment bytes, source credentials, or secret download material

### Requirement: Gmail attachment blob persistence is idempotent

Gmail attachment hydration and backfill SHALL persist bytes through the existing content-addressed blob substrate. Reprocessing an already hydrated attachment SHALL preserve stable record identity and SHALL NOT duplicate blob bytes.

#### Scenario: Historical attachment is backfilled twice

- **WHEN** the same historical Gmail attachment bytes are processed by two attachment backfill runs
- **THEN** the emitted attachment record id SHALL remain stable
- **AND** the `blob_ref.blob_id` SHALL remain the same content-addressed blob id
- **AND** the blob store SHALL preserve at most one byte payload for that blob id while allowing idempotent record bindings

#### Scenario: Incremental and backfill hydration overlap

- **WHEN** a Gmail attachment is hydrated during normal incremental sync and later appears in an attachment backfill window
- **THEN** the later backfill SHALL treat the existing hydrated blob as already satisfied or re-emit the same stable blob reference
- **AND** it SHALL NOT create a conflicting attachment record for the same Gmail message part

### Requirement: Gmail attachment hydration preflight and coverage are operator-visible

The reference Docker path SHALL make Gmail attachment hydration prerequisites and coverage gaps visible before reporting success.

#### Scenario: Blob upload configuration is missing

- **WHEN** Gmail attachment hydration or backfill is requested in Docker without required blob upload configuration such as `PDPP_RS_URL` and `PDPP_OWNER_TOKEN`
- **THEN** the reference SHALL fail preflight with an actionable error before doing mailbox work
- **AND** it SHALL NOT report the Gmail run as complete attachment hydration

#### Scenario: Gmail attachment backfill completes with partial gaps

- **WHEN** a Gmail attachment backfill run completes with some attachments not hydrated
- **THEN** the run output or reference-only run timeline SHALL expose a non-secret gap summary that distinguishes hydrated, too large, failed, unavailable or skipped, and remaining historical gap counts
- **AND** it SHALL NOT include an `already_hydrated` count unless existing blob or record state is measured directly
- **AND** the summary SHALL be sufficient for an operator to know that "all mail" is not fully byte-hydrated

#### Scenario: Docker proof validates historical rehydration

- **WHEN** the documented Docker acceptance path is run with Gmail credentials and a historical attachment-bearing message
- **THEN** the reference SHALL demonstrate that the historical attachment can be discovered through Gmail records, expanded through `expand=attachments`, and fetched through the grant-visible `blob_ref.fetch_url`
- **AND** if the proof cannot run because env or credentials are missing, it SHALL report the exact missing prerequisite instead of producing a false-success result

### Requirement: Stream metadata field capabilities SHALL carry an optional declared presentation type

The reference implementation SHALL allow each `field_capabilities` entry on stream metadata to carry an optional declared presentation `type` (for example `currency`, `timestamp`, `person`, `blob`, `text`) sourced from the stream manifest. The `type` is additive and optional: a manifest that does not declare it SHALL produce a `field_capabilities` entry with no `type`, and consumers SHALL treat an absent `type` as "not declared." This declared `type` is a presentation/dispatch hint for reference surfaces; it is not a Core protocol field and SHALL NOT change grant, projection, filter, or retrieval semantics.

#### Scenario: A manifest declares a typed field
- **WHEN** a stream manifest declares a presentation `type` for a top-level field
- **AND** an owner or client token requests `GET /v1/streams/<stream>`
- **THEN** the field's `field_capabilities` entry SHALL include that declared `type`
- **AND** the live manifest type SHALL accept the same typed field shape the sandbox demo manifests already encode

#### Scenario: An undeclared field omits the type
- **WHEN** a stream manifest does not declare a presentation `type` for a field
- **THEN** the field's `field_capabilities` entry SHALL omit `type`
- **AND** a consumer SHALL treat the absence as "not declared" and fall back to its own heuristic, never inventing a type

#### Scenario: The declared type does not alter query or grant semantics
- **WHEN** the declared presentation `type` is present on a field
- **THEN** exact-filter support, range operators, lexical/semantic participation, and grant usability for that field SHALL be unchanged from a field without a declared `type`
- **AND** the `type` SHALL NOT be writable by a client, SHALL NOT appear in selection requests, and SHALL NOT be treated as a grantable capability

### Requirement: The record-list read MAY expose bounded window aggregate metadata

The reference record-list read (`GET /v1/streams/:stream/records`) MAY include an optional `meta.window` object carrying bounded aggregate metadata for the addressed read — `total`, `earliest_at`, and `latest_at` — computed under the same grant projection and the same exact/declared range-filter validation as the records themselves. When present, `meta.window` SHALL describe the filtered, grant-scoped corpus, not the unfiltered stream. When the read cannot compute the aggregate cheaply or the contract does not provide it, `meta.window` SHALL be omitted rather than estimated.

#### Scenario: A record-list read includes window metadata
- **WHEN** a client reads `GET /v1/streams/<stream>/records` and the resource server can compute the bounded aggregate under the request's grant and filters
- **THEN** the response MAY include `meta.window` with `total`, `earliest_at`, and `latest_at`
- **AND** those figures SHALL reflect the same grant projection and the same range-filter validation applied to the returned records

#### Scenario: Window metadata is omitted rather than estimated
- **WHEN** the resource server cannot compute the bounded aggregate cheaply or does not implement `meta.window`
- **THEN** the response SHALL omit `meta.window`
- **AND** a consumer SHALL treat the absence as "not available" and SHALL NOT synthesize a full-corpus figure from a bounded sample

### Requirement: The sandbox SHALL expose the records explorer at parity with the live surface

The reference sandbox SHALL expose the records explorer at `/sandbox/explore`, rendering the same explorer view through the sandbox (mock-backed) data source. Any divergence between the sandbox and live explorer SHALL be intentional and visibly labeled — never an accidental gap — and the sandbox SHALL remain clearly distinct from live operation per the surface topology.

#### Scenario: Sandbox explore renders the same view through mock data
- **WHEN** a visitor opens `/sandbox/explore`
- **THEN** the page SHALL render the same records-explorer view as `/dashboard/explore`, sourced from the sandbox data source with deterministic fictional data
- **AND** the page SHALL NOT require an owner token, collect real credentials, or read from a live resource server

#### Scenario: Sandbox-only divergences are labeled, not hidden
- **WHEN** the sandbox explorer shows something the live explorer cannot (for example an illustrative read URL or seeded records)
- **THEN** that divergence SHALL be visibly labeled as a sandbox specimen
- **AND** the sandbox SHALL NOT present a capability as live behavior, and a retired sandbox records route SHALL redirect to `/sandbox/explore` rather than 404 or render a stale surface

### Requirement: Local collector runs replay prior connector state through START

The reference implementation SHALL load any prior persisted state for a local collector run before spawning the connector child, and SHALL pass it through the existing `StartMessage.state` field. State load SHALL use the device-scoped credential, scoped by `(deviceId, sourceInstanceId)`.

#### Scenario: A local collector starts with prior state

- **WHEN** the local collector runner spawns a connector child for a device-scoped source instance that has previously persisted state
- **THEN** the runner SHALL fetch that state with its device-scoped credential
- **AND** it SHALL set `StartMessage.state` to the fetched state map before writing `START` to the child
- **AND** the child SHALL NOT need to read state from any other surface

#### Scenario: A local collector starts with no prior state

- **WHEN** the local collector runner spawns a connector child for a source instance with no persisted state
- **THEN** the server SHALL respond to the state read with an empty map
- **AND** the runner SHALL omit `state` from the `START` message
- **AND** the child SHALL behave as if this is a first run

#### Scenario: State read fails

- **WHEN** the local collector runner cannot read prior state because of a network, credential, or server error
- **THEN** the runner SHALL NOT spawn the connector child
- **AND** it SHALL emit a heartbeat with `status: "blocked"` indicating a state-read failure
- **AND** it SHALL exit non-zero

### Requirement: Local collectors persist emitted STATE after records are durably accepted

The reference implementation SHALL persist emitted `STATE` messages from a local collector child only after the records that justify that state are durably accepted by the server.

#### Scenario: All record batches are accepted in a pass

- **WHEN** a local collector child emits `RECORD` messages and one or more `STATE` messages, and all enqueued record batches drain successfully via the existing device ingest path
- **THEN** the collector runner SHALL flush the accumulated `STATE` map to the device-scoped state endpoint once
- **AND** the persisted state SHALL be the per-stream last-wins projection of the emitted `STATE` messages during that pass

#### Scenario: Some record batches fail to drain in a pass

- **WHEN** a local collector child emits `RECORD` and `STATE` messages but the queue still contains unsent record batches at end-of-pass
- **THEN** the runner SHALL NOT advance persisted state for any stream in that pass
- **AND** the previously persisted state SHALL remain authoritative

#### Scenario: A STATE write fails after records were accepted

- **WHEN** record batches drain successfully but the state `PUT` fails
- **THEN** the runner SHALL surface that failure in its heartbeat
- **AND** the next run SHALL re-emit records that the previous pass already considered consumed
- **AND** ingest idempotency SHALL absorb the duplicates without doubling records in storage

#### Scenario: STATE arrives for an out-of-scope stream

- **WHEN** a local collector child emits `STATE` for a stream that was not in `START.scope.streams`
- **THEN** the runner SHALL drop that `STATE` message
- **AND** it SHALL emit a runtime warning identifying the offending stream

### Requirement: Local collector state is device-scoped, source-instance-isolated, and reference-only

The reference implementation SHALL expose local collector state read and write through the device-exporter authority, scoped by `(deviceId, sourceInstanceId)`. Owner-token and client-token routes SHALL NOT accept device credentials, and the device-scoped state route SHALL NOT accept owner or client credentials.

#### Scenario: A device reads or writes its own source-instance state

- **WHEN** a local collector presents a valid device-scoped credential to `GET /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state` or `PUT /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state`, with a path `deviceId` matching the credential and a registered `sourceInstanceId`
- **THEN** the reference implementation SHALL serve or persist the state map keyed under the same internal storage connector id used for device record ingest for that source instance
- **AND** that state SHALL NOT collide with state persisted under the public connector id for owner-authenticated runs of the same connector

#### Scenario: Cross-device or cross-credential request

- **WHEN** a caller presents a device-scoped credential to a state route for a different device's id, an unknown source instance, or presents an owner or client bearer token to the device-scoped state route
- **THEN** the reference implementation SHALL reject the request without revealing state

#### Scenario: Owner-authenticated state route is unaffected

- **WHEN** an owner or client interacts with the existing `GET /v1/state/:connectorId` route or `PUT /v1/state/:connectorId` route
- **THEN** that route SHALL continue to operate keyed by `(connectorId, grantId)` with owner authentication
- **AND** it SHALL NOT serve or accept device-scoped state rows

### Requirement: SKIP_RESULT diagnostics SHALL propagate to the run timeline as bounded owner evidence

When a connector emits a `SKIP_RESULT` message that carries a `diagnostics` value, the reference runtime SHALL forward a bounded, redacted projection of that value to the `run.stream_skipped` spine event payload and to the corresponding `known_gap` entry. The runtime SHALL apply the same secret-redaction policy it uses for other connector-authored gap strings, and SHALL bound nested string length, nested array length, nested object depth, and total JSON size before persistence.

The propagated diagnostic SHALL be treated as connector-authored, untrusted evidence. It SHALL be visible only on owner/control-plane surfaces and SHALL NOT be exposed through grant-scoped `/v1` data, search, schema, or blob APIs.

#### Scenario: Connector emits SKIP_RESULT with a structured diagnostics object

- **WHEN** a connector emits `SKIP_RESULT` whose `diagnostics` is a JSON object describing the failure (for example, `{ phase, diag: { url, title }, artifact: { candidates: [...] }, error }`)
- **THEN** the persisted `run.stream_skipped` event SHALL include `data.diagnostics` containing the bounded, redacted projection of that object
- **AND** the corresponding `known_gap` SHALL include a `diagnostics` field with the same bounded payload.

#### Scenario: SKIP_RESULT diagnostics contains a secret-like value

- **WHEN** a string leaf in the connector-authored diagnostics matches the reference runtime's secret-redaction policy (for example `password=…`, `token=…`, a six-digit OTP)
- **THEN** the persisted projection SHALL contain the redacted replacement rather than the original value.

#### Scenario: SKIP_RESULT diagnostics exceeds the size cap

- **WHEN** a connector emits `SKIP_RESULT.diagnostics` whose bounded JSON projection exceeds the runtime's diagnostic size cap
- **THEN** the persisted projection SHALL be replaced with a sentinel object `{ "truncated": true, "reason": "size_overflow" }` (or an equivalent shape that signals truncation)
- **AND** the rest of the `SKIP_RESULT` (stream, reason, message, recovery hint, known gap) SHALL still propagate normally.

#### Scenario: SKIP_RESULT diagnostics is not an object

- **WHEN** a connector emits `SKIP_RESULT` whose `diagnostics` value is an array, string, number, or boolean
- **THEN** the runtime SHALL drop the `diagnostics` field from the persisted payload
- **AND** SHALL NOT reject the `SKIP_RESULT` message for that reason.

#### Scenario: Client-token read cannot access SKIP_RESULT diagnostics

- **WHEN** a grant-scoped client token reads records, search results, schema, blobs, or other `/v1` resources within its grant
- **THEN** `SKIP_RESULT.diagnostics` projections from run timelines SHALL NOT be included in the response
- **AND** the client SHALL NOT receive a URL or object identifier that grants access to those diagnostics.

### Requirement: HTTP route handlers SHALL be organized by route family
The reference implementation SHALL decompose its HTTP route handlers into per-family adapter modules under `reference-implementation/server/routes/<family>.ts`. Each family adapter SHALL be a TypeScript module that registers a coherent set of routes (e.g. root and discovery, `_ref` operations, RS reads, RS mutations, AS OAuth, run interaction, web push, source webhooks, remote surface). The reference SHALL NOT keep all HTTP route handlers in a single composition module.

#### Scenario: Route adapters live beside other server-only wiring
- **WHEN** an HTTP route family is extracted from `reference-implementation/server/index.js`
- **THEN** its adapter module SHALL be placed at `reference-implementation/server/routes/<family>.ts`
- **AND** the adapter SHALL be a TypeScript module participating in the existing reference-implementation Biome `includes` and `tsconfig.json` `include` globs

#### Scenario: The composition root retains capability wiring
- **WHEN** a family adapter is mounted into the AS or RS Express-shaped app
- **THEN** `reference-implementation/server/index.js` SHALL remain the composition root that owns `buildAsApp`, `buildRsApp`, capability construction, store factories, controller wiring, and `app.use(...)` global middleware
- **AND** the composition root SHALL call the family adapter's mount function at the same point in the route-registration order as the previous inline registration

### Requirement: Route-family extractions SHALL preserve observable behaviour
A route-family extraction SHALL preserve every protocol-observable property of the moved routes: middleware order, owner-session and client-bearer authentication posture, request-id and trace-id propagation, response headers (including `Request-Id`, `Reference-Revision`, `PDPP-Version`, and the AS clickjacking defenses `X-Frame-Options` and `Content-Security-Policy: frame-ancestors 'none'`), content negotiation on the AS and RS root, response envelope shape, status codes, and spine event emission.

#### Scenario: Middleware order is preserved
- **WHEN** a family adapter registers a route that previously took ordered route-level middleware
- **THEN** the same middleware SHALL run in the same order before the route's handler
- **AND** the transport's contract-validation pre-handler (when the route's contract operation id is on the request-validation allowlist) SHALL continue to run after route-level middleware and before the handler

#### Scenario: Response envelope and status codes are unchanged
- **WHEN** a family adapter responds to a moved route
- **THEN** the response status code, headers, and envelope shape SHALL match the pre-extraction behaviour byte-for-byte for successful and well-known failure cases

#### Scenario: Content-negotiated root remains correct
- **WHEN** an AS or RS root (`/`) handler is moved into `server/routes/root-and-discovery.ts`
- **THEN** browser-shaped requests SHALL receive the existing operator/admin landing HTML
- **AND** JSON-shaped requests SHALL receive the existing discovery envelope from `executeAsDiscoveryIndex` (AS) or `executeRsDiscoveryIndex` (RS)

### Requirement: Route-family adapters SHALL NOT introduce a new layer abstraction
Route-family extractions SHALL be mechanical adapter splits over the existing operations boundary at `reference-implementation/operations/*`. They SHALL NOT introduce a router, controller, service object, repository, or domain-driven aggregate layer beyond what already exists.

#### Scenario: An adapter calls an operation directly
- **WHEN** a family adapter handles a route that previously delegated to `operations/<op>`
- **THEN** the adapter SHALL continue to call that operation directly, with the same capability arguments and the same store/controller bindings
- **AND** the adapter SHALL NOT wrap the operation in an additional indirection layer

#### Scenario: An adapter avoids new abstractions even when convenient
- **WHEN** more than one family adapter would benefit from a small helper (e.g. resolving the owner subject id from a request)
- **THEN** that helper SHALL be either a local function inside the family adapter or an exported helper from an existing module (`owner-auth.ts`, `ref-record-utils.ts`, etc.)
- **AND** the change SHALL NOT introduce a new global mount-context type unless multiple family adapters demonstrably need the same wide context bundle

### Requirement: Flagship first-party manifests SHALL declare presentation types for the typed-card pilot

The reference implementation SHALL declare an optional presentation `type` (via the `schema.properties[field].x_pdpp_type` extension already read by the resource server) on the small set of fields the Explorer dispatches record cards from, for the flagship first-party connectors selected for the typed-card pilot. The initial pilot connectors are `chase` (the `transactions` stream, dispatching a money card) and `gmail` (the `messages` stream, dispatching a message card). The declaration is additive and presentation-only: it SHALL NOT alter exact-filter, range-filter, lexical/semantic participation, aggregation, grant usability, or retrieval semantics for the declared field, and a manifest field without a declared `type` SHALL continue to surface no `type` key and fall back to the Explorer heuristic. This requirement makes the already-accepted typed-card dispatch path live on real connector data; it does not introduce a new contract field.

#### Scenario: A flagship money stream declares a currency-typed amount field

- **WHEN** the `chase` `transactions` stream manifest is read through `GET /v1/streams/transactions`
- **THEN** the `amount` field's `field_capabilities` entry SHALL carry a declared `type` of `currency`
- **AND** the stream's other declared presentation types SHALL name a `timestamp` field (the transaction date) and a `text` field (the merchant/payee display name)
- **AND** the surfaced declared types SHALL dispatch a `money` record card through the Explorer's declared-type-preferred classification

#### Scenario: A flagship message stream declares a person-and-text-typed field set

- **WHEN** the `gmail` `messages` stream manifest is read through `GET /v1/streams/messages`
- **THEN** the `from_name` field's `field_capabilities` entry SHALL carry a declared `type` of `person`
- **AND** the stream SHALL declare at least one `text`-typed field (the subject or snippet) and a `timestamp`-typed field (the message date)
- **AND** the surfaced declared types SHALL dispatch a `message` record card through the Explorer's declared-type-preferred classification

#### Scenario: A declared presentation type changes no other capability

- **WHEN** a pilot field declares a presentation `type`
- **THEN** its exact-filter, range-filter, lexical-search, semantic-search, aggregation, and grant-usability flags SHALL be identical to those it carried before the declaration
- **AND** a field in the same stream that does not declare a presentation `type` SHALL surface no `type` key and SHALL fall back to the Explorer's presentation-only heuristic

#### Scenario: A field that does not match its stream's card is not coerced

- **WHEN** a pilot stream carries a field whose value is not the presentation type of the card the stream dispatches (for example the ISO currency-code field on a money stream)
- **THEN** the manifest SHALL NOT declare a presentation `type` that misrepresents the field
- **AND** the declared types on the stream SHALL assert only the field shapes the card actually renders

### Requirement: Trusted owner-agent metadata SHALL advertise the REST owner-agent profile

When trusted owner-agent onboarding is enabled, the reference Resource Server SHALL advertise a machine-readable advisory block that identifies owner-level REST automation as a separate profile from grant-scoped MCP/client access. The advisory block SHALL be non-normative reference metadata and SHALL NOT present owner-agent onboarding as a PDPP Core requirement.

#### Scenario: Metadata includes owner-agent onboarding
- **WHEN** a caller fetches `GET /` or `GET /.well-known/oauth-protected-resource` from a deployment that supports trusted owner-agent onboarding
- **THEN** the response SHALL include an advisory trusted-owner-agent block with the profile name, AS issuer, RS resource origin, owner approval surface, schema endpoint, stream discovery endpoint, query base, token introspection endpoint, revocation path, and event-subscription discovery link
- **AND** the block SHALL state that `/mcp` is not the owner-agent transport

#### Scenario: Metadata remains safe on unsupported deployments
- **WHEN** owner-agent onboarding is disabled, misconfigured, or not safely available
- **THEN** the reference SHALL omit the trusted-owner-agent advisory block
- **AND** protected-resource metadata SHALL remain valid for ordinary grant-scoped clients

### Requirement: Trusted owner-agent approval SHALL avoid bearer-token paste flows

The reference implementation SHALL provide a browser-mediated owner approval path for trusted owner-agent credentials. The happy path SHALL avoid printing bearer material into chat, terminal transcripts, dashboard status tables, or logs.

#### Scenario: Owner approves a local agent
- **WHEN** a local owner agent initiates or follows the trusted owner-agent onboarding flow
- **THEN** the owner SHALL approve the request through an owner-authenticated browser or dashboard-mediated flow
- **AND** the flow SHALL write or hand off bearer material only through an owner-controlled local credential target
- **AND** user-visible transcripts SHALL print non-secret metadata such as token kind, client id, expiry, and revocation handle rather than the bearer itself

#### Scenario: Owner denies or revokes the local agent
- **WHEN** the owner denies the onboarding request or revokes the issued credential
- **THEN** the agent SHALL receive a non-secret failure or revocation status
- **AND** subsequent owner-agent REST calls with that bearer SHALL fail as revoked or inactive

### Requirement: Owner-agent bearers SHALL remain REST/control-plane credentials

The reference implementation SHALL preserve the route-auth boundary for owner-agent credentials. Owner-agent bearers SHALL authorize only the owner-level REST/control-plane routes that explicitly accept owner bearers, and `/mcp` SHALL reject owner bearers.

#### Scenario: Owner-agent bearer reads owner REST data
- **WHEN** a trusted local owner agent calls an owner-bearer-supported `/v1/**` REST route with a valid owner-agent bearer
- **THEN** the reference SHALL authorize the request according to owner-token semantics
- **AND** the response SHALL expose owner-visible streams, records, schemas, blobs, and metadata subject to the route's existing owner behavior

#### Scenario: Owner-agent bearer calls MCP
- **WHEN** a caller sends a trusted owner-agent bearer to `/mcp`
- **THEN** the reference SHALL reject the request
- **AND** the error SHALL direct ordinary MCP clients toward grant-scoped MCP setup rather than owner-bearer use

### Requirement: Owner-agent read guidance SHALL support current and future data efficiently

The reference implementation SHALL provide a testable owner-agent access pattern that lets a local owner agent maintain an incremental view of current and future owner data without broad repeated scans.

#### Scenario: Owner-agent performs initial sync
- **WHEN** a trusted local owner agent starts with a valid owner-agent bearer
- **THEN** it SHALL discover `/v1/schema` and `/v1/streams` before record reads
- **AND** it SHALL use `connection_id` to attribute and disambiguate records in multi-connection deployments
- **AND** it SHALL store local sync state per stream and connection

#### Scenario: Owner-agent performs incremental sync
- **WHEN** the trusted local owner agent refreshes its local view after initial sync
- **THEN** it SHALL prefer `changes_since`, pagination cursors, declared filters, and schema-advertised capabilities over rescanning all records
- **AND** it SHALL refresh schema and stream metadata periodically so newly visible streams and connections can be discovered
- **AND** it SHALL fetch blobs by reference only when needed

#### Scenario: Owner-agent chooses between callbacks and polling
- **WHEN** the trusted local owner agent has a durable valid-TLS HTTPS callback receiver
- **THEN** it MAY create event subscriptions for low-latency update notification where the reference advertises trusted owner-agent support
- **AND** when it lacks such a receiver it SHALL use cursor polling instead of attempting callback delivery to an unreachable local endpoint

### Requirement: `GET /v1/schema` SHALL offer an additive compact view

The reference implementation SHALL expose an additive, opt-in compact projection
of the `rs.schema.get` response on `GET /v1/schema`, selected by `view=compact`,
optionally scoped to a single stream by `stream=<name>`. The compact view SHALL
materially reduce the response size while preserving the identity an owner-agent
REST client needs to continue the `list_streams -> schema(stream) ->
query_records` discovery path. The full body SHALL remain the default. The
compact view SHALL NOT be the default in this capability and SHALL NOT alter
grant evaluation, visibility, connection identity, or the deprecated
`connector_instance_id` alias. The public route contract and generated OpenAPI
artifact SHALL document the `view` and `stream` query selectors and SHALL admit
both full field-capability objects and compact field-capability flag strings on
the schema response.

#### Scenario: Omitted view preserves the full body

- **WHEN** a caller requests `GET /v1/schema` without a `view` parameter
- **THEN** the response SHALL be the exhaustive `rs.schema.get` body, byte-for-byte equivalent to the prior behavior, including the raw per-stream and per-field JSON Schema
- **AND** the response SHALL NOT carry a `detail: "compact"` marker

#### Scenario: Compact view returns a smaller identity-preserving projection

- **WHEN** a caller requests `GET /v1/schema?view=compact`
- **THEN** the response SHALL preserve the envelope shape (`object: "schema"`, `bearer`, `connectors[]`) and carry a top-level `detail: "compact"` marker
- **AND** each stream SHALL preserve its stream identity (`name`) and per-connection identity (`granted_connections[].{connection_id, display_name}`, and the deprecated `connector_instance_id` alias where the stream entry exposes it)
- **AND** each field of `field_capabilities` SHALL be projected to a single terse capability-flag string carrying its declared type, grant flag, and usable filter/search/aggregation flags
- **AND** the response SHALL NOT include the raw per-stream JSON Schema or the raw per-field JSON Schema
- **AND** the projected body SHALL be materially smaller than the full body for a schema document carrying verbose per-field JSON Schema

#### Scenario: Compact view scoped to a single stream

- **WHEN** a caller requests `GET /v1/schema?view=compact&stream=<name>`
- **THEN** the response SHALL include only connectors that contribute the named stream, and within each such connector only the named stream
- **AND** each surviving connector's `stream_count` SHALL equal the number of streams it contributes after scoping
- **AND** the per-field capability flags SHALL remain present on the scoped stream

#### Scenario: Unknown stream scope is empty, not an error

- **WHEN** a caller requests `GET /v1/schema?view=compact&stream=<name>` for a stream no granted connector exposes
- **THEN** the response SHALL be a successful compact schema body with an empty `connectors` array
- **AND** the response SHALL NOT be an error

#### Scenario: Compact projection is a route-level down-projection

- **WHEN** the compact view is produced
- **THEN** it SHALL be a pure transform applied to the response the canonical `rs.schema.get` operation already produced, after the operation runs and before envelope finalization
- **AND** it SHALL NOT recompute visibility, grant scope, or disclosure totals
- **AND** the route contract and generated artifacts SHALL describe the compact selector and response marker without making compact the default

### Requirement: The reference deployable shape SHALL be three independent artifacts

The reference implementation SHALL produce three independently buildable and deployable artifacts from this repository: the public-site deployable, the operator-console deployable, and the reference-implementation AS/RS service. Each SHALL be deployable without the others. Shared UI between the public-site sandbox and the operator-console dashboard SHALL live in a workspace package consumed by both rather than being duplicated.

#### Scenario: Three deployable artifacts exist

- **WHEN** the repository is built for release
- **THEN** the build SHALL produce a public-site deployable, an operator-console deployable, and a reference-implementation AS/RS deployable
- **AND** each artifact SHALL be deployable in isolation

#### Scenario: Sandbox and dashboard share UI

- **WHEN** the public-site sandbox and the operator-console dashboard render the same feature surface (records, search, grants, runs, traces, deployment, timelines, or related operator UI)
- **THEN** the shared feature components SHALL live in a workspace package (e.g. `packages/operator-ui`) imported by both deployables
- **AND** neither deployable SHALL duplicate those feature components in its own source tree

#### Scenario: The operator deploys console + reference only

- **WHEN** an operator runs `docker compose up` (or the equivalent local deploy) for a self-hosted PDPP reference instance
- **THEN** the operator-console deployable and the reference-implementation AS/RS service SHALL be sufficient to serve `/dashboard/**` and the AS/RS routes
- **AND** the public-site deployable SHALL NOT be required for that deployment to function

#### Scenario: The reference-implementation service stays a substrate

- **WHEN** the public-site deployable or the operator-console deployable evolves
- **THEN** the reference-implementation service SHALL remain runnable on its own (its existing CLI entrypoints, AS/RS HTTP routes, and `hosted-ui.js`-served `/consent`, `/device`, `/owner/login` pages SHALL keep working without the operator-console deployable)
- **AND** the reference-implementation service SHALL NOT acquire build-time or runtime dependencies on either Next deployable

### Requirement: Public read operations SHALL expose canonical connection identity

The reference implementation SHALL expose `connection_id` and an owner-meaningful `display_name` on grant-authorized read responses, and SHALL accept an optional `connection_id` filter on grant-authorized read inputs, so that multi-connection deployments are disambiguatable through the public read contract using the canonical public noun. `connection` is the canonical public/operator/LLM-facing noun for an owner-configured concrete data source account/device/profile.

#### Scenario: `rs.streams.list` returns per-connection entries

- **WHEN** a grant-authorized client calls `rs.streams.list` against a deployment that has more than one active connection contributing to a stream under the caller's grant
- **THEN** the response SHALL include one entry per (stream, connection_id) pair
- **AND** each entry SHALL include `connection_id` and an owner-meaningful `display_name`
- **AND** single-connection deployments SHALL preserve their current entry shape with `connection_id` and `display_name` populated from the sole active connection.

#### Scenario: Read operations accept an optional connection filter

- **WHEN** a grant-authorized client calls `rs.records.list`, `rs.streams.detail`, `rs.records.detail`, `rs.search.lexical`, `rs.search.semantic`, `rs.search.hybrid`, or `rs.blobs.read` with a `connection_id` argument
- **THEN** the operation SHALL restrict its scan or lookup to records, streams, hits, or blobs from that connection
- **AND** the response SHALL carry `connection_id` on each result item so callers can attribute the data.

#### Scenario: Existing single-connection consumers are not broken

- **WHEN** a previously-deployed grant-authorized client that does not know about `connection_id` calls any read operation against a single-connection deployment
- **THEN** the operation SHALL succeed with current semantics
- **AND** the new fields on the response SHALL be additive rather than reshape existing fields.

#### Scenario: Exactly-one matching connection is auto-selected

- **WHEN** a grant-authorized client omits `connection_id` on any read operation
- **AND** the caller's grant authorizes exactly one matching connection for the addressed stream or identifier
- **THEN** the operation SHALL implicitly select that connection
- **AND** the operation SHALL NOT raise an ambiguity error.

### Requirement: Multi-connection list and search reads SHALL fan in by default

Omitting `connection_id` on a fan-in-capable read SHALL NOT raise an ambiguity error. The reference implementation SHALL return the union of records, streams, or hits across the connections the caller's grant authorizes for the addressed stream. Fan-in-capable operations are `rs.streams.list`, `rs.records.list`, `rs.streams.detail`, `rs.search.lexical`, `rs.search.semantic`, and `rs.search.hybrid`.

#### Scenario: Unfiltered records list fans in across granted connections

- **WHEN** a grant-authorized client calls `rs.records.list` for a stream that resolves to more than one connection under the caller's grant
- **AND** the client omits `connection_id`
- **THEN** the operation SHALL return the union of records across the granted connections for that stream
- **AND** each record item in the response SHALL carry `connection_id` so the caller can attribute it
- **AND** the operation SHALL NOT raise the typed `ambiguous_connection` error from connection multiplicity alone.

#### Scenario: Unfiltered search fans in across granted connections

- **WHEN** a grant-authorized client calls `rs.search.lexical`, `rs.search.semantic`, or `rs.search.hybrid` against a stream that resolves to more than one connection under the caller's grant
- **AND** the client omits `connection_id`
- **THEN** the operation SHALL return the union of hits across the granted connections for that stream
- **AND** each hit SHALL carry `connection_id`
- **AND** the operation SHALL NOT raise the typed `ambiguous_connection` error from connection multiplicity alone.

#### Scenario: Stream detail fans in across granted connections

- **WHEN** a grant-authorized client calls `rs.streams.detail` for a stream that resolves to more than one connection under the caller's grant
- **AND** the client omits `connection_id`
- **THEN** the operation SHALL return a stream view that aggregates across the granted connections
- **AND** the response SHALL identify the constituent connections via `available_connections: [{ connection_id, display_name }]`.

### Requirement: Identifier-ambiguous reads SHALL emit a typed ambiguous-connection error

The reference implementation SHALL emit a typed `ambiguous_connection` error from `rs.records.detail` and `rs.blobs.read` when the addressed record or blob identifier resolves to more than one connection under the caller's grant and the client did not pass `connection_id`. The error envelope SHALL list the candidate connections so the client can recover without an extra round trip.

#### Scenario: Record identifier resolves to multiple connections

- **WHEN** a grant-authorized client calls `rs.records.detail` for an identifier that resolves to more than one connection under the caller's grant
- **AND** the client did not pass `connection_id`
- **THEN** the operation SHALL fail with a typed `ambiguous_connection` error
- **AND** the error envelope SHALL include `available_connections: [{ connection_id, display_name }]` covering exactly the candidate connections within the caller's grant
- **AND** the error envelope SHALL carry human-readable guidance instructing the caller to retry with `connection_id`.

#### Scenario: Blob identifier resolves to multiple connections

- **WHEN** a grant-authorized client calls `rs.blobs.read` for a blob identifier that resolves to more than one connection under the caller's grant
- **AND** the client did not pass `connection_id`
- **THEN** the operation SHALL fail with a typed `ambiguous_connection` error
- **AND** the error envelope SHALL include `available_connections: [{ connection_id, display_name }]`
- **AND** the error envelope SHALL carry human-readable guidance instructing the caller to retry with `connection_id`.

#### Scenario: Read-path error is distinct from scheduler-side error

- **WHEN** a grant-authorized client triggers the new read-path `ambiguous_connection` error
- **THEN** the error SHALL be emitted by the read operation under the canonical `connection` noun
- **AND** the reference SHALL NOT alter the existing scheduler-side `ambiguous_connector_instance` behavior at `reference-implementation/runtime/controller.ts` that fires when an owner schedules a run.

### Requirement: Grant scope SHALL accept an optional connection constraint

Grant scope shapes used by grant-authorized read operations SHALL accept an optional `connection_id` per stream entry. Grants without the field SHALL preserve current cross-connection (fan-in) read semantics; grants with the field SHALL constrain disclosure to records, hits, or blobs from the named connection.

#### Scenario: Grant without connection constraint

- **WHEN** a grant scope entry for a stream omits `connection_id`
- **THEN** read operations SHALL fan in across the connections that the grant authorizes for that stream
- **AND** previously-issued grants SHALL continue to function without re-issuance.

#### Scenario: Grant with connection constraint

- **WHEN** a grant scope entry for a stream includes a `connection_id`
- **THEN** read operations under that grant SHALL only return records, hits, or blobs from the named connection for that stream
- **AND** the consent surface used to issue the grant SHALL have shown that per-connection constraint to the owner before issuance.

### Requirement: Owner-meaningful display name SHALL be owner-editable

The reference implementation SHALL provide an owner-authenticated mutation for `connection.display_name` so that the protocol-surfaced label can be edited by the owner. The mutation SHALL live on the same operator surface as the existing `ref-connectors-list` reader and SHALL NOT be reachable by grant-authorized clients.

#### Scenario: Owner renames a connection

- **WHEN** an authenticated owner submits a new `display_name` for one of their connections
- **THEN** the reference SHALL persist the new label
- **AND** subsequent `rs.streams.list` responses SHALL surface the updated `display_name`
- **AND** subsequent typed `ambiguous_connection` read-path errors SHALL list the updated `display_name` in `available_connections`.

#### Scenario: Grant-authorized client attempts to write

- **WHEN** a request bearing a grant-authorized client token attempts to invoke the `display_name` mutation
- **THEN** the reference SHALL reject the request
- **AND** the mutation SHALL NOT be advertised on grant-authorized surfaces.

### Requirement: Consent surfaces SHALL show per-connection labels and SHALL NOT leak implementation placeholders

Consent surfaces (consent card, grant request flow, and any dashboard or MCP rendering that names a connection to the owner) SHALL render each granted connection with a per-connection label sourced from `display_name`. They SHALL NOT render `legacy`, `default_account`, or any raw storage-layer placeholder as the primary label.

#### Scenario: Multi-connection grant renders distinct per-connection labels

- **WHEN** a consent card is rendered for a grant that authorizes more than one connection of the same connector type
- **THEN** the card SHALL render one scope row per connection
- **AND** each row SHALL use that connection's `display_name` as the primary label
- **AND** the rendered labels SHALL be visibly distinct from each other.

#### Scenario: Never-renamed connection renders an owner-meaningful default

- **WHEN** the reference renders `display_name` for a connection that the owner has never renamed
- **THEN** the rendered label SHALL be derived from connector type plus a stable disambiguator (for example `Gmail · account 2`)
- **AND** the rendered label SHALL NOT be `"legacy"`, `"legacy (pre-header)"`, `"default_account"`, or any raw storage-layer placeholder.

#### Scenario: No user-visible legacy or default-account text

- **WHEN** the reference renders any user-visible connection label on the consent card, the dashboard, or a grant-authorized read response
- **THEN** inherited `"legacy"`/`"legacy (pre-header)"`/`"default_account"` strings SHALL NOT appear as the rendered primary label
- **AND** any reference dashboard diagnostic or status copy inherited from pre-connection storage SHALL be removed or replaced with an owner-meaningful label.

### Requirement: `connector_instance_id` SHALL be supported as a compatibility alias only

The public contract noun is `connection_id`. The reference implementation MAY accept `connector_instance_id` as a request-time alias for `connection_id` during a deprecation window, and MAY emit `connector_instance_id` alongside `connection_id` on response envelopes during the same window, so that downstream consumers can migrate without breakage. `connector_instance_id` SHALL NOT be advertised as the canonical public field name.

#### Scenario: Request supplies `connector_instance_id` only

- **WHEN** a grant-authorized client passes `connector_instance_id` (and not `connection_id`) on a read operation
- **AND** the alias is still within the deprecation window
- **THEN** the reference SHALL treat the value as if `connection_id` had been supplied with the same opaque value
- **AND** the operation SHALL succeed exactly as it would have under `connection_id`.

#### Scenario: Request supplies both fields with different values

- **WHEN** a grant-authorized client passes both `connection_id` and `connector_instance_id` on a read operation
- **AND** the two values refer to different connections
- **THEN** the reference SHALL reject the request with a typed `invalid_argument` error citing the conflicting fields.

#### Scenario: Response carries both fields during deprecation window

- **WHEN** the reference returns a read response within the `connector_instance_id` deprecation window
- **THEN** each response item SHALL carry `connection_id` as the canonical field
- **AND** each response item MAY additionally carry `connector_instance_id` with the same opaque value
- **AND** the contract documentation SHALL mark `connector_instance_id` as deprecated.

#### Scenario: Internal storage retains `connector_instance_id`

- **WHEN** the reference reads or writes connection identity in storage (`reference-implementation/server/postgres-*.js`, `connector-instance-store.js`) or in runtime/orchestrator code (`runtime/controller.ts`)
- **THEN** the storage layer and runtime MAY continue to use the column and identifier name `connector_instance_id`
- **AND** the rename to `connection_id` SHALL apply at the public contract surface only.

### Requirement: Fan-in reads SHALL be cursor- and count-honest or explicitly unsupported

When `rs.records.list` fans in across more than one connection, the reference implementation SHALL NOT synthesize a cross-connection `next_cursor` or a cross-connection `next_changes_since` cursor whose forward-progress semantics cannot be soundly reconstructed from per-connection state. The implementation SHALL either preserve sound pagination/change-tracking semantics with per-connection version counters or reject the unsupported shape with typed errors and recovery guidance. `meta.count` under fan-in SHALL accurately reflect the data returned in the response: either the union of exact per-connection counts, or omitted with a structured `count_downgraded` warning.

#### Scenario: `changes_since` under multi-connection fan-in

- **WHEN** a grant-authorized client calls `rs.records.list` with `changes_since` against a stream that resolves to more than one connection under the caller's grant
- **AND** the client did not narrow with `connection_id`
- **THEN** the reference SHALL reject the request with a typed `invalid_argument` error
- **AND** the error envelope SHALL include human-readable guidance instructing the caller to retry with `connection_id` so the cursor is bound to a single connection
- **AND** the error envelope SHALL include `available_connections: [{ connection_id, display_name? }]` so the caller can choose a connection without an extra round trip.

#### Scenario: Pagination under multi-connection fan-in

- **WHEN** a grant-authorized client calls `rs.records.list` (without `changes_since`) against a stream that resolves to more than one connection under the caller's grant
- **AND** the union response page reports `has_more=true` from any contributing connection
- **THEN** the response SHALL NOT include a `next_cursor` field
- **AND** the response `meta.warnings[]` SHALL include a structured entry with code `partial_results` and `param: "connection_id"` instructing the caller to retry with `connection_id` to page a single connection exhaustively.

#### Scenario: Count under multi-connection fan-in

- **WHEN** a grant-authorized client calls `rs.records.list` with `count=exact` (or `count=estimated`) against a stream that resolves to more than one connection under the caller's grant
- **AND** every contributing connection produced an `exact` per-connection count
- **THEN** the response `meta.count` SHALL carry `{ kind: 'exact', value: <sum of per-connection counts> }`
- **AND** the response SHALL NOT report whichever per-connection count ran last.

#### Scenario: Count downgrade under multi-connection fan-in

- **WHEN** a grant-authorized client calls `rs.records.list` with `count=exact` (or `count=estimated`) under fan-in
- **AND** at least one contributing connection did not produce an `exact` count
- **THEN** the response SHALL omit `meta.count`
- **AND** the response `meta.warnings[]` SHALL include a structured entry with code `count_downgraded` and `param: "count"` instructing the caller to retry with `connection_id` to receive an exact per-connection count.

### Requirement: Grant scope per-stream `connection_id` SHALL be enforced on every read path

When a grant pins a per-stream `connection_id`, the reference SHALL apply that constraint on every read path that addresses the stream — including `rs.records.list`, `rs.records.detail`, `rs.streams.list`, `rs.streams.detail`, `rs.streams.aggregate`, and `rs.blobs.read`. A pinned grant SHALL NOT expose records or blob bytes reachable only from a different connection under the same connector, even when those records would otherwise satisfy a fan-in scan.

#### Scenario: Blob read respects per-stream connection constraint

- **WHEN** a grant pins stream `S` to `connection_id = X`
- **AND** a grant-authorized client calls `rs.blobs.read` for a blob whose `blob_bindings` reference records under connection `Y` for stream `S` (and not under `X`)
- **THEN** the reference SHALL respond `blob_not_found` (404) for the blob bytes from `Y`
- **AND** the reference SHALL NOT serve `Y`'s bytes under the pinned grant.

#### Scenario: Streams-list honors per-stream connection constraint independently

- **WHEN** a grant authorizes streams `A` and `B` with `A` pinned to `connection_id = X` and `B` pinned to `connection_id = Y`
- **AND** a grant-authorized client calls `rs.streams.list`
- **THEN** the response SHALL include a summary for `A` sourced from connection `X` only
- **AND** the response SHALL include a summary for `B` sourced from connection `Y` only
- **AND** the reference SHALL NOT combine per-stream record counts across mismatched (stream, connection_id) pairs.

### Requirement: Resolver-level deprecated-alias warnings SHALL surface on every public read envelope

When a request uses the deprecated `connector_instance_id` alias, the reference SHALL surface a structured `deprecated_alias_used` warning on the response envelope's `meta.warnings[]` (or, for the binary blob route which has no JSON envelope, on a response header) regardless of whether the read dispatched through the single-binding fast path or the multi-binding fan-in path.

#### Scenario: Fan-in records list surfaces deprecated alias

- **WHEN** a grant-authorized client calls `rs.records.list` with `connector_instance_id=<X>` against a stream that resolves to more than one connection under the caller's grant
- **AND** the resolved binding set is non-empty
- **THEN** the response `meta.warnings[]` SHALL include a `deprecated_alias_used` entry pointing at the `connector_instance_id` parameter.

#### Scenario: Fan-in aggregate surfaces deprecated alias

- **WHEN** a grant-authorized client calls `rs.streams.aggregate` with `connector_instance_id=<X>` against a stream that resolves to more than one connection under the caller's grant
- **THEN** the response `meta.warnings[]` SHALL include a `deprecated_alias_used` entry.

#### Scenario: Blob route surfaces deprecated alias via response header

- **WHEN** a grant-authorized client calls `rs.blobs.read` with `connector_instance_id=<X>`
- **AND** the read completes with `200 OK`
- **THEN** the response SHALL include a `PDPP-Warning` response header naming the `deprecated_alias_used` code for the `connector_instance_id` parameter.

### Requirement: Streaming interaction sessions are reference-only and interaction-scoped

The reference implementation SHALL treat browser streaming as a reference-only control-plane companion for pending run interactions. Streaming sessions SHALL be scoped to one pending run interaction and SHALL NOT authorize record reads, consent approval, grant issuance, collector ingest, or unrelated browser access.

#### Scenario: A pending manual action needs browser control

- **WHEN** a connector run reaches a pending interaction that requires browser control
- **THEN** the reference MAY mint a short-lived streaming session link for the owner
- **AND** the link SHALL be scoped to the current run and interaction
- **AND** the link SHALL expire or be invalidated when the interaction resolves, is cancelled, or the run ends

#### Scenario: A stale stream link is opened

- **WHEN** a streaming link is expired, already consumed, bound to a non-current interaction, or bound to a completed run
- **THEN** the reference SHALL refuse the stream
- **AND** it SHALL show an owner-actionable terminal state without exposing connector secrets or browser state

### Requirement: Streaming control does not replace collector or owner credentials

The reference implementation SHALL keep streaming session authority separate from collector credentials and owner tokens. A streaming session SHALL only authorize viewing and input for the scoped browser interaction.

#### Scenario: A stream viewer sends input

- **WHEN** a stream viewer sends mouse, keyboard, touch, or resize input
- **THEN** the reference SHALL route that input only to the browser session associated with the scoped pending interaction
- **AND** it SHALL NOT treat the streaming token as an owner session, collector device token, or client grant token

### Requirement: CDP is the default streaming implementation path

The reference implementation SHOULD use CDP screencast frames and CDP input events for the first streaming companion implementation. Heavier remote-browser substrates SHALL NOT be introduced unless a concrete connector case proves CDP insufficient.

#### Scenario: The owner opens the stream on a mobile device

- **WHEN** the stream viewer starts from a mobile-sized device
- **THEN** the reference SHALL size or map the browser viewport and input coordinates so the owner can complete the pending interaction from that device class
- **AND** it SHALL document unsupported controls such as multi-touch gestures if they are not implemented

### Requirement: Streaming companion fails closed when unconfigured

The reference implementation SHALL refuse to mint a streaming session token when no streaming companion is configured. It SHALL NOT issue a token that only fails at attach time, because that surfaces as a dead primary action in the dashboard with no operator-actionable error.

#### Scenario: The owner opens the stream on a server with no CDP companion configured

- **WHEN** the owner requests a streaming session on a reference deployment that has no CDP companion configured (no `PDPP_RUN_INTERACTION_CDP_WS_URL`, no `PDPP_RUN_INTERACTION_CDP_HTTP_URL`, and no injected companion factory)
- **THEN** the mint endpoint SHALL respond with `503 streaming_companion_unavailable`
- **AND** the response SHALL name the configuration the operator must set
- **AND** the dashboard SHALL render a configuration-pointer state instead of the streaming canvas

### Requirement: n.eko streaming preserves an owner-controlled browser UX

When the reference implementation uses n.eko as a streaming backend, it SHALL keep the sidecar behind the same stream-token lifecycle while presenting the owner with an embedded browser-control surface rather than a general n.eko room UI. The n.eko surface SHOULD use direct n.eko client integration when available so the reference can preserve native input, clipboard, focus, and geometry behavior without exposing n.eko product controls. Routine n.eko assistive browser control SHALL use a Patchright-mediated browser-client seam rather than adapter-owned raw page-CDP helper commands; strict/browser-owner mode SHALL remain usable for baseline viewing and input without a page-level browser attach.

#### Scenario: A managed connector is configured by canonical connector URL

- **WHEN** `PDPP_NEKO_MANAGED_CONNECTORS` names a connector by its canonical `/connectors/{connector_id}` URL
- **AND** the run source identifies the same connector by short `connector_id`
- **THEN** the reference SHALL treat the run as managed by the n.eko browser-surface pool
- **AND** it SHALL acquire or queue a browser-surface lease before spawning the connector child

#### Scenario: The owner opens a n.eko-backed stream

- **WHEN** the stream companion selects the n.eko backend for a pending manual action
- **THEN** the dashboard SHALL render the n.eko browser surface through the token-scoped same-origin proxy
- **AND** it SHALL suppress n.eko branding, resolution menus, and non-essential room chrome in the embedded owner view
- **AND** the sidecar SHALL NOT be reachable without the scoped stream token or stream proxy cookie

#### Scenario: The owner resizes or rotates the viewer

- **WHEN** the n.eko-backed viewer viewport changes size or mobile/touch characteristics
- **THEN** the reference SHOULD preserve geometry agreement between the visible browser viewport, n.eko's screen model, and input coordinates
- **AND** it SHOULD use exact 1:1 dimensions when n.eko/X11/Chromium can represent them
- **AND** otherwise it SHOULD use local crop/remap only for residual capture gutters rather than arbitrary stretching
- **AND** the reference SHOULD propagate the new dimensions to n.eko screen configuration and to Patchright-owned page viewport controls where those control paths are available
- **AND** failures in those best-effort control paths SHALL NOT expose unrelated browser authority or invalidate the stream token

#### Scenario: The owner pastes text into the remote browser

- **WHEN** the owner pastes text while using a n.eko-backed stream
- **THEN** the reference SHOULD preserve the native same-origin n.eko clipboard/input path
- **AND** any explicit fallback paste bridge SHALL route pasted text only to the scoped browser interaction
- **AND** the reference SHOULD NOT mirror mobile IME text-entry echoes into the owner's local clipboard

#### Scenario: The owner focuses a remote text field from a phone

- **WHEN** an assistive n.eko-backed stream detects that the remote page focused an editable element
- **THEN** the dashboard SHOULD focus n.eko's owner-side keyboard overlay so the mobile software keyboard opens
- **AND** when the remote page blurs the editable element, the dashboard SHOULD blur the overlay so the software keyboard can dismiss
- **AND** strict browser-owner mode SHALL still work without requiring that page-level focus bridge

#### Scenario: Assistive n.eko browser control uses the Patchright seam

- **WHEN** a n.eko-backed stream is in assistive mode and needs page navigation, page viewport sizing, page status, focus bridging, copy, or paste helpers
- **THEN** the reference SHALL perform those operations through the Patchright-mediated browser-client seam
- **AND** the n.eko adapter SHALL NOT open its own page-target WebSocket for those routine controls
- **AND** the n.eko adapter SHALL NOT send `Runtime.enable`, `Runtime.addBinding`, direct `Page.addScriptToEvaluateOnNewDocument`, `Browser.setWindowBounds`, `Emulation.setUserAgentOverride`, or direct device/touch emulation commands for those routine controls

#### Scenario: Balanced n.eko mode is accepted for compatibility

- **WHEN** existing configuration requests n.eko `balanced` mode
- **THEN** the reference SHALL treat it as the assistive Patchright-mediated path or reject it with an operator-actionable compatibility message
- **AND** it SHALL NOT preserve `balanced` as a third browser-control posture with a separate raw-CDP helper path

#### Scenario: A stealth-sensitive n.eko stream is opened

- **WHEN** a n.eko stream is marked stealth-sensitive or browser-owner-managed
- **THEN** the reference SHALL NOT require page-level CDP scripts, Runtime bindings, or CDP paste helpers for baseline viewing and input
- **AND** browser fingerprint controls such as user agent, client hints, device scale, touch capability, proxy, and profile SHALL be owned by the browser launch/profile boundary rather than silently mutated by the viewer mid-page
- **AND** any page-level helper SHALL be gated behind explicit assistive mode or equivalent operator choice

#### Scenario: A local non-n.eko browser-backed connector launches

- **WHEN** a browser-backed connector runs without a managed n.eko browser-surface lease
- **THEN** the reference SHALL prefer Patchright's bundled Chromium unless the operator explicitly configures a browser channel override
- **AND** the reference SHALL keep the explicit browser channel override as an operator compatibility control rather than silently preferring branded Chrome
- **AND** the local launch path SHALL preserve Patchright-owned launch defaults instead of duplicating n.eko-specific X11/window flags

### Requirement: Stream viewer control policy is replayable

The reference implementation SHALL keep stream viewer protocol parsing,
viewport classification, keyboard-occlusion policy, and media-settle policy
observable through pure, replayable modules. The React viewer SHALL remain
responsible for DOM lifecycle and side effects, but SHOULD NOT be the only
place where stream control decisions can be observed or tested.

#### Scenario: A mobile viewport emits transient resize events

- **WHEN** the owner opens a stream on a mobile browser and browser chrome,
  orientation, or software keyboard events change viewport geometry
- **THEN** the reference SHOULD classify the observed layout viewport, visual
  viewport, focus intent, and orientation facts before POSTing a remote viewport
- **AND** it SHOULD avoid resizing the remote browser for keyboard occlusion
  alone
- **AND** it SHOULD hold local presentation remaps during orientation and
  browser-chrome settle so transient dimensions are not shown as stretched
  stream frames
- **AND** it SHOULD make the classification replayable from redacted telemetry

#### Scenario: A n.eko resize is requested

- **WHEN** the viewer requests a new n.eko-backed viewport size
- **THEN** the reference SHOULD distinguish the requested viewport from the
  n.eko screen status, media intrinsic size, and WebRTC inbound frame size
- **AND** it MAY request bounded high-DPR n.eko screen/capture dimensions
  separately from the CSS viewport dimensions when the viewer display would
  otherwise upscale the decoded media
- **AND** it SHOULD avoid treating the stream as visually settled until those
  facts agree or a degraded state is diagnosed

### Requirement: Browser-step instructions avoid accidental interaction resolution

The reference implementation SHALL keep browser-step guidance visible enough for an owner to complete the pending
connector step without making a non-terminal panel control look like the completion action. If the guidance can cover
the browser surface, the viewer SHALL provide a non-terminal way to hide and restore it.

#### Scenario: Browser-step guidance covers an interactive page element

- **WHEN** the owner is using the stream viewer to complete a pending browser step
- **THEN** the viewer SHALL provide a hide or minimize affordance that does not resolve the interaction
- **AND** the viewer SHALL provide a way to restore the guidance without changing the run state

#### Scenario: The owner completes the browser step

- **WHEN** the owner uses the action that resumes or resolves the pending browser step
- **THEN** the action label SHALL make it clear that the run will continue after the current browser step

### Requirement: Connector detail cursors are stream-specific
When a reference connector derives a child stream by fetching details for records discovered through a parent stream, the reference implementation SHALL track child-detail progress separately from the parent-list cursor. A parent stream cursor SHALL NOT cause a later child-stream collection to skip parent records whose child detail has not yet been collected.

#### Scenario: Child stream enabled after parent-only run
- **WHEN** a parent stream has advanced its cursor during a parent-only collection run
- **THEN** a later collection run that requests the child stream SHALL still fetch detail for parent records not yet covered by the child stream cursor

#### Scenario: Detail cursor advances after coverage
- **WHEN** child detail collection completes or records recoverable detail gaps for a batch of parent records
- **THEN** the child stream cursor SHALL advance only after the corresponding detail coverage is emitted

### Requirement: Reference Lexical Backfill Uses Active Storage And Connections

The reference implementation SHALL compute lexical index drift against the active
record storage backend and rebuild lexical index rows in that same backend. When
a connector manifest is registered without a pinned connector instance, lexical
backfill SHALL evaluate active owner-visible connector instances for that
connector rather than only the connector's default synthetic instance. Drift
detection SHALL compare the index row count to the exact number of non-empty
declared text values for each `(connector_instance_id, stream)` and SHALL NOT
treat an arbitrary non-zero in-band index count as complete.

#### Scenario: Postgres backfill reads and writes Postgres

- **WHEN** the reference server runs with Postgres-backed record storage
- **THEN** lexical backfill SHALL read records, index rows, and meta fingerprints
  from Postgres
- **AND** rebuilt lexical rows SHALL be written to Postgres

#### Scenario: Unpinned manifest covers active connections

- **WHEN** a registered connector manifest declares searchable fields but is not
  pinned to a single connector instance
- **AND** the owner has an active connection for that connector
- **THEN** lexical backfill SHALL check and rebuild the active connection's
  `(connector_instance_id, stream)` index state
- **AND** it SHALL NOT limit the check to the default synthetic connector
  instance

#### Scenario: Partial historical index is rebuilt

- **WHEN** a stream has more indexable declared text values than lexical index
  rows for the same `(connector_instance_id, stream)`
- **THEN** lexical backfill SHALL treat the stream as stale or partial and
  rebuild it
- **AND** it SHALL NOT accept the partial index merely because at least one index
  row exists

#### Scenario: Startup manifest reconciliation does not block health

- **WHEN** startup manifest reconciliation updates first-party connector
  manifests before AS/RS listen
- **THEN** it SHALL NOT synchronously run full retrieval index rebuilds for those
  manifests before the servers listen
- **AND** retrieval index repair SHALL run through the post-listen startup
  backfill path

### Requirement: Chase current activity stays separate from posted transactions
The reference Chase connector SHALL expose UI-visible pending or current-cycle account activity through a separate `current_activity` stream rather than by changing the posted-only `transactions` stream. The `transactions` stream SHALL remain QFX/Web Connect derived, posted-only, append-only, and keyed by Chase QFX `FITID`.

#### Scenario: Chase UI shows activity that QFX does not export
- **WHEN** Chase's account activity UI shows pending or current-cycle rows that are not present in a QFX/Web Connect export
- **THEN** the reference connector SHALL NOT emit those UI-only rows into `transactions`
- **AND** it SHALL emit supported UI-visible rows into `current_activity` when that stream is requested and the live UI surface can be parsed

#### Scenario: Pending activity is collected
- **WHEN** the connector observes a pending Chase activity row
- **THEN** the row SHALL be emitted only to `current_activity`
- **AND** the emitted record SHALL identify its status as pending rather than settled or posted

#### Scenario: Posted QFX transaction identity remains authoritative
- **WHEN** a posted Chase transaction appears in QFX output with a `FITID`
- **THEN** the connector SHALL continue to key the `transactions` record from `account_id|fitid`
- **AND** it SHALL NOT merge UI-derived `current_activity` identity into the `transactions` primary key

### Requirement: Chase current activity is modeled as mutable visibility data
The `current_activity` stream SHALL use `mutable_state` semantics and SHALL be described as UI-visible freshness data rather than as a settled accounting ledger.

#### Scenario: Chase exposes a stable UI transaction identifier
- **WHEN** a Chase current activity row includes a source-provided UI transaction identifier
- **THEN** the connector SHALL prefer that identifier when building the `current_activity` primary key

#### Scenario: Chase exposes no stable UI transaction identifier
- **WHEN** a Chase current activity row has no source-provided UI transaction identifier
- **THEN** the connector SHALL use a deterministic fallback key scoped to the account and visible row attributes
- **AND** it SHALL NOT claim that the fallback key preserves identity across pending-to-posted transitions

#### Scenario: Consumers request both Chase streams
- **WHEN** a client requests both `transactions` and `current_activity`
- **THEN** the stream metadata and schemas SHALL make clear that `transactions` is the posted QFX ledger and `current_activity` is volatile UI-visible activity

### Requirement: A configured Postgres runtime SHALL NOT require a persistent SQLite database at startup

The reference implementation SHALL select exactly one runtime persistence
backend at startup via `resolveStorageBackend()`. When the resolved backend is
`postgres`, normal `startServer()` startup SHALL NOT depend on opening,
creating, or migrating a persistent SQLite database. The configured SQLite file
path (`PDPP_DB_PATH` / `DB_PATH`) SHALL NOT be opened in Postgres mode.

A non-durable in-memory SQLite handle MAY remain available in Postgres mode for
compatibility with modules that hold a `getDb()` reference, provided it opens no
file, runs no persistent migration, serves no durable operator read or ingest
write, and is discarded on shutdown. Postgres SHALL own all runtime persistence
in Postgres mode.

When the resolved backend is `sqlite`, startup SHALL open and migrate the
configured persistent SQLite database as the runtime persistence store.

Backend-aware startup steps that persist state — including pre-registered client
seeding — SHALL execute after the active backend is established, so they
dispatch to the backend that owns runtime persistence.

#### Scenario: Postgres-mode boot does not open the persistent SQLite file
- **WHEN** the reference is configured for the Postgres storage backend and starts
- **THEN** `startServer()` SHALL reach HTTP readiness without opening or migrating the configured persistent SQLite database file
- **AND** the configured SQLite file path SHALL remain untouched on disk
- **AND** a persistent SQLite database that would fail to open or migrate SHALL NOT prevent Postgres-mode startup

#### Scenario: Postgres-mode boot seeds pre-registered clients into Postgres
- **WHEN** the reference starts in Postgres mode with pre-registered public clients configured
- **THEN** those clients SHALL be persisted to the Postgres backend
- **AND** they SHALL be readable through the active Postgres-backed client read path after startup

#### Scenario: SQLite-mode boot still owns persistence on the persistent file
- **WHEN** the reference is configured for the SQLite storage backend and starts
- **THEN** `startServer()` SHALL open and migrate the configured persistent SQLite database
- **AND** pre-registered clients SHALL be persisted to and readable from that SQLite database after startup

### Requirement: Both storage backends SHALL have explicit startup smoke coverage

The reference implementation SHALL exercise `startServer()` startup for both the
SQLite and Postgres backends through focused, repeatable tests, so a change that
breaks one backend's boot does not pass under the other backend's coverage. The
Postgres startup smoke MAY be gated on a configured Postgres test endpoint; when
that endpoint is unavailable the test SHALL register as skipped rather than
failing, and SHALL NOT be silently absent. When the Postgres startup smoke runs,
it SHALL use isolated test storage rather than seeding or mutating an operator's
live proof database.

#### Scenario: SQLite-only startup smoke runs by default
- **WHEN** the reference test suite runs without a configured Postgres test endpoint
- **THEN** a SQLite-mode startup smoke test SHALL boot `startServer()`, confirm readiness, and run by default
- **AND** the Postgres-mode startup smoke test SHALL register as skipped rather than be absent

#### Scenario: Postgres-only startup smoke runs against isolated Postgres storage
- **WHEN** the reference test suite runs with a configured Postgres test endpoint
- **THEN** a Postgres-mode startup smoke test SHALL boot `startServer()` against isolated Postgres storage
- **AND** it SHALL confirm startup reaches readiness without opening the configured persistent SQLite file

### Requirement: Startup migrations are bounded and large data backfills are explicit maintenance

Normal reference startup SHALL perform only bounded, idempotent schema
migrations. This covers both Postgres-mode startup and the SQLite migration
runner. Startup SHALL NOT run an unbounded full-table data backfill, and SHALL
NOT hold a long-running transaction or a table-level lock that blocks owner
reads of runtime tables such as `spine_events`.

Bounded idempotent schema work is permitted at startup: adding columns,
creating indexes, dropping superseded columns, and replacing constraints, as
long as each step is `IF NOT EXISTS`/guarded and does not scan-and-rewrite an
entire large runtime table.

Backfilling derived or denormalized values across an existing large runtime
table SHALL be one of: (a) an explicit operator maintenance script run off the
boot path, or (b) a tiny, capped, non-blocking batch at boot that uses short
transactions, makes progress without holding reader-blocking locks, and never
loops over rows it cannot resolve. Option (a) is the default for the disclosure
spine source columns.

Denormalized cache columns SHALL NOT be treated as the source of truth. When a
denormalized column (such as `spine_events.source_kind`/`source_id`) is NULL
for legacy rows, reads that do not filter on that column SHALL still return
correct results by deriving the value from the canonical payload
(`spine_events.data_json`) or runtime actor fallback. Dashboards and unfiltered
correlation summaries SHALL remain honest when legacy denormalized columns are
NULL.

#### Scenario: Normal Postgres startup does not backfill the spine table

- **WHEN** the reference boots in Postgres mode against a database whose
  `spine_events` table already has the `source_kind` and `source_id` columns
- **THEN** startup SHALL NOT issue a full `SELECT` of every `spine_events` row
  and SHALL NOT issue per-row `UPDATE spine_events SET source_kind …`
- **AND** startup SHALL complete without holding a transaction that blocks
  concurrent owner reads of `spine_events`

#### Scenario: Startup still applies bounded schema DDL

- **WHEN** the reference boots against a database whose `spine_events` table
  lacks the `source_kind`/`source_id` columns or the source index
- **THEN** startup SHALL add the columns and create the source index
  idempotently
- **AND** startup SHALL drop a superseded `provider_id` column if present,
  without scanning and rewriting the full table for value backfill

#### Scenario: Source backfill is explicit, bounded, and resumable

- **WHEN** an operator runs the spine-source backfill maintenance script
- **THEN** it SHALL default to dry-run, require direct database access
  (`PDPP_DATABASE_URL` or `PDPP_TEST_POSTGRES_URL`) as its authorization, and
  apply writes only with an explicit `--apply` flag
- **AND** it SHALL select only rows whose source columns are NULL, process them
  in bounded batches each in its own short transaction, be safe to re-run, and
  report the count of genuinely-sourceless rows it leaves unresolved rather than
  reprocessing them on every run

#### Scenario: Reads derive source for NULL legacy rows

- **WHEN** a `spine_events` row has NULL `source_kind`/`source_id` columns but a
  resolvable source in its `data_json` payload or runtime actor identity
- **THEN** a correlation summary read that does not filter on source SHALL still
  surface the correct source for that row
- **AND** any limitation of source-*filtered* reads over not-yet-backfilled
  legacy rows SHALL be a documented, operator-repairable condition rather than a
  behavior that startup silently changes

### Requirement: observation streams for sampled metrics

The reference implementation SHALL support an observation stream class for sampled metrics that change at polling frequency rather than at semantic event frequency.

#### Scenario: observation-stream record key is deterministic and date-scoped

**WHEN** a connector emits an observation record for entity `E` at time `T`,
**THEN** the record key SHALL be `{entity_id}:{YYYY-MM-DD}` (UTC date derived from `T`),
**AND** emitting again for the same entity on the same UTC calendar day SHALL produce the same key,
**AND** emitting on a different UTC calendar day SHALL produce a distinct key that does not overwrite the prior day's record.

#### Scenario: sampled metrics do not version entity records

**WHEN** sampled metric fields (e.g. `followers`, `num_members`) change between runs,
**THEN** the entity stream record SHALL NOT produce a new version,
**AND** the observation stream SHALL accumulate a new record for each distinct calendar day on which the metric value was observed.

#### Scenario: entity stream is fingerprinted after metric split

**WHEN** a connector separates sampled metrics from an entity stream,
**THEN** the entity stream SHALL use a per-record fingerprint gate,
**AND** the entity record SHALL only re-emit when at least one non-metric identity or structural field changes.

### Requirement: Family-2 observation streams for github/user and slack/channels

The connectors SHALL classify `github/user_stats` and `slack/channel_stats` as Family-2 append-keyed observation streams with date-scoped composite keys.

#### Scenario: github/user_stats accumulates a daily time series

**WHEN** the GitHub connector runs on consecutive days with different `followers` values,
**THEN** `user_stats` SHALL contain one record per day with key `{user_id}:{YYYY-MM-DD}`,
**AND** each record SHALL carry the `followers`, `following`, `public_repos`, and `public_gists` values observed on that day.

#### Scenario: slack/channel_stats accumulates a daily time series

**WHEN** the Slack connector runs on consecutive days with different `num_members` values,
**THEN** `channel_stats` SHALL contain one record per day with key `{channel_id}:{YYYY-MM-DD}`,
**AND** each record SHALL carry the `num_members` value observed on that day.

#### Scenario: same-day re-runs are idempotent for observation streams

**WHEN** the connector runs twice on the same UTC calendar day with identical metric values,
**THEN** both runs SHALL produce the same record key and the same record content,
**AND** no additional record version SHALL be created beyond what the runtime's byte-equivalence check produces.

### Requirement: Family-2 observation streams for usaa/accounts and usaa/credit_card_billing balances

The USAA connector SHALL classify `usaa/account_stats` and
`usaa/credit_card_billing_stats` as Family-2 append-keyed observation streams
with date-scoped composite keys, projecting the point-in-time balance metrics out
of the `usaa/accounts` and `usaa/credit_card_billing` entity streams. The entity
streams SHALL retain identity and settings fields only and SHALL each remain
gated by a per-record fingerprint so a balance-only change does not version the
entity record. Because both entity streams are full dashboard scans, their
fingerprint cursors SHALL continue to prune entities absent from the current
scan.

#### Scenario: account balances accumulate a daily time series

**WHEN** the USAA connector observes an account with balance values on a given UTC calendar day,
**THEN** `account_stats` SHALL contain a record with key `{account_id}:{YYYY-MM-DD}`,
**AND** the record SHALL carry the `balance_cents` and `available_balance_cents` values observed that day,
**AND** an observation on a later UTC day SHALL append a distinct record rather than overwrite the prior day's record.

#### Scenario: credit-card balances accumulate a daily time series

**WHEN** the USAA connector observes a credit card with billing values on a given UTC calendar day,
**THEN** `credit_card_billing_stats` SHALL contain a record with key `{card_id}:{YYYY-MM-DD}`,
**AND** the record SHALL carry the `current_balance_cents`, `available_credit_cents`, `cash_rewards_cents`, `billing_status`, and `minimum_payment_met` values observed that day.

#### Scenario: a balance-only change does not version the entity record

**WHEN** an account's or card's balance changes between runs but no identity or settings field changes,
**THEN** the corresponding entity stream SHALL NOT emit a new record version for that account or card,
**AND** the corresponding `_stats` stream SHALL record the new value for the observed calendar day.

#### Scenario: an identity or settings change versions the entity record once

**WHEN** an account's `name`/`status` or a card's `credit_limit_cents`, `annual_percent_rate`, `cash_advance_apr`, `account_nickname`, or `card_holders` changes,
**THEN** the corresponding entity stream SHALL emit exactly one new record version for that account or card.

#### Scenario: a disappeared entity is pruned on the full scan

**WHEN** a previously observed account or card is absent from the current dashboard scan,
**THEN** the entity fingerprint cursor SHALL prune that entity so a later re-appearance re-emits the entity record,
**AND** the entity's prior `_stats` records SHALL be retained as history and SHALL NOT be pruned.

#### Scenario: same-day re-runs are idempotent for the observation streams

**WHEN** the connector runs twice on the same UTC calendar day with identical balances for an account or card,
**THEN** both runs SHALL produce the same `_stats` record key and content,
**AND** no additional record version SHALL be created beyond what the runtime byte-equivalence check produces.

### Requirement: Family-2 observation stream for ynab/accounts balances

The YNAB connector SHALL classify `ynab/account_stats` as a Family-2
append-keyed observation stream with a date-scoped composite key, projecting the
point-in-time balance metrics out of the `ynab/accounts` entity stream. The
`accounts` entity stream SHALL retain identity and settings fields only and
SHALL be gated by a per-record fingerprint so a balance-only change does not
version the entity record. The split SHALL preserve YNAB `server_knowledge`
delta-sync.

#### Scenario: account balances accumulate a daily time series

**WHEN** the YNAB connector observes an account with balance values on a given UTC calendar day,
**THEN** `account_stats` SHALL contain a record with key `{account_id}:{YYYY-MM-DD}`,
**AND** the record SHALL carry the `balance`, `cleared_balance`, and `uncleared_balance` values observed that day,
**AND** an observation on a later UTC day SHALL append a distinct record rather than overwrite the prior day's record.

#### Scenario: a balance-only change does not version the entity record

**WHEN** an account's balance changes between runs but no identity or settings field changes,
**THEN** the `accounts` entity stream SHALL NOT emit a new record version for that account,
**AND** the `account_stats` stream SHALL record the new balance for the observed calendar day.

#### Scenario: an identity or settings change versions the entity record once

**WHEN** an account's `name`, `closed`, `note`, debt-detail, or other non-balance settings field changes,
**THEN** the `accounts` entity stream SHALL emit exactly one new record version for that account.

#### Scenario: delta-sync omission carries the account forward without pruning

**WHEN** a `server_knowledge` delta response omits a previously observed account because it did not change,
**THEN** the entity fingerprint cursor SHALL carry that account's fingerprint forward into the next STATE write,
**AND** the cursor SHALL NOT prune the omitted account,
**AND** an account returned with `deleted: true` SHALL re-emit the entity record as a normal field change.

#### Scenario: same-day re-runs are idempotent for the observation stream

**WHEN** the connector runs twice on the same UTC calendar day with identical balances for an account,
**THEN** both runs SHALL produce the same `account_stats` record key and content,
**AND** no additional record version SHALL be created beyond what the runtime byte-equivalence check produces.

### Requirement: Catalog completeness SHALL be independent of connection rows

Reference connector catalog completeness SHALL be satisfied by the registered `connectors` table (the catalog projection of listed first-party manifests) and the add-connection surface alone. The reference SHALL NOT require, and SHALL NOT create, a `connector_instances` row in order to make a listed first-party connector visible in the catalog. Catalog visibility (a connector the owner can add) and connection existence (a configured `connector_instance_id`) are distinct: a connector SHALL be able to appear in the catalog with zero connections. The owner connection projection (`GET /_ref/connectors`, `GET /_ref/connections`) lists configured connections; it SHALL NOT be the mechanism that guarantees catalog completeness, and it SHALL NOT synthesize a connection row to represent a catalog connector.

#### Scenario: Listed connector is catalog-visible with no connection row

- **WHEN** a first-party manifest declares `capabilities.public_listing.listed: true` and the owner has never configured a connection for it
- **THEN** the connector SHALL appear in the connector catalog (the registered `connectors` table projection and the add-connection surface)
- **AND** the reference SHALL NOT have created a `connector_instances` row to achieve that visibility
- **AND** the owner connection projection SHALL NOT list the connector as a connection.

#### Scenario: Catalog projection does not mutate durable connection state

- **WHEN** an owner-facing read enumerates the connector catalog
- **THEN** the read SHALL NOT create or upsert any `connector_instances` row
- **AND** the count of the owner's configured connections SHALL be unchanged by the read.

### Requirement: Expansion capabilities SHALL name the target stream and the child's parent-key field

The reference implementation SHALL include `target_stream` and `child_parent_key_field` on every entry returned in `expand_capabilities`.

- `target_stream` SHALL name the related **child** stream the forward relation points at. It SHALL equal the relation's declared related stream (the value already exposed today as `stream`).
- `child_parent_key_field` SHALL name the field **on the child (target) stream** whose value holds the **parent** record's key — that is, the field the reference filters on as `WHERE child.<field> = <parent record key>` when hydrating the relation. This field SHALL be the same field the manifest declares as the relation's `foreign_key`; the reference SHALL continue to emit `foreign_key` as a back-compat alias carrying the identical value.

`child_parent_key_field` SHALL NOT be described or used as the child's own record key. A child record's own identity is its primary key, which is unrelated to `child_parent_key_field` in the general case (for example, a GitHub `issues` record is keyed by `id`, while its `repository_id` holds the **parent repository's** key).

#### Scenario: Forward `has_many` relation names the child stream and the child's parent-key field

- **WHEN** an authorized client requests `GET /v1/streams/<parent>` for a parent stream whose manifest declares a `has_many` relation `<r>` pointing at child stream `<child>` with `foreign_key <fk>` (a field on `<child>` that carries the parent record's key)
- **THEN** the `expand_capabilities` entry for `<r>` SHALL include `target_stream: "<child>"`, `child_parent_key_field: "<fk>"`, `foreign_key: "<fk>"`, and `cardinality: "has_many"`

#### Scenario: Forward `has_one` relation names the child stream and the child's parent-key field

- **WHEN** an authorized client requests `GET /v1/streams/<parent>` for a parent stream whose manifest declares a `has_one` relation `<r>` pointing at child stream `<child>` with `foreign_key <fk>` on `<child>`
- **THEN** the `expand_capabilities` entry for `<r>` SHALL include `target_stream: "<child>"`, `child_parent_key_field: "<fk>"`, and `cardinality: "has_one"`

#### Scenario: Parent-key field identifies the parent, not the child record

- **WHEN** a parent record returned by `GET /v1/streams/<parent>/records/<parentKey>` is expanded for a `has_many` relation `<r>` whose entry declares `child_parent_key_field: "<fk>"`
- **THEN** every hydrated child record SHALL carry `<fk>` equal to `<parentKey>` (the parent's record key)
- **AND** each child record's own record key SHALL be the child stream's primary-key value, which the reference SHALL NOT derive from `<fk>`

#### Scenario: Reader navigates parent to a filtered child list using the child's parent-key field

- **WHEN** a reader (including the operator console) holds a parent record with key `<parentKey>` and an `expand_capabilities` entry for a `has_many` relation with `target_stream: "<child>"` and `child_parent_key_field: "<fk>"`
- **THEN** the reader SHALL be able to address the related children as the `<child>` record list filtered by `<fk>` equal to `<parentKey>` (for example `filter[<fk>]=<parentKey>`) without inspecting the parent stream's manifest separately
- **AND** the reader SHALL NOT treat `<parentKey>` as a `<child>` record key

### Requirement: Stream metadata SHALL surface declared but unreadable relations

The reference implementation SHALL emit one `expand_capabilities` entry for every relation a parent stream declares in `relationships[]` that is also enabled in `query.expand[]`, including relations whose target stream is outside the caller's grant, absent from the loaded manifest, or not loaded. Entries SHALL NOT be silently omitted. Unreadable entries SHALL carry `usable: false` and a `reason` value drawn from a defined enumeration: `related_stream_not_granted`, `related_stream_unknown`, `related_stream_not_loaded`.

The reason name `related_stream_not_granted` SHALL match the value the reference already emits today for a not-granted target stream; the additional enum members extend it additively for the unknown and not-loaded cases.

#### Scenario: Target stream is outside the grant

- **WHEN** the caller holds a grant that includes parent stream `<parent>` but not its declared related stream `<child>`
- **AND** the caller requests `GET /v1/streams/<parent>`
- **THEN** the response SHALL include an `expand_capabilities` entry for the relation pointing at `<child>` with `usable: false`
- **AND** the entry SHALL include `reason: "related_stream_not_granted"`

#### Scenario: Target stream is absent from the loaded manifest

- **WHEN** a parent manifest declares a relation `<r>` enabled for expansion pointing at stream `<child>` and `<child>` is not loaded as a stream by the reference at request time
- **AND** an authorized client requests `GET /v1/streams/<parent>`
- **THEN** the response SHALL include an `expand_capabilities` entry for `<r>` with `usable: false` and `reason: "related_stream_unknown"` or `reason: "related_stream_not_loaded"`

#### Scenario: Reader differentiates "no relation declared" from "relation unreachable"

- **WHEN** a reader compares two stream metadata responses for the same parent stream under two different grants
- **THEN** the absence of an `expand_capabilities` entry for relation `<r>` SHALL mean the manifest does not declare `<r>` as an enabled expansion
- **AND** the presence of an `expand_capabilities` entry for `<r>` with `usable: false` SHALL mean the manifest declares `<r>` but the current request cannot use it

### Requirement: Relationship navigation SHALL come only from manifest declarations

The reference implementation SHALL refuse to advertise, expand, or navigate any relationship not declared by the parent stream's manifest. The reference SHALL NOT infer relationships from payload field-name heuristics (for example treating any field ending in `_id` as a link), SHALL NOT auto-detect cross-stream foreign keys, and SHALL NOT silently extend relation graphs across connectors.

#### Scenario: Payload-only foreign-key value does not enable expansion

- **WHEN** a parent record carries a field whose name resembles a foreign key but the parent stream's manifest does not declare a relationship using that field
- **AND** a client requests `GET /v1/streams/<parent>/records?expand=<field>`
- **THEN** the reference SHALL reject the request with `invalid_expand`

#### Scenario: Cross-connector relationship is not auto-detected

- **WHEN** two connector manifests describe streams whose records share an identifier-shaped field
- **AND** neither manifest declares a relationship between the streams
- **THEN** the reference SHALL NOT advertise an `expand_capabilities` entry that crosses connector boundaries
- **AND** any `expand[]` request that would cross connector boundaries SHALL fail with `invalid_expand`

### Requirement: GitHub first-party stream manifest SHALL declare the user-to-user_stats relationship

The reference's first-party GitHub connector manifest SHALL declare a safe parent-to-child relationship from `user` to `user_stats`. The relationship SHALL be present in both `relationships[]` and `query.expand[]` on the `user` stream, SHALL use `user_id` (a top-level, required property of the `user_stats` child schema that carries the parent user's record key) as its `foreign_key`, SHALL declare `cardinality: "has_many"`, and SHALL declare positive `default_limit` and `max_limit` values with `default_limit <= max_limit`.

The `repositories -> issues` and `repositories -> pull_requests` relationships are intentionally **not** declared in this change. Although `issues` and `pull_requests` records carry a `repository_id` value, that field is nullable and not a required property on those child schemas, so it cannot satisfy the existing manifest-validation rule that a relation's `foreign_key` be a required top-level property of the child stream (which exists to avoid silently dropping children whose key is absent). Enabling those joins requires a separate change that first makes the child parent-key field required (or relaxes that rule with an explicit absent-key policy); doing so is out of scope here.

#### Scenario: User declares a `has_many` relation to user_stats

- **WHEN** the GitHub manifest is loaded and validated
- **THEN** the `user` stream SHALL declare a `has_many` relationship to `user_stats` with `foreign_key: "user_id"`
- **AND** the `user` stream SHALL declare a matching `query.expand[]` entry for that relation with positive `default_limit` and `max_limit` where `default_limit <= max_limit`

#### Scenario: user_stats parent-key field is required on the child

- **WHEN** the GitHub manifest is loaded and validated
- **THEN** the `user_stats` child schema SHALL list `user_id` as a top-level required property
- **AND** manifest validation of the `user -> user_stats` expansion SHALL pass under the existing rule that a relation's `foreign_key` be a required top-level child property

#### Scenario: Repository-to-issue expansion is not declared in this change

- **WHEN** the GitHub manifest is loaded and validated
- **THEN** the `repositories` stream SHALL NOT declare an enabled `query.expand[]` entry pointing at `issues` or `pull_requests`
- **AND** a request for `GET /v1/streams/repositories/records?expand=issues` SHALL fail with `invalid_expand`

#### Scenario: Commits stream remains undeclared

- **WHEN** the GitHub manifest is loaded and validated
- **THEN** the manifest SHALL NOT declare any relationship whose related stream is `commits`
- **AND** no `expand_capabilities` entry SHALL name `commits` as a related stream for any GitHub stream

#### Scenario: Reverse expansion remains undeclared on first-party GitHub streams

- **WHEN** the GitHub manifest is loaded and validated
- **THEN** the manifest SHALL NOT declare a `query.expand[]` entry that points from `user_stats` to `user`, from `issues` to `repositories`, or from `pull_requests` to `repositories`
- **AND** a request for `GET /v1/streams/user_stats/records?expand=user` SHALL fail with `invalid_expand`

### Requirement: Operator console SHALL render manifest-declared relationships on the record detail page

The reference operator console SHALL render a navigable "Related" section on the record detail page (`/dashboard/records/<connection>/<stream>/<recordKey>`). The section SHALL be populated from `expand_capabilities` returned by `GET /v1/streams/<stream>`. The console SHALL NOT infer relationships from the record payload alone.

For a `has_many` relation, the navigation target SHALL be the related child stream's record-list page filtered by the relation's `child_parent_key_field` equal to the displayed parent record's key (the related children, not a single child detail page). The console SHALL NOT construct a child record-detail URL from the parent's record key.

#### Scenario: Usable `has_many` relation renders as a link to the filtered child list

- **WHEN** the stream metadata for the displayed parent stream includes an `expand_capabilities` entry with `cardinality: "has_many"`, `usable: true`, `target_stream: "<child>"`, and `child_parent_key_field: "<fk>"`, and the displayed parent record has key `<parentKey>`
- **THEN** the console SHALL render a navigable element pointing at the `<child>` record-list location filtered by `<fk>` equal to `<parentKey>` under `/dashboard/records/<connection>/<child>`
- **AND** the console SHALL NOT render a link of the form `/dashboard/records/<connection>/<child>/<parentKey>` (the parent key is not a child record key)

#### Scenario: Usable `has_one` relation renders as a link to the child detail page

- **WHEN** the stream metadata for the displayed parent stream includes an `expand_capabilities` entry with `cardinality: "has_one"`, `usable: true`, and `target_stream: "<child>"`, and the displayed parent record carries the child record key that the relation resolves to
- **THEN** the console SHALL render a navigable element pointing at the corresponding `<child>` record detail page under `/dashboard/records/<connection>/<child>/...`

#### Scenario: Unreadable relation renders as an inert advisory

- **WHEN** the stream metadata for the displayed stream includes an `expand_capabilities` entry with `usable: false`
- **THEN** the console SHALL render the relation as inert (non-link) text
- **AND** the console SHALL surface the manifest-supplied `reason` value as advisory copy
- **AND** the console SHALL NOT raise an error toast or block the page on the unreadable relation

#### Scenario: Console does not invent links

- **WHEN** the record payload contains a field whose name resembles a foreign key but the stream metadata does not advertise an `expand_capabilities` entry covering that relation
- **THEN** the console SHALL render the field as plain text
- **AND** the console SHALL NOT construct a record-detail URL from that field

### Requirement: Operator console SHALL render manifest-declared parent links on the child record page

The reference operator console SHALL render a field on a child record (on the record list page `/dashboard/records/<connection>/<stream>` and on the record detail page) that holds a parent record's key as a navigable link to the **parent** record's detail page. The console SHALL discover these renderings from manifest declarations only — never from raw payload field-name inspection — and SHALL accept either of two manifest sources:

- a forward relation advertised in `expand_capabilities` returned by the relevant parent stream's metadata, whose `child_parent_key_field` names the field on the displayed child record that carries the parent's key; or
- a `has_one` relationship declared on the displayed child stream's **own** manifest entry, whose `foreign_key` names that field.

Both sources are manifest declarations and resolve to the same parent: the link target SHALL be the parent record keyed by the value the child record carries in the relation's parent-key field (`child_parent_key_field` for the `expand_capabilities` source, `foreign_key` for the child-declared source), because that field holds the parent record's key. The two sources are complementary, not exclusive: a child stream whose parent declares no `query.expand[]` (so the parent emits no `expand_capabilities`) still renders a parent link from its own declared `has_one` — this is the path that serves the belongs-to edges (Chase, USAA, YNAB, and the other child-declared relationships) the forward `expand_capabilities` path cannot.

The console SHALL apply the following constraints to the child-declared source:

- Only `has_one` relationships declared on the child stream, with a non-empty related `stream` and a non-empty `foreign_key`, produce a link. A child-declared `has_many` relationship SHALL NOT produce a child-to-parent link by this rule.
- A link is rendered only when the child record carries a non-empty string value at the declared parent-key field; an absent, empty, or non-string value yields no link.
- A field not covered by a declared relation (from either source) SHALL render as plain text; the console SHALL NOT construct a record-detail URL from an undeclared field.
- The console SHALL deduplicate child-to-parent back-links by the pair `(parent stream, parent-key field)` — the parent stream together with the relation's parent-key field (`child_parent_key_field` for the `expand_capabilities` source, `foreign_key` for the child-declared source) — NOT by parent stream alone. When a child-declared `has_one` link and a parent-`expand_capabilities`-derived link describe the **same** edge (same parent stream and same parent-key field), the console SHALL render a single link for that edge (deduplicated), preferring the `expand_capabilities`-derived link. When a child stream declares **two or more distinct** relations to the same parent stream via **different** parent-key fields (for example a transaction's `account_id` and `transfer_account_id`, both targeting `accounts`), each such relation carries a different parent-key value and resolves to a different parent record, so the console SHALL render a distinct link for each and SHALL NOT collapse them to one.

This is a console-only affordance. It SHALL NOT enable server-side reverse expansion, and the console SHALL NOT issue any `expand[]` request to obtain the values needed to draw the link.

#### Scenario: Child parent-key field links to the declared parent record via parent `expand_capabilities`

- **WHEN** a parent stream's metadata advertises a declared forward relation to the displayed child stream `<child>` with `target_stream: "<child>"` and `child_parent_key_field: "<fk>"`
- **AND** the displayed `<child>` record carries a value `<parentKey>` in field `<fk>`
- **THEN** the console SHALL render that value as a link to `/dashboard/records/<connection>/<parent_stream>/<parentKey>`

#### Scenario: Chase transaction links to its declared account via the child's own `has_one`

- **WHEN** the operator views a Chase `transactions` record detail page whose stream manifest declares a `has_one` relationship `{ stream: "accounts", cardinality: "has_one", foreign_key: "account_id" }`
- **AND** the `accounts` parent stream declares no `query.expand[]` (so the parent emits no `expand_capabilities` for this relation)
- **AND** the displayed record carries a non-empty string value `<accountKey>` in field `account_id`
- **THEN** the console SHALL render a navigable link to the related account record's detail page `/dashboard/records/<connection>/accounts/<accountKey>`

#### Scenario: Child-declared `has_one` resolves the parent key from the foreign-key field

- **WHEN** a displayed child stream declares a `has_one` relationship to parent stream `<parent>` with `foreign_key <fk>`
- **AND** the displayed child record carries a non-empty string value `<parentKey>` in field `<fk>`
- **THEN** the console SHALL render a link to `/dashboard/records/<connection>/<parent>/<parentKey>`
- **AND** the console SHALL percent-encode the connection, parent stream, and key segments of that link

#### Scenario: Child-declared `has_many` does not produce a back-link by this rule

- **WHEN** a displayed child stream declares a `has_many` relationship in its own `relationships[]`
- **THEN** the console SHALL NOT render a child-to-parent link from that `has_many` declaration
- **AND** child-to-parent navigation from the child-declared source SHALL be limited to `has_one` declarations

#### Scenario: Two distinct relations to the same parent stream via different fields both render

- **WHEN** a displayed child stream declares two `has_one` relationships to the same parent stream `<parent>` via different fields `<fkA>` and `<fkB>` (for example a YNAB `transactions` record declaring `has_one(account_id) -> accounts` and `has_one(transfer_account_id) -> accounts`)
- **AND** the displayed child record carries non-empty string values `<parentKeyA>` in `<fkA>` and `<parentKeyB>` in `<fkB>`
- **THEN** the console SHALL render two distinct links, one to `/dashboard/records/<connection>/<parent>/<parentKeyA>` and one to `/dashboard/records/<connection>/<parent>/<parentKeyB>`
- **AND** the console SHALL NOT collapse them to a single link merely because they target the same parent stream

#### Scenario: The same edge discovered via both sources collapses to one link

- **WHEN** the displayed child stream's parent advertises a usable `expand_capabilities` entry resolving to parent stream `<parent>` with `child_parent_key_field: "<fk>"`
- **AND** the displayed child stream also declares a `has_one` to `<parent>` with `foreign_key: "<fk>"` (the same parent-key field)
- **AND** the displayed child record carries a non-empty string value `<parentKey>` in field `<fk>`
- **THEN** the console SHALL render a single link to `/dashboard/records/<connection>/<parent>/<parentKey>` for that edge, preferring the `expand_capabilities`-derived link, not two

#### Scenario: Undeclared foreign-key-shaped field renders as plain text

- **WHEN** a displayed child record carries a field whose name resembles a foreign key but neither the parent's `expand_capabilities` nor the child stream's own manifest declares a relation using that field
- **THEN** the console SHALL render the field as plain text
- **AND** the console SHALL NOT construct a record-detail URL from that field

#### Scenario: Missing or empty foreign-key value yields no link

- **WHEN** a displayed child stream declares a `has_one` relationship with `foreign_key <fk>`
- **AND** the displayed child record's `<fk>` value is absent, empty, or not a string
- **THEN** the console SHALL NOT render a child-to-parent link for that relationship

#### Scenario: Symmetric link does not imply server-side reverse expansion

- **WHEN** the console renders a child-to-parent link as defined above (from either manifest source)
- **AND** a client issues `GET /v1/streams/<child>/records?expand=<parent_relation>` against the same parent
- **THEN** the reference server SHALL reject the request with `invalid_expand` unless a separate accepted change defines reverse expansion semantics

#### Scenario: Console does not issue `expand[]` to draw parent links

- **WHEN** the console renders the child record list or detail page and draws child-to-parent links
- **THEN** the console SHALL NOT include any `expand[]` parameter in the underlying `GET /v1/streams/<child>/records` request solely to obtain the values needed to draw the parent links
- **AND** the parent-key values used to draw links SHALL come from the child record's own parent-key field value already present in each record's payload

### Requirement: Operator console SHALL render a reverse parent-to-filtered-child-list link from a child-declared `has_one`

The reference operator console SHALL render, on a **parent** record's detail page
(`/dashboard/records/<connection>/<parent>/<parentKey>`) **and per parent row on the
parent record list page** (`/dashboard/records/<connection>/<parent>`), a navigable
link to the **filtered child list** for each child stream whose **own** manifest
entry declares a `has_one` relationship targeting the displayed parent stream. The
relationship structure SHALL be taken from the child stream's declared
`relationships[]` (a manifest declaration); the link target SHALL be the child
stream's record-**list** page filtered by the relationship's `foreign_key` equal to
the parent record's key — addressable as
`/dashboard/records/<connection>/<child>?filter[<fk>]=<parentKey>` — because the
child's `foreign_key` value holds the parent record's key. On the detail page the
parent key is the displayed record's key; on the list page the parent key is each
displayed parent **row's** own record key.

This is the reverse-direction counterpart to the child-to-parent back-links the
console renders from the same child-declared `has_one` relationship, and it SHALL be
rendered on the same two surfaces (detail page and list page) on which those
child-to-parent back-links are rendered, so reverse navigation is symmetric with the
forward child-to-parent navigation across both surfaces. It complements, and does not
replace, the forward parent-to-child links sourced from a parent stream's
`expand_capabilities` `has_many` entries. Both the forward `has_many` path and this
reverse path resolve to the same bounded, filterable child-list location for a given
`(child stream, foreign-key field, parent key)`.

The console SHALL apply the following constraints:

- Only `has_one` relationships declared on a child stream, whose related `stream`
  equals the displayed parent stream and which declare a non-empty `foreign_key`,
  produce a reverse link.
- The link target SHALL be the child record-**list** page filtered by
  `filter[<fk>]=<parentKey>`. The console SHALL NOT construct a child
  record-**detail** URL of the form `/dashboard/records/<connection>/<child>/<parentKey>`
  (the parent key is not a child record key).
- Neither the parent detail page nor the parent list page SHALL load the child
  collection inline to render the link; each SHALL emit the filtered-list href only.
  The children are fetched only when the operator follows the link, by the existing
  paginated, server-filtered list page.
- The set of child streams that declare a `has_one` targeting the displayed parent
  stream SHALL be derived from the connector manifest the page already loads. On the
  list page the console SHALL NOT issue an additional per-row request and SHALL NOT
  scan or load child records to render the per-row links; each row's links SHALL be
  derived by substituting that row's own record key as the filter value into the
  page-level set of reverse child edges.
- A child-declared `has_many` relationship SHALL NOT produce a reverse link by this
  rule.
- A parent field whose name resembles a foreign key, where no child stream declares
  a `has_one` targeting the displayed parent using that field, SHALL NOT produce a
  link; the console SHALL NOT infer reverse links from raw payload field-name
  heuristics.
- The console SHALL resolve the connector manifest used to enumerate child streams
  through the dual-namespace resolver that matches both the URL-form `connector_id`
  and the short `connector_key`, so reverse links resolve for live connections.
- When a forward `has_many` `expand_capabilities` entry and a child-declared
  `has_one` resolve to the same `(child stream, foreign-key field, parent key)`
  filtered list, the console SHALL render a single link for that child stream
  (deduplicated), not two.

This is a console-only affordance. It SHALL NOT enable server-side reverse
expansion, and the console SHALL NOT issue an `expand[]` request to obtain the values
needed to draw the link. The reverse link reuses the existing
`filter[<field>]=<value>` list query and introduces no new query parameter,
endpoint, manifest field, or `expand_capabilities` entry.

#### Scenario: Chase account links to its filtered transactions list

- **WHEN** the operator views a Chase `accounts` record detail page with key `<accountKey>`
- **AND** the connector's `transactions` stream manifest declares a `has_one` relationship `{ stream: "accounts", cardinality: "has_one", foreign_key: "account_id" }`
- **THEN** the console SHALL render a navigable link to the transactions list filtered by that account, addressable as `/dashboard/records/<connection>/transactions?filter[account_id]=<accountKey>`
- **AND** the console SHALL NOT render a link of the form `/dashboard/records/<connection>/transactions/<accountKey>`

#### Scenario: Chase accounts list renders a per-row transactions link

- **WHEN** the operator views the Chase `accounts` record **list** page, each row being one `accounts` record with key `<accountKey>`
- **AND** the connector's `transactions` stream manifest declares a `has_one` relationship `{ stream: "accounts", cardinality: "has_one", foreign_key: "account_id" }`
- **THEN** the console SHALL render, on each `accounts` row, a navigable link to the transactions list filtered by that row's account, addressable as `/dashboard/records/<connection>/transactions?filter[account_id]=<accountKey>`
- **AND** two distinct rows with keys `<accountKeyA>` and `<accountKeyB>` SHALL produce links whose filter values are `<accountKeyA>` and `<accountKeyB>` respectively
- **AND** the list page SHALL NOT fetch or load any `transactions` records to render those per-row links

#### Scenario: Reverse link targets the filtered child list, not an inline collection

- **WHEN** a displayed parent stream `<parent>` has a child stream `<child>` that declares a `has_one` to `<parent>` with `foreign_key <fk>`, and the displayed parent record (or parent row) has key `<parentKey>`
- **THEN** the console SHALL render a single navigable element pointing at `/dashboard/records/<connection>/<child>` filtered by `<fk>` equal to `<parentKey>` (for example `filter[<fk>]=<parentKey>`)
- **AND** the parent detail page and the parent list page SHALL NOT fetch or render the `<child>` records inline to produce that element
- **AND** the console SHALL percent-encode the connection, child stream, and filter-value segments of the link

#### Scenario: List page with no child-declared reverse edges renders no per-row reverse links

- **WHEN** the operator views a record list page for a stream that no child stream in the connector manifest declares a `has_one` against
- **THEN** the console SHALL render no per-row reverse links on that list page
- **AND** the console SHALL NOT perform any per-row child-stream lookup for that page

#### Scenario: Child-declared `has_many` does not produce a reverse link by this rule

- **WHEN** a child stream declares a `has_many` relationship in its own `relationships[]` targeting the displayed parent stream
- **THEN** the console SHALL NOT render a reverse parent-to-child link from that `has_many` declaration on either the detail page or the list page
- **AND** reverse parent-to-filtered-child-list navigation SHALL be limited to child-declared `has_one` relationships under this requirement

#### Scenario: Undeclared parent field produces no reverse link

- **WHEN** a displayed parent record (or parent row) carries a field whose name resembles a foreign key but no child stream in the connector manifest declares a `has_one` targeting the displayed parent stream using that field
- **THEN** the console SHALL render no reverse link for that field
- **AND** the console SHALL NOT construct a filtered-list URL from raw payload field-name heuristics

#### Scenario: Reverse link deduplicates against a forward `has_many` capability

- **WHEN** the displayed parent stream's metadata advertises a usable `has_many` `expand_capabilities` entry with `target_stream: "<child>"` and `child_parent_key_field: "<fk>"`
- **AND** the `<child>` stream also declares a `has_one` to the displayed parent with `foreign_key: "<fk>"`
- **THEN** the console SHALL render a single filtered-child-list link for `<child>` keyed by `filter[<fk>]=<parentKey>`, not two

#### Scenario: Reverse parent-to-child link does not imply server-side reverse expansion

- **WHEN** the console renders a reverse parent-to-filtered-child-list link sourced from a child-declared `has_one` relationship on either the detail page or the list page
- **AND** a client issues `GET /v1/streams/<child>/records?expand=<reverse_relation>` to obtain the children as a server-side expansion of the parent
- **THEN** the reference server SHALL reject the request with `invalid_expand` unless a separate accepted change defines reverse expansion semantics
- **AND** the console SHALL NOT have issued any `expand[]` request to draw the link

### Requirement: Statement connectors SHALL carry forward prior hydrated PDF pointers on a hydration failure

The reference statement connectors (`chase/statements` and `usaa/statements`) emit one `statements` record per index row, with content-addressed hydrated pointers (`document_url`, `pdf_path`, `pdf_sha256`, whose path embeds the sha256) populated on a successful PDF download and absent otherwise. When a run fails to hydrate a statement's PDF, the connector SHALL distinguish two cases by the statement's prior STATE cursor, keyed by the immutable statement `id`:

- **Previously hydrated.** If the prior cursor shows the statement was hydrated on an earlier run, the connector SHALL re-emit the prior `document_url`/`pdf_path`/`pdf_sha256` (carry-forward) rather than emitting them as null. Because the pointers are content-addressed, the carried-forward body asserts the artifact's last known content-addressed location — which remains valid (the bytes never move) — and SHALL NOT assert that this run re-verified the artifact.
- **Never hydrated.** If the prior cursor has no hydrated pointers for the statement, the connector SHALL emit the index-only body with all three pointer fields null, exactly as today, so the client still learns the statement exists.

In both cases the connector SHALL still emit a per-run `SKIP_RESULT` (reason `pdf_download_failed`, or the connector's failed-hydration reason) recording that this run did not download the PDF. The `SKIP_RESULT` remains the authoritative run-level record that this run did not re-fetch the bytes; the carried-forward record body is not a claim of fresh verification. This mirrors the first-party blob-hydration honesty rule that a connector "SHALL NOT fabricate a `blob_ref` for bytes it did not store" — carry-forward of a content-addressed pointer to bytes a prior run did store is permitted; fabricating a pointer to bytes no prior run stored is not.

A first hydration (`null -> value`: a statement that was index-only and is hydrated on a later run) SHALL remain a real version boundary and SHALL version exactly once. A genuine change to a statement's immutable identity fields SHALL still re-version. Carry-forward SHALL key on statement `id` and SHALL NOT mask a real change.

The carry-forward source SHALL be the connectors' existing per-statement STATE cursor, extended to retain the prior hydrated pointers keyed by statement `id`, realized through the shared per-record fingerprint cursor's derived-field-preservation surface. This SHALL NOT add a new stream, a new manifest field, or any change to the public RECORD or STATE wire shape; the retained pointer map lives inside the connector's opaque STATE cursor. Legacy cursors that retained only a change-detection hash (or no map) SHALL decode tolerantly to an empty prior-pointer map, so the first post-deploy run re-emits each statement at most once and rebuilds the map.

This requirement supersedes the connectors' prior contract that a failed hydration always emitted an all-null index-only body; the all-null body is retained only for the never-hydrated case.

#### Scenario: A previously hydrated statement that fails re-hydration carries its pointers forward

- **WHEN** run A hydrates statement `id` (body carries `pdf_path`/`pdf_sha256`/`document_url`) and a later run B fails to download the same statement's PDF
- **THEN** run B SHALL re-emit the prior `pdf_path`/`pdf_sha256`/`document_url` for `id` rather than null
- **AND** the carried-forward body SHALL be byte-identical modulo the run-clock `fetched_at`, so the per-statement fingerprint gate emits NO new version for `id`
- **AND** run B SHALL still emit a `pdf_download_failed` `SKIP_RESULT` for the statement

#### Scenario: A never-hydrated statement that fails hydration stays index-only

- **WHEN** a run fails to download the PDF for a statement `id` that the prior cursor never hydrated
- **THEN** the connector SHALL emit an index-only body with `pdf_path`, `pdf_sha256`, and `document_url` all null
- **AND** the statement's identity fields (`id`, `account_id`, `title`, `date_delivered`) SHALL survive on the index-only record

#### Scenario: First hydration still versions exactly once

- **WHEN** run A emits a statement index-only (never hydrated) and run B successfully hydrates the same `id`
- **THEN** run B SHALL emit exactly one new version carrying the populated `pdf_path`/`pdf_sha256`/`document_url`
- **AND** the `null -> value` first hydration SHALL NOT be suppressed by carry-forward

#### Scenario: Flap-back across three runs yields one version, not three

- **WHEN** run A hydrates statement `id`, run B fails (carry-forward), and run C re-downloads the identical PDF
- **THEN** the statement `id` SHALL have exactly one retained version across the three runs, not three
- **AND** each failed run SHALL still record its own `SKIP_RESULT`

#### Scenario: A genuine identity change still re-versions under carry-forward

- **WHEN** a statement's immutable identity (for example its `title`) changes between runs
- **THEN** the connector SHALL emit a new version for that statement regardless of carry-forward
- **AND** carry-forward SHALL NOT mask the identity change as a no-op

#### Scenario: Carry-forward needs no compaction-policy change

- **WHEN** the `chase/statements` and `usaa/statements` carry-forward gates are in force
- **THEN** the registered `fetched_at`-only compaction policies for those streams SHALL be unchanged
- **AND** the historical-compaction tool SHALL still never collapse a real `null -> value` first hydration into the prior index-only version

### Requirement: Run timeline envelope SHALL expose a window-independent terminal status

The reference run-timeline endpoint `GET /_ref/runs/{run_id}/timeline` SHALL include a `terminal_status` field in its response envelope. The value SHALL be one of `completed`, `failed`, `cancelled`, or `abandoned` when the run has recorded a terminal spine event (`run.completed`, `run.failed`, `run.cancelled`, `run.abandoned` respectively), and `null` when the run has no terminal event. The value SHALL be derived from the run's most-recent terminal spine event and SHALL NOT depend on the `limit` or `cursor` of the request — a consumer reading any single page SHALL receive the same `terminal_status`.

The terminal-status lookup SHALL NOT require scanning the run's full event list; it SHALL use the bounded most-recent-terminal-event query. The field applies to the run timeline kind; trace and grant timelines are unaffected.

#### Scenario: Long run reports terminal status on the first page

- **WHEN** a run has more events than the requested `limit` and its terminal event is beyond the first page
- **THEN** the first-page timeline response SHALL include `terminal_status` set to the run's terminal class
- **AND** the value SHALL be identical for any page or `limit` of the same run

#### Scenario: In-progress run reports null terminal status

- **WHEN** a run has no terminal spine event
- **THEN** the timeline response SHALL include `terminal_status: null`

#### Scenario: Consumer determines liveness without paging to the tail

- **WHEN** a consumer needs to know whether a run is still active
- **THEN** it SHALL be able to read `terminal_status` from a single timeline page response
- **AND** it SHALL NOT need to page through the timeline to find the terminal event

### Requirement: Run detail surface SHALL determine liveness from the envelope terminal status

The operator console run detail surface SHALL determine whether a run is active from the timeline envelope's `terminal_status` field, not from scanning a single page of events. The active/terminal decision that drives the run status badge, the live-update poller's enabled state, and the active-run cancel control SHALL be `terminal_status == null`.

#### Scenario: Terminal run past the first page renders as terminal

- **WHEN** the run detail page renders a run whose `terminal_status` is non-null but whose terminal event is not within the fetched event page
- **THEN** the page SHALL show the terminal status badge for that run
- **AND** SHALL NOT render the active-run cancel control
- **AND** SHALL NOT keep the live poller enabled

### Requirement: Stream reach give-up records a typed failure class

The reference implementation SHALL classify a stream-reach give-up into a typed
reason rather than reporting only a generic network failure when the stream
viewer's pre-attach retry loop gives up reaching a run-interaction browser
stream. Because the browser `EventSource` collapses every pre-attach HTTP status
into a payload-less error, the reference SHALL read the actual attach status with
a single token-scoped status probe before classifying. The typed reason SHALL be
drawn from a closed set and SHALL NOT include connector secrets, the stream
token, the stream proxy cookie, or raw viewer URLs.

#### Scenario: The attach loop gives up against a dead token

- **WHEN** the stream viewer exhausts its pre-attach reconnect attempts without a
  successful attach
- **THEN** the reference SHALL issue one token-scoped `GET` status probe against
  the same viewer URL to read the attach HTTP status the `EventSource` hid
- **AND** it SHALL classify the give-up as one of `invalid_token`,
  `session_consumed`, `session_expired`, `companion_unavailable`,
  `unreachable_origin`, or `unknown`
- **AND** it SHALL show the operator a message naming that failure class
- **AND** it SHALL NOT claim the stream connected or recovered

#### Scenario: The status probe cannot classify the failure

- **WHEN** the give-up status probe returns a status outside the recognized set,
  or the probe request itself fails before any HTTP status is read
- **THEN** the reference SHALL classify the give-up as `unreachable_origin` when
  the probe request failed to reach the server, otherwise `unknown`
- **AND** the operator message for `unknown` SHALL be no less informative than the
  prior generic give-up message
- **AND** the classification SHALL NOT fabricate a more specific reason than the
  probe evidence supports

#### Scenario: The status probe does not consume a still-valid session

- **WHEN** the give-up status probe runs against a stream token
- **THEN** the probe SHALL only read the attach response status and SHALL release
  the probe connection without invalidating the streaming session
- **AND** the probe SHALL NOT mint, supersede, or alter the streaming session
  beyond the reconnect-safe attach the viewer already performs

### Requirement: Stream reach failures are recorded on the run spine

The reference implementation SHALL record a stream-reach give-up as a bounded
`run.stream_reach_failed` spine event so the failure class is auditable from the
run timeline. The event SHALL be emitted through an owner-authenticated reference
route, scoped to the current run and interaction, and SHALL carry only the typed
reason and the observed HTTP status. The route SHALL clamp the reported reason to
the recognized closed set so a malformed or hostile client cannot write an
arbitrary reason into the spine.

#### Scenario: A classified give-up is reported

- **WHEN** the stream viewer classifies a give-up into a typed reason
- **THEN** the reference SHALL accept an owner-authenticated give-up beacon for the
  current run and interaction
- **AND** it SHALL emit `run.stream_reach_failed` carrying the typed reason and the
  observed HTTP status
- **AND** the event data SHALL NOT contain the stream token, stream proxy cookie,
  or raw viewer URL

#### Scenario: A give-up beacon reports an unrecognized reason

- **WHEN** a give-up beacon reports a reason outside the recognized closed set
- **THEN** the reference SHALL record the reason as `unknown` rather than the
  client-supplied string
- **AND** it SHALL still emit `run.stream_reach_failed` so the give-up remains
  auditable

#### Scenario: A give-up beacon targets a run or interaction that is not current

- **WHEN** a give-up beacon names a run or interaction that does not match a known
  run-interaction pairing
- **THEN** the reference SHALL reject the beacon
- **AND** it SHALL NOT emit a `run.stream_reach_failed` event for the mismatched
  identifiers

### Requirement: The reference SHALL expose an owner/operator-only all-stream current-projection drift scanner

The reference implementation SHALL provide an owner/operator-only, read-only operational tool that audits the current `records` projection against the authoritative `record_changes` history across every `(connector_instance_id, stream)` in the Postgres store in a single scan, optionally filtered to one `connector_id`. The tool is reference-implementation maintenance, not protocol behavior. It SHALL NOT affect PDPP Core semantics, public record reads, public `changes_since` responses, or grant enforcement.

The tool SHALL be authorized by direct database access (`PDPP_DATABASE_URL`, with `PDPP_TEST_POSTGRES_URL` accepted as a fallback). It SHALL NOT be exposed via an HTTP route, a scheduler, or any automatic background job. It SHALL NOT mutate, insert, or delete any row. It SHALL NOT print raw record payloads, personal text, secrets, cookies, or tokens; every preview SHALL carry only versions, deleted flags, byte counts, payload-equality booleans, and truncated identifiers, with the payload comparison (`record_json IS NOT DISTINCT FROM`) computed in SQL.

The tool SHALL classify each drifting `(connector_instance_id, stream, record_key)` into exactly one of the following classes and SHALL report a remediation disposition per class:

- `missing_current` — latest retained history is non-deleted, but no usable current row exists. Disposition: repairable from latest retained history.
- `stale_current` — a live current row is behind the latest non-deleted retained history (same-version payload disagreement, or an older live current version). Disposition: repairable from latest retained history.
- `latest_deleted` — the latest retained history row is a tombstone, but a non-deleted current row survives. Disposition: owner-gated delete reconciliation.
- `current_payload_matches_latest_history_but_version_differs` — a live current row whose version differs from the latest retained history version, but whose payload is byte-equal to that latest history row. Disposition: safe current-version correction (no source resync).
- `unverified_current_payload_differs_from_latest_history` — a live current row whose version differs from the latest retained history version and whose payload differs from it. Disposition: source resync required.
- `current_version_newer_than_retained_history` — the current row's version is strictly greater than every retained history row for the key. Disposition: source resync or owner-gated synthetic maintenance anchor.
- `current_no_retained_history` — the current row's key has no retained `record_changes` at all. Disposition: source resync or owner-gated synthetic maintenance anchor.

The tool SHALL exit non-zero when any drift is found and zero when the projection is consistent, so an operator or CI can branch on "needs remediation". The tool SHALL NOT write a synthetic `record_changes` anchor; synthetic maintenance anchoring is owner-gated and out of scope for this read-only tool.

#### Scenario: Clean projection reports no drift

- **WHEN** the operator runs the scanner against a store whose current projection agrees with retained history everywhere in scope
- **THEN** the scanner SHALL report zero drift across all classes
- **AND** it SHALL exit zero
- **AND** it SHALL NOT mutate any row

#### Scenario: Mixed drift is classified by remediation disposition

- **WHEN** the operator runs the scanner against a store containing rows of several drift classes
- **THEN** the scanner SHALL report each class's count and one payload-free preview per drifting key with its remediation disposition
- **AND** it SHALL distinguish a version-only disagreement whose payload byte-equals the latest retained history (safe version correction) from one whose payload differs (source resync)
- **AND** it SHALL exit non-zero

#### Scenario: Scanner never emits payloads

- **WHEN** the scanner reports drift previews in either human or JSON form
- **THEN** the output SHALL contain only versions, deleted flags, byte counts, payload-equality booleans, and truncated identifiers
- **AND** it SHALL NOT contain any `record_json` payload, personal text, secret, cookie, or token

### Requirement: Scheduler SHALL apply a cross-run cooldown for pending source-pressure gaps

When a connection still has pending retryable detail gaps caused by upstream/source pressure (for example a gap with reason `upstream_pressure` or `rate_limited`), the reference scheduler SHALL NOT treat the connection as immediately due on its normal interval merely because the prior run terminated `succeeded`. The scheduler SHALL defer the next automatic dispatch by a cooldown derived from the pending source-pressure gaps. This cooldown is independent of, and additional to, the scheduler's failure-class back-off; whichever defers the next attempt further SHALL govern eligibility.

#### Scenario: Scheduled run succeeded but deferred work under source pressure

- **WHEN** a scheduled connection's most recent run terminated `succeeded` but left one or more pending detail gaps whose reason is source pressure
- **THEN** the scheduler SHALL consider the connection cooling off rather than immediately due on the base interval
- **AND** the scheduler SHALL NOT launch another automatic run for that connection until the cooldown window has elapsed

#### Scenario: Manual run-now during cooldown

- **WHEN** an owner triggers a manual run for a connection that is in source-pressure cooldown
- **THEN** the cooldown SHALL NOT block the manual run

### Requirement: Source-pressure cooldown SHALL decay and SHALL relax on recovery

The source-pressure cooldown SHALL grow as pressure persists across runs and SHALL be bounded by a configured upper cap. The cooldown SHALL relax once the pending source-pressure gaps are recovered, so a connection is never held in cooldown indefinitely after pressure clears.

#### Scenario: Pressure persists across runs

- **WHEN** repeated automatic attempts continue to leave the same connection with pending source-pressure gaps
- **THEN** the deferred next-attempt time SHALL grow relative to the base interval
- **AND** the deferred next-attempt time SHALL NOT grow beyond the configured cooldown cap

#### Scenario: A run recovers the pending pressure gaps

- **WHEN** a later run recovers the connection's pending source-pressure gaps so that none remain
- **THEN** the scheduler SHALL no longer apply a source-pressure cooldown to that connection
- **AND** the connection SHALL return to its normal scheduled cadence

### Requirement: Source-pressure cooldown SHALL be reason-scoped and not throttle unrelated connectors

The source-pressure cooldown SHALL be driven only by detail gaps whose reason represents account/source pressure. Detail gaps with other reasons, and connections with no pending source-pressure gaps, SHALL NOT be throttled by this policy. A failure to read the durable pending-gap evidence SHALL be treated as no pressure, so an unreadable store cannot silently pause a schedule.

#### Scenario: Connection has only non-pressure gaps

- **WHEN** a connection's pending detail gaps are all non-source-pressure reasons (or it has no pending gaps)
- **THEN** the scheduler SHALL NOT apply a source-pressure cooldown to that connection

#### Scenario: Pending-gap evidence cannot be read

- **WHEN** the durable pending-gap evidence cannot be read for a connection
- **THEN** the scheduler SHALL treat the connection as having no source-pressure cooldown
- **AND** the scheduler SHALL NOT silently suppress the connection's scheduled runs on that basis

### Requirement: Schedule projection SHALL surface source-pressure cooldown honestly

While a connection is governed by the source-pressure cooldown, the schedule/health projection SHALL surface a cooling-off health state and a deferred next-run time rather than presenting the connection as healthy with no qualification. The projection SHALL NOT downgrade a stronger blocked failure state to cooling off.

#### Scenario: Connection cooling off is projected

- **WHEN** the schedule projection is computed for a connection with pending source-pressure gaps that defer its next run
- **THEN** the projection SHALL report a cooling-off health state
- **AND** the projection SHALL report a next-run time no earlier than the cooldown's deferred attempt time

#### Scenario: Connection has no pending source pressure

- **WHEN** the schedule projection is computed for a connection with no pending source-pressure gaps and no failure back-off
- **THEN** the projection SHALL NOT report a cooling-off health state on the basis of source pressure

### Requirement: Connection-summary route supports single-connection scoping

The `GET /_ref/connectors` connection-summary route SHALL accept an optional
connection-selector query parameter. When the selector is present, the route
SHALL project and return only the connection(s) the selector resolves; when it is
absent, the route SHALL return summaries for all configured connections exactly
as before. The scoped projection SHALL be the same per-connection projection used
to build the unscoped list, so a single-connection summary cannot diverge from
the connection's entry in the full list.

The selector SHALL resolve a connection by the same precedence the operator
console uses to route a record subpage: an exact match on a connection's stable
connection identity (`connection_id` / `connector_instance_id`) is preferred;
otherwise the first configured connection whose `connector_id` matches. The route
SHALL NOT introduce a new addressing scheme for connections.

The route SHALL remain owner-session-gated for both the scoped and unscoped
forms, and the scoped read SHALL NOT persist a connection.

#### Scenario: Unscoped request returns all connections

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with
  no connection selector
- **THEN** the route SHALL return a `{object: "list", data}` envelope containing a
  summary for every configured connection
- **AND** the response SHALL be equivalent to the prior unscoped behavior

#### Scenario: Scoped request returns only the resolved connection

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with a
  connection selector that resolves to a configured connection
- **THEN** the route SHALL return a `{object: "list", data}` envelope containing
  exactly the one resolved connection's summary
- **AND** the route SHALL NOT run the per-connection projection fan-out for
  non-matching connections

#### Scenario: Scoped request that resolves nothing returns an empty list

- **WHEN** an owner-authenticated request is made to `GET /_ref/connectors` with a
  connection selector that matches no configured connection
- **THEN** the route SHALL return a `{object: "list", data}` envelope with an
  empty `data` array
- **AND** the response SHALL NOT silently scope to a single connector and SHALL
  NOT fall back to returning all connections

#### Scenario: Selector precedence prefers stable connection identity

- **WHEN** a selector value exactly matches one connection's
  `connection_id` / `connector_instance_id` and also matches the `connector_id`
  of other connections
- **THEN** the route SHALL resolve the connection whose stable identity matches
- **AND** a selector that matches only a `connector_id` SHALL resolve the first
  configured connection with that `connector_id`

### Requirement: Every connector run SHALL produce a per-stream Collection Report

For each terminal connector run, the reference implementation SHALL produce a
structured **Collection Report**: a per-stream coverage entry for every stream that
was in requested scope or visible in the connector manifest for that run. Each
entry SHALL answer, as structured fields rather than only timeline prose, what was
**considered**, what was **collected**, what was **skipped**, what remains a
**retryable gap**, what is **terminal or unsupported**, what **checkpoint** was
committed for that stream, and what the next run is expected to do.

The Collection Report SHALL be produced as a two-layer construction, because the
evidence needed to answer those questions does not all live in one layer:

- **Runtime collection-fact block (objective, run-local).** The reference runtime
  SHALL attach to the run's terminal evidence (the `run.completed`, `run.failed`,
  or `run.cancelled` spine event payload) a per-stream block carrying only the
  objective, run-local facts it owns at run completion: the stream's **collected**
  count, a **considered** value or `unknown` (never inferred from collected count),
  an optional **covered** count or `unknown` (the in-boundary items the run
  accounted for — emitted plus those it deliberately suppressed as unchanged —
  never inferred from collected count and never including a weighed-but-dropped
  item), the committed **checkpoint** status, the **skip** reason for any
  `SKIP_RESULT`, and the count of pending recoverable **detail gaps**. The runtime SHALL compose
  this block from signals it already receives — `RECORD` counts, `SKIP_RESULT`, the
  reference-only `DETAIL_GAP` and `DETAIL_COVERAGE` signals, and committed `STATE`
  cursors — and SHALL NOT require a new portable wire message from the connector.
  The runtime SHALL NOT stamp a final coverage condition or a forward disposition
  on the terminal event: both require freshness, refresh-policy, attention, and
  cross-stream rollup evidence that the per-connector run subprocess does not hold.
- **Control-plane projection (derived on read).** The control-plane projection
  (the layer that assembles connection-health evidence) SHALL derive the full
  per-stream Collection Report — each entry's **coverage condition** and **forward
  disposition** — from the runtime collection-fact block plus the freshness axis,
  manifest refresh policy, open attention evidence, and cross-stream coverage
  rollup that only that layer holds. Deriving on read keeps the report honest as
  data ages: an entry that was fresh at run completion can become
  `owner_refresh_due` later without rewriting run history.

The Collection Report SHALL be visible only on owner/control-plane surfaces under
the same redaction and bounding policy already applied to `known_gaps` and
`SKIP_RESULT.diagnostics`. Neither the runtime collection-fact block nor the
derived report SHALL be exposed through grant-scoped `/v1` data, search, schema, or
blob APIs.

A stream's entry SHALL reuse the connection-coverage condition vocabulary — the
runtime `CoverageAxis` the connection-health projection already emits
(`complete`, `partial`, `gaps`, `retryable_gap`, `terminal_gap`, `unsupported`,
`unavailable`, `deferred`, `inventory_only`, `unknown`) — so that the
connection-health projection consumes the report without re-deriving coverage from
heterogeneous per-connector heuristics. Freshness (`fresh` / `stale` / `unknown`)
is a separate axis and SHALL NOT be encoded as a coverage condition.

#### Scenario: A successful run produces a report entry per in-scope stream

- **WHEN** a connector run completes for a scope that requested two streams and the manifest declares no further streams
- **THEN** the run's terminal evidence SHALL carry a runtime collection-fact block with one per-stream entry for each of the two requested streams, each entry carrying the stream's collected count and committed checkpoint status
- **AND** the control-plane projection SHALL derive a Collection Report with one entry per stream, each entry carrying a coverage condition drawn from the connection-coverage vocabulary

#### Scenario: The runtime terminal event carries facts only, not derived axes

- **WHEN** the reference runtime emits the `run.completed`, `run.failed`, or `run.cancelled` terminal event for a run
- **THEN** the terminal event's collection-fact block SHALL carry per-stream collected count, considered-or-`unknown`, checkpoint status, skip reason, and pending-detail-gap count
- **AND** the terminal event SHALL NOT carry a per-stream coverage condition or a per-stream forward disposition, because those are derived by the control-plane projection from evidence the runtime does not hold

#### Scenario: A run that skips a stream records it in the report

- **WHEN** a connector emits `SKIP_RESULT` for a requested stream because the implementation cannot collect it in the current mode
- **THEN** the runtime collection-fact block for that stream SHALL carry the skip reason
- **AND** the derived Collection Report entry for that stream SHALL carry a coverage condition of `unsupported`, `unavailable`, `deferred`, or `terminal_gap` consistent with the skip and SHALL NOT report that stream as `complete`

#### Scenario: A run with a recoverable detail gap records it in the report

- **WHEN** a bounded run records a durable recoverable `DETAIL_GAP` for a stream before committing list-level progress
- **THEN** the runtime collection-fact block for that stream SHALL carry the count of pending recoverable gaps
- **AND** the derived Collection Report entry for that stream SHALL carry a `retryable_gap` coverage condition and SHALL reference the reference-only detail-gap backlog rather than restating per-item locators in the report

#### Scenario: The report does not change the public data API

- **WHEN** a grant-scoped client token reads records, search results, schema, or blobs within its grant
- **THEN** the Collection Report SHALL NOT be included in the response
- **AND** the client SHALL NOT receive an identifier that grants access to the report

### Requirement: A Collection Report entry SHALL state a forward disposition

Each Collection Report stream entry SHALL carry a **forward disposition** that
states what work, if any, the next run is expected to do on that stream. The
disposition SHALL be one of `complete` (no outstanding gap and freshness is fresh
or unknown), `resumable` (an outstanding gap that ordinary forward collection or
detail-gap recovery is expected to fill on a later run without owner action),
`awaiting_owner` (an outstanding gap blocked on structured owner attention such as
credentials, OTP, re-consent, or a manual action), `owner_refresh_due` (no
outstanding coverage gap, but the retained data is stale for a connection that
cannot refresh on its own, so an owner-initiated run is due), or `terminal` (an
outstanding gap that no future run is expected to fill without a connector or
source change). The disposition SHALL be derived by the control-plane projection
from the entry's coverage condition, the retryability of any recorded gap, current
attention evidence, and the connection's freshness and refresh-policy evidence —
not from run timeline prose, and not stamped on the runtime terminal event. The
runtime terminal event SHALL NOT carry a forward disposition; the forward
disposition is derived on read by the layer that holds freshness, refresh-policy,
attention, and rollup evidence (the same construction the connection-level
`forward_disposition` already uses).

Coverage completeness and freshness are distinct axes and SHALL NOT be conflated:
a stale stream that collected everything it considered SHALL keep a `complete`
coverage condition and a `stale` freshness axis. Staleness SHALL NOT be encoded as
a coverage gap, and a stale-but-complete stream SHALL NOT be reported with a
coverage condition of `partial`, `gaps`, `retryable_gap`, or `terminal_gap`. The
disposition is where the freshness fact becomes an owner-facing action: a
complete-coverage stream whose connection is manual-refresh-only (its manifest
refresh policy is not background-safe — `recommended_mode` `manual` or `paused`,
or `background_safe` `false`) and whose freshness axis is `stale` SHALL be
`owner_refresh_due`, signalling owner-initiated refresh work rather than degraded
or lost data. A schedulable, background-safe connection that goes stale is the
system's own responsibility to refresh and SHALL NOT be reported as
`owner_refresh_due`.

The forward disposition SHALL be consistent with the gap it describes: an entry
with an outstanding gap blocked on owner attention SHALL be `awaiting_owner`; an
entry whose only outstanding gap is a recoverable detail gap or an ordinary partial
boundary SHALL be `resumable` unless blocked on owner attention; an entry whose gap
is a terminal or unsupported condition SHALL be `terminal`; an entry with no
outstanding gap SHALL be `owner_refresh_due` when it is manual-refresh stale and
`complete` otherwise. `awaiting_owner` SHALL be reserved for an outstanding
coverage gap and SHALL NOT be used for a stale-but-complete stream, so the owner
can tell missing data from merely aged data.

#### Scenario: A retryable gap is resumable

- **WHEN** a stream entry's only outstanding gap is a pending recoverable detail gap with retryable upstream pressure and no owner action is required
- **THEN** the entry's forward disposition SHALL be `resumable`
- **AND** the owner surface SHALL be able to state that the next run is expected to fill the gap without owner action

#### Scenario: A gap blocked on owner attention awaits the owner

- **WHEN** a stream cannot complete because the connection has open structured attention evidence (for example missing credentials, a pending OTP, or required re-consent)
- **THEN** the entry's forward disposition SHALL be `awaiting_owner`
- **AND** the owner surface SHALL point the owner at the same attention target rather than implying an automatic retry will resolve it

#### Scenario: An unsupported stream is terminal

- **WHEN** a stream entry's coverage condition is `unsupported` or `terminal_gap` with no recoverable recovery path
- **THEN** the entry's forward disposition SHALL be `terminal`
- **AND** the owner surface SHALL NOT imply that a future ordinary run will collect that stream

#### Scenario: Complete coverage with fresh freshness is complete and needs no owner action

- **WHEN** a stream entry has no outstanding gap, a committed checkpoint, a known considered value the collected count satisfies, and a freshness axis of `fresh`
- **THEN** the entry's coverage condition SHALL be `complete` and its forward disposition SHALL be `complete`
- **AND** the owner surface SHALL state that no owner action is required for that stream

#### Scenario: Complete coverage that is manual-refresh stale is owner-refresh-due, not degraded data loss

- **WHEN** a stream entry has no outstanding coverage gap and a committed checkpoint, but the connection is manual-refresh-only (its manifest refresh policy is `recommended_mode` `manual` or `paused`, or `background_safe` `false`) and its freshness axis is `stale`
- **THEN** the entry's coverage condition SHALL remain `complete` and its freshness axis SHALL remain `stale`
- **AND** the entry's forward disposition SHALL be `owner_refresh_due`, not `awaiting_owner`, `resumable`, or `complete`
- **AND** the owner surface SHALL frame this as an owner-initiated refresh that is due, not as missing, dropped, or degraded data

#### Scenario: A retryable detail gap stays visible even when the stream is also stale

- **WHEN** a stream entry has a pending recoverable `DETAIL_GAP` with retryable upstream pressure, no owner attention is open, and the connection's freshness axis is also `stale`
- **THEN** the entry's coverage condition SHALL be `retryable_gap` and its pending recoverable-gap count SHALL remain recorded
- **AND** the entry's forward disposition SHALL be `resumable` so the retryable/resumable recovery path stays visible and is not masked by the stale freshness
- **AND** staleness SHALL NOT downgrade, hide, or absorb the recorded retryable gap

#### Scenario: A schedulable stale stream is not owner-refresh-due

- **WHEN** a stream entry has no outstanding gap but the connection is schedulable and background-safe and its freshness axis is `stale`
- **THEN** the entry's forward disposition SHALL NOT be `owner_refresh_due`
- **AND** the owner surface SHALL treat the stale freshness as the system's own scheduled-refresh responsibility rather than owner-initiated refresh work

### Requirement: Absence of a considered denominator SHALL be honest, not assumed complete

A Collection Report stream entry SHALL distinguish a known **considered** axis —
the source range, inventory size, or boundary the run took into account for that
stream — from an unknown one. When a connector declares what it considered for a
stream (for example via `DETAIL_COVERAGE.required_keys`, an explicit considered
count, or an inventory diagnostic), the runtime collection-fact block SHALL record
that considered value, and the control-plane projection MAY use it to distinguish
`partial` from `complete`. When the connector declares no considered value, the
runtime collection-fact block's considered value SHALL be `unknown`, and the
runtime SHALL NOT infer a considered value from collected count alone.

A run that collected records SHALL NOT, by collected count alone, be projected as
having completely covered a stream whose considered denominator is unknown. Neither
the runtime nor the control-plane projection SHALL infer `complete` from collected
count alone. The absence of a considered value SHALL read as absence of evidence,
not as proof of completeness.

A stream that re-enumerates its full source boundary every run and suppresses the
records it determined to be unchanged (for example a full-sync stream gated by a
per-record fingerprint) MAY declare, alongside `considered`, an explicit **covered**
count: the number of in-boundary items the run accounted for, defined as the items
it emitted plus the items it suppressed because they were unchanged. The covered
count SHALL be measured at the enumeration site from objective per-record outcomes
(emitted, or suppressed-because-unchanged) and SHALL NOT be inferred from the
collected count, and SHALL NOT count an item the run weighed but dropped (a
malformed record, a record excluded by a boundary filter, or any item not present
in the source as unchanged). When a connector declares a covered count, the
control-plane projection SHALL compare the considered denominator against the
covered count rather than the collected count: a stream whose covered count
satisfies its considered denominator with no outstanding gap or skip SHALL read
`complete`, and a stream whose covered count falls short of its considered
denominator SHALL read `partial`. When a connector declares no covered count, the
projection SHALL compare the considered denominator against the collected count as
before. The covered count SHALL be optional evidence only; its absence SHALL NOT
change the meaning of `considered` for any stream that does not declare it.

#### Scenario: A steady-state full-sync run suppresses only unchanged records

- **WHEN** a connector enumerates a full-sync stream's entire source boundary, emits no records because every in-boundary item was unchanged since the prior run, and declares a considered count equal to the enumerated inventory and a covered count equal to the same inventory (every item accounted for as suppressed-unchanged)
- **THEN** the Collection Report entry SHALL record the considered value and a `complete` coverage condition
- **AND** the entry SHALL NOT read `partial` solely because its collected count is below its considered denominator

#### Scenario: A full-sync run that drops a weighed item stays partial

- **WHEN** a connector enumerates a full-sync stream's source boundary and accounts for fewer items as covered (emitted or suppressed-unchanged) than it considered, because it weighed but dropped an item (for example a record that failed shape validation)
- **THEN** the Collection Report entry SHALL record the considered value and a `partial` coverage condition
- **AND** the dropped item SHALL NOT be counted as covered, so the covered count SHALL fall short of the considered denominator and the shortfall SHALL remain visible

#### Scenario: A connector declares what it considered

- **WHEN** a connector declares a considered value for a stream (an inventory size, a required-keys set, or an explicit considered count) and collects fewer items than it considered with the remainder recorded as gaps
- **THEN** the Collection Report entry SHALL record the considered value and a `partial` coverage condition
- **AND** the entry SHALL NOT report `complete`

#### Scenario: A connector declares no considered value

- **WHEN** a connector collects records for a stream but declares no considered value, inventory, or required-keys set, and records no gaps
- **THEN** the Collection Report entry's considered axis SHALL be `unknown`
- **AND** the entry SHALL NOT be projected as `complete` solely because it collected records and recorded no gaps
- **AND** the entry's forward disposition SHALL NOT be `complete` on the strength of collected count alone, because `complete` requires the absence of an outstanding gap to be established rather than assumed from an unknown denominator

#### Scenario: Considered evidence is unreadable

- **WHEN** the runtime cannot read a connector-declared considered value because it is malformed or exceeds bounds
- **THEN** the entry's considered axis SHALL fall back to `unknown`
- **AND** the failure SHALL NOT fabricate a `complete` coverage condition for that stream

### Requirement: The Collection Report SHALL reuse reference-only signals without promoting them

The Collection Report SHALL be a reference-implementation projection. It SHALL
compose the reference-only `DETAIL_GAP` and `DETAIL_COVERAGE` signals under their
existing reference-only constraint and the already-public `SKIP_RESULT`, `STATE`,
and terminal-event surfaces. This change SHALL NOT promote `DETAIL_GAP`,
`DETAIL_COVERAGE`, the detail-gap backlog schema, or a new Collection Report
message into the normative portable Collection Profile protocol. Portable
connectors and protocol readers SHALL NOT be required to emit a Collection Report
message or to rely on its shape unless a later OpenSpec change and root protocol
update promote an explicit wire contract.

#### Scenario: A protocol reader asks whether the report is portable protocol

- **WHEN** a reviewer asks whether the Collection Report is a required Collection Profile message or field
- **THEN** the reference documentation SHALL state that it is reference-only projection, not normative portable protocol in this tranche
- **AND** a portable connector that emits only `RECORD`, `STATE`, and `DONE` SHALL still produce a valid Collection Report whose unknown axes read as `unknown`

#### Scenario: Report composition avoids secrets

- **WHEN** the runtime bounds connector-authored skip diagnostics, detail-gap locators, or considered/covered values into the collection-fact block, and the control-plane projection derives the Collection Report from it
- **THEN** both layers SHALL apply the same secret-redaction and bounding policy used for `known_gaps` and `SKIP_RESULT.diagnostics`
- **AND** neither SHALL persist bearer tokens, cookies, secret-bearing URLs, request bodies, or raw private payloads

### Requirement: The authorization endpoint SHALL accept URL-shaped client identifiers via CIMD

The reference AS SHALL accept an `https://`-URL `client_id` at the authorization endpoint without prior Dynamic Client Registration or pre-registration. When `client_id` begins with `https://`, the AS SHALL treat it as a Client ID Metadata Document (CIMD) identifier and fetch the document to establish client identity.

#### Scenario: CIMD client_id is detected at the authorize endpoint
- **WHEN** the authorization endpoint receives a request with a `client_id` that begins with `https://`
- **THEN** the AS SHALL classify it as a CIMD client_id
- **AND** it SHALL NOT route it through the DCR or pre-registered-public lookup path
- **AND** it SHALL proceed to validate the URL before fetching

#### Scenario: Non-URL client_id is presented
- **WHEN** the authorization endpoint receives a `client_id` that does not begin with `https://`
- **THEN** the AS SHALL apply existing DCR and pre-registered-public resolution unchanged
- **AND** it SHALL NOT attempt a CIMD fetch

### Requirement: The AS SHALL validate the CIMD client_id URL before any outbound fetch

Before issuing any outbound HTTP request, the AS SHALL reject `client_id` values that fail the following pre-fetch validation:

1. Scheme is exactly `https`.
2. Userinfo component is absent.
3. Path is non-empty and contains no dot-segment (`/.` or `/..`) and no fragment.
4. Resolved host is not a loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`, `fe80::/10`), private (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`), or multicast address.
5. Port, if present, is subject to the same DNS/IP validation and fetch-time guardrails.

#### Scenario: Validation rejects a loopback client_id
- **WHEN** `client_id` resolves to a loopback address
- **THEN** the AS SHALL return an authorization error without issuing any outbound fetch

#### Scenario: Validation rejects a private-network client_id
- **WHEN** `client_id` resolves to a private RFC 1918 or ULA address
- **THEN** the AS SHALL return an authorization error without issuing any outbound fetch

#### Scenario: Validation rejects userinfo in the client_id URL
- **WHEN** `client_id` contains a userinfo component (e.g. `https://user@example.com/...`)
- **THEN** the AS SHALL return an authorization error without issuing any outbound fetch

#### Scenario: Validation rejects dot-segment paths
- **WHEN** `client_id` path contains `/.` or `/..`
- **THEN** the AS SHALL return an authorization error without issuing any outbound fetch

### Requirement: CIMD metadata fetch IP filtering SHALL reject mapped and non-public addresses

Before fetching an external CIMD metadata document, the reference SHALL reject
DNS results that resolve to loopback, private, link-local, multicast,
unspecified, broadcast, carrier-grade NAT, or IPv4-mapped IPv6 forms of those
addresses.

#### Scenario: IPv4-mapped loopback is rejected
- **WHEN** CIMD DNS resolution returns `::ffff:127.0.0.1`
- **THEN** the reference SHALL reject the metadata fetch before issuing HTTP.

#### Scenario: CGNAT and broadcast IPv4 are rejected
- **WHEN** CIMD DNS resolution returns `100.64.0.1` or `255.255.255.255`
- **THEN** the reference SHALL reject the metadata fetch before issuing HTTP.

### Requirement: The AS SHALL fetch and cache CIMD documents with size and timeout safeguards

When an external `client_id` URL passes pre-fetch validation, the AS SHALL fetch the CIMD document with all of the following constraints:

- Timeout: abort after 5 seconds.
- Size cap: abort and reject if the response body exceeds 5 KB.
- Redirects: do not automatically follow HTTP redirects.
- Cache: store a successfully fetched document for between 60 seconds and 24 hours, keyed on the exact `client_id` URL.

#### Scenario: Fetch succeeds within limits
- **WHEN** the CIMD document is fetched and the body is ≤5 KB within 5 seconds
- **THEN** the AS SHALL parse, validate, and cache the document
- **AND** it SHALL use the document to populate the consent surface

#### Scenario: Fetch exceeds size cap
- **WHEN** the response body exceeds 5 KB
- **THEN** the AS SHALL abort the fetch and return a recoverable authorization error
- **AND** it SHALL log the failure at WARN
- **AND** it SHALL NOT issue an authorization code, grant, or token

#### Scenario: Fetch exceeds timeout
- **WHEN** the fetch does not complete within 5 seconds
- **THEN** the AS SHALL abort the connection and return a recoverable authorization error
- **AND** it SHALL log the failure at WARN
- **AND** it SHALL NOT issue an authorization code, grant, or token

#### Scenario: Fetch returns a non-200 status
- **WHEN** the CIMD endpoint returns a non-200 HTTP status
- **THEN** the AS SHALL return a recoverable authorization error
- **AND** it SHALL log the failure at WARN
- **AND** it SHALL NOT issue an authorization code, grant, or token

#### Scenario: Fetch returns a redirect
- **WHEN** the CIMD endpoint returns a redirect status
- **THEN** the AS SHALL return a recoverable authorization error without following the redirect
- **AND** it SHALL NOT issue an authorization code, grant, or token

#### Scenario: Document is malformed or missing client_id
- **WHEN** the fetched document is malformed JSON, lacks `client_id`, or has a `client_id` value that is not an exact string match for the URL used to fetch it
- **THEN** the AS SHALL reject the authorization request
- **AND** it SHALL NOT cache the document

#### Scenario: Document requests unsupported client authentication
- **WHEN** the fetched document contains a shared-secret client authentication method, `client_secret`, or a client authentication method the reference token endpoint does not implement
- **THEN** the AS SHALL reject the authorization request
- **AND** it SHALL NOT cache the document

#### Scenario: Cache hit avoids re-fetch
- **WHEN** a valid cached CIMD document exists for the `client_id` and is within its TTL
- **THEN** the AS SHALL serve the cached document without issuing an outbound fetch

### Requirement: CIMD consent display SHALL distinguish origin identity from client-authored display claims

The reference consent display SHALL distinguish URL-origin identity from
client-authored display claims for clients resolved through Client ID Metadata
Documents. For those clients, the display SHALL present the `client_id` origin
as the client identity. Metadata document fields such as `client_name`,
`client_uri`, and `logo_uri` SHALL be presented only as self-described client
metadata unless a separate server-side trust registry verifies them.

#### Scenario: CIMD client name is self-described
- **WHEN** a CIMD client metadata document identifies the client as `https://client.example/oauth/client.json`
- **AND** the document sets `client_name` to `Claude`
- **THEN** the consent display SHALL show `https://client.example` as the client identity
- **AND** it SHALL label `Claude` as self-described client metadata rather than verified identity.

#### Scenario: Registered clients keep registered display
- **WHEN** a pre-registered or dynamically registered public client requests consent
- **THEN** the consent display SHALL continue to use the server-resolved registered client display metadata as the requesting app identity.

### Requirement: The AS SHALL enforce redirect_uri trust using same-origin constraint with a localhost exception

The AS SHALL require that every `redirect_uri` in a CIMD authorize request appears in the fetched document's `redirect_uris` field and satisfies at least one of:

- It shares the same origin (scheme + host + port) as the `client_id` URL, or
- It matches `http://localhost:*/*`, `http://127.0.0.1:*/*`, or `http://[::1]:*/*` (localhost development exception).

#### Scenario: redirect_uri matches document and shares origin
- **WHEN** the `redirect_uri` in the authorize request is listed in the CIMD document and shares the `client_id` origin
- **THEN** the AS SHALL proceed with the authorization request

#### Scenario: redirect_uri is a localhost development URI
- **WHEN** the `redirect_uri` is loopback HTTP on `localhost`, `127.0.0.1`, or `[::1]` and is listed in the CIMD document
- **THEN** the AS SHALL permit it as the localhost development exception

#### Scenario: redirect_uri is cross-origin and not localhost
- **WHEN** the `redirect_uri` does not share the `client_id` origin and is not a localhost URI
- **THEN** the AS SHALL reject the authorization request

#### Scenario: redirect_uri is absent from the document
- **WHEN** the `redirect_uri` is not listed in the CIMD document
- **THEN** the AS SHALL reject the authorization request

### Requirement: The AS SHALL revoke tokens and invalidate cache on security-relevant metadata changes

When a re-fetched CIMD document changes security-relevant metadata (`redirect_uris`, `token_endpoint_auth_method`, `jwks`, or `jwks_uri`) compared with the previously cached version, the AS SHALL:

1. Revoke all tokens issued to that `client_id`.
2. Invalidate the cached document entry.
3. Emit a security audit log record.

#### Scenario: Re-fetched document has changed security-relevant metadata
- **WHEN** a CIMD document is re-fetched and its `redirect_uris`, `token_endpoint_auth_method`, `jwks`, or `jwks_uri` differs from the cached version
- **THEN** the AS SHALL revoke all tokens issued to that `client_id`
- **AND** it SHALL invalidate the cache entry and log a security audit event
- **AND** the client SHALL be required to re-authorize

#### Scenario: Re-fetched document has unchanged security-relevant metadata
- **WHEN** a CIMD document is re-fetched and its security-relevant metadata is unchanged
- **THEN** the AS SHALL update the cache TTL
- **AND** existing tokens SHALL remain valid

#### Scenario: Re-fetched document changes display-only metadata
- **WHEN** a CIMD document is re-fetched and only `client_name` or `logo_uri` changes
- **THEN** the AS MAY update the displayed metadata without revoking existing tokens

### Requirement: The AS SHALL advertise CIMD support in authorization-server discovery

The AS SHALL include `"client_id_metadata_document"` in the `pdpp_registration_modes_supported` array of the `/.well-known/oauth-authorization-server` metadata response when CIMD behavior is implemented. The AS SHALL also set the current standard metadata field `client_id_metadata_document_supported: true` while the field remains current in the CIMD draft.

#### Scenario: Discovery metadata is fetched
- **WHEN** a client fetches `/.well-known/oauth-authorization-server`
- **THEN** `pdpp_registration_modes_supported` SHALL include `"client_id_metadata_document"`
- **AND** the existing values `"dynamic"` and `"pre_registered_public"` SHALL remain present
- **AND** `client_id_metadata_document_supported` SHALL be `true` while that field name remains current in the CIMD draft

### Requirement: The reference SHALL serve operator-created CIMD documents at a stable route

The reference AS SHALL expose a `GET /oauth/client-metadata/:id` route that serves operator-created CIMD documents. The route SHALL:

- Return `Content-Type: application/json` with `Cache-Control: max-age=3600`.
- Return HTTP 404 for unknown identifiers.
- Include `client_id` exactly equal to the document URL.
- Include `redirect_uris`.
- Include `token_endpoint_auth_method: "none"` for public local MCP clients.
- Exclude `client_secret` and every shared-secret authentication method.

#### Scenario: Known client metadata document is requested
- **WHEN** `GET /oauth/client-metadata/<uuid>` is requested for an operator-created identity
- **THEN** the response SHALL be `application/json` with the CIMD document and `Cache-Control: max-age=3600`

#### Scenario: Unknown client metadata document is requested
- **WHEN** `GET /oauth/client-metadata/<uuid>` is requested for an id not in operator storage
- **THEN** the response SHALL be HTTP 404

#### Scenario: End-to-end CIMD flow using the hosted document
- **WHEN** an MCP client presents `https://<pdpp-host>/oauth/client-metadata/<uuid>` as its `client_id`
- **THEN** the AS SHALL resolve the document from local operator storage rather than issuing an outbound self-fetch
- **AND** it SHALL complete the authorize flow and issue a grant-scoped token usable at `/mcp`

#### Scenario: Hosted client metadata document is deleted
- **WHEN** the operator deletes a client metadata document
- **THEN** the document URL SHALL return HTTP 404
- **AND** all grants and tokens issued to that exact `client_id` SHALL be revoked

### Requirement: CIMD pending consent re-resolution SHALL use the CIMD-aware client resolver

The reference authorization server SHALL re-resolve pending consent clients
through the same CIMD-aware client resolution path used at request initiation and
token exchange.

#### Scenario: CIMD consent approval succeeds after display
- **WHEN** a URL-shaped CIMD `client_id` request has been staged for consent
- **AND** the owner approves the pending consent
- **THEN** the AS SHALL resolve the client through CIMD metadata
- **AND** it SHALL issue the scoped grant/token when the request is otherwise valid.

### Requirement: The reference SHALL reject owner and control-plane bearer tokens at /mcp

The `/mcp` endpoint SHALL reject requests bearing owner bearer tokens or control-plane bearer tokens. This posture is unchanged by the CIMD addition.

#### Scenario: Owner bearer token is presented to /mcp
- **WHEN** a request to `/mcp` carries an owner bearer token
- **THEN** the server SHALL return an authentication error
- **AND** the request SHALL NOT be processed as a normal MCP operation

#### Scenario: Normal MCP setup does not involve the owner token
- **WHEN** an MCP client follows the CIMD-based OAuth authorize flow
- **THEN** it SHALL receive a grant-scoped client token
- **AND** the owner token SHALL NOT be required or requested at any step of the flow

### Requirement: Dynamic client registration SHALL infer native clients from loopback HTTP redirects

When dynamic client registration receives authorization-code public-client metadata without `application_type`, the reference AS SHALL infer `application_type: "native"` if any registered redirect URI uses HTTP on a loopback host. The inferred type SHALL be persisted in registration details and returned in the registration response. If `application_type` is explicitly supplied, the AS SHALL honor and validate the supplied type rather than overriding it.

#### Scenario: Loopback IPv4 redirect infers native

- **WHEN** a public client posts `/oauth/register` with `grant_types: ["authorization_code"]`, `response_types: ["code"]`, no `application_type`, and a redirect URI on `http://127.0.0.1:{port}/...`
- **THEN** the AS SHALL register the client
- **AND** the registration response SHALL include `application_type: "native"`.

#### Scenario: Localhost redirect infers native

- **WHEN** a public client posts `/oauth/register` with `grant_types: ["authorization_code"]`, `response_types: ["code"]`, no `application_type`, and a redirect URI on `http://localhost:{port}/...`
- **THEN** the AS SHALL register the client
- **AND** the registration response SHALL include `application_type: "native"`.

#### Scenario: Loopback IPv6 redirect infers native

- **WHEN** a public client posts `/oauth/register` with `grant_types: ["authorization_code"]`, `response_types: ["code"]`, no `application_type`, and a redirect URI on `http://[::1]:{port}/...`
- **THEN** the AS SHALL register the client
- **AND** the registration response SHALL include `application_type: "native"`.

#### Scenario: Explicit web client remains strict

- **WHEN** a public client posts `/oauth/register` with `application_type: "web"` and a loopback HTTP redirect URI
- **THEN** the AS SHALL reject the registration as invalid web-client redirect metadata.

### Requirement: Managed-platform Core deploy target SHALL expose exactly one public origin

The reference implementation SHALL define a managed-platform Core deploy target
that exposes exactly one internet-reachable origin and keeps the Authorization
Server and Resource Server listeners private. The single public origin SHALL
front the full protocol surface — OAuth metadata, OAuth endpoints, the hosted
MCP endpoint, the `/v1` query API, owner and device surfaces — by proxying to
the internal AS and RS using private internal targets, while the public origin is
advertised through composed mode via `PDPP_REFERENCE_ORIGIN` (or
`AS_PUBLIC_URL` / `RS_PUBLIC_URL`).

The AS and RS listeners SHALL NOT be published as separate public origins for
this deploy target. They SHALL be reachable only through private network or
loopback targets, and the public origin SHALL terminate TLS with the forwarded
protocol trusted so that browser-facing metadata, owner sessions, and CSRF
protection bind to the public HTTPS origin.

Browser-facing metadata served through the public origin SHALL advertise the
public origin and SHALL NOT leak an internal service name as a browser-facing
URL.

#### Scenario: Public origin fronts the full protocol surface

- **WHEN** the managed-platform Core deploy target is configured with one public origin and private AS/RS listeners
- **THEN** the public origin SHALL serve OAuth authorization-server metadata, OAuth protected-resource metadata, the OAuth endpoints, the hosted MCP endpoint, and the `/v1` query API by proxying to the internal AS and RS
- **AND** the AS and RS listeners SHALL NOT be published as separate public origins
- **AND** the AS and RS listeners SHALL be reachable only over private network or loopback targets

#### Scenario: Composed-origin metadata is consistent on the public origin

- **WHEN** an external client reads OAuth metadata from the public origin
- **THEN** the AS `issuer`, the RS `resource`, and the first entry of the RS `authorization_servers` SHALL each equal the public origin
- **AND** no internal service name SHALL appear as a browser-facing URL in that metadata

#### Scenario: Public origin is served over HTTPS with trusted forwarded protocol

- **WHEN** the public origin terminates TLS at the platform and forwards the protocol to the console
- **THEN** owner-session and CSRF cookies SHALL be marked `Secure`
- **AND** browser-facing metadata and authorization URLs SHALL use the public HTTPS origin

### Requirement: Managed-platform Core deploy target SHALL configure durable storage explicitly

The managed-platform Core deploy target SHALL be configured with durable storage
so that records, grants, runs, and tokens survive a restart or redeploy. The
operator SHALL choose either a managed Postgres backend, set through
`PDPP_DATABASE_URL` with `PDPP_STORAGE_BACKEND=postgres` optional because the
runtime selects Postgres when the database URL is present, whose schema is
bootstrapped idempotently at boot with no separate migrate step, or a SQLite
database file on a mounted persistent volume with `PDPP_DB_PATH` pointed onto
that mounted path.

The non-durable default storage SHALL NOT be the configured backend for a deploy
that must survive restart. The in-memory SQLite default SHALL NOT be used, and a
SQLite deploy SHALL NOT leave `PDPP_DB_PATH` at a default path that is not on the
mounted persistent volume.

#### Scenario: Managed Postgres backend bootstraps at boot

- **WHEN** the deploy target is configured with `PDPP_DATABASE_URL`, with or without `PDPP_STORAGE_BACKEND=postgres`
- **THEN** the schema SHALL be created or migrated idempotently during application start
- **AND** no separate migrate step SHALL be required before first boot
- **AND** a restart SHALL re-run the idempotent bootstrap without error and without data loss

#### Scenario: SQLite backend is pinned to a mounted volume

- **WHEN** the deploy target uses the SQLite backend
- **THEN** `PDPP_DB_PATH` SHALL point onto a mounted persistent volume
- **AND** the in-memory default and any unmounted default path SHALL NOT be the configured database location

#### Scenario: Stored data survives a restart

- **WHEN** the deployed service is restarted after storing records and an owner session
- **THEN** the previously stored records SHALL still be queryable
- **AND** the owner SHALL still authenticate without data loss

### Requirement: Managed-platform Core deploy target SHALL gate owner data by default

The managed-platform Core deploy target SHALL require a non-empty
`PDPP_OWNER_PASSWORD` and SHALL NOT serve the owner console, device-approval, or
pending-consent surfaces anonymously. An unauthenticated request to the owner
console SHALL redirect to the owner login surface, and live owner data SHALL NOT
be rendered without a valid owner session.

Secrets required by the deploy target SHALL be runtime-provided and SHALL NOT be
baked into image layers or committed configuration defaults. The owner-session
signing key is derived from `PDPP_OWNER_PASSWORD`, so a stable password SHALL
keep owner sessions valid across restarts without a separate session secret.

#### Scenario: Owner console is gated on the public origin

- **WHEN** an anonymous request hits the owner console on the public origin with `PDPP_OWNER_PASSWORD` configured
- **THEN** the request SHALL redirect to the owner login surface
- **AND** live owner data SHALL NOT be served without a valid owner session

#### Scenario: Owner password is required for the deploy target

- **WHEN** the managed-platform Core deploy target is configured
- **THEN** a non-empty `PDPP_OWNER_PASSWORD` SHALL be required
- **AND** the empty-password open-dashboard behavior SHALL NOT be the configured state for the public origin

#### Scenario: Deploy secrets are runtime-provided

- **WHEN** the deploy target needs `PDPP_OWNER_PASSWORD`, a database URL, or other secrets
- **THEN** those values SHALL be supplied at runtime through platform environment variables
- **AND** they SHALL NOT be baked into image layers or committed configuration defaults

### Requirement: Managed-platform Core deploy target SHALL define an executable first-live-test gate

The managed-platform Core deploy target SHALL define a reproducible
first-live-test gate that proves a Core node boots, stays healthy, gates owner
data, persists across restart, and answers an authenticated query, and SHALL be
runnable against a local composed-origin stack before any live platform run is
requested. The gate SHALL use the public health probe, the composed-origin
smoke assertions, the owner-gated deployment diagnostics, an MCP reachability
check, a storage-persistence check, and a documented rollback or cleanup path.

The public health probe SHALL return HTTP 200 from the public origin when the
service is ready. The hosted MCP endpoint on the public origin SHALL refuse
anonymous access and SHALL succeed for a scoped grant. The first live test SHALL
NOT depend on browser-backed connector collection.

#### Scenario: Health and diagnostics are reachable on the public origin

- **WHEN** the deployed service is healthy
- **THEN** the public health probe on the public origin SHALL return HTTP 200
- **AND** the owner-gated `GET /_ref/deployment` diagnostics SHALL report the deploy facts with semantic retrieval shown as an honest "not enabled" rather than a defect

#### Scenario: MCP refuses anonymous access and serves a scoped grant

- **WHEN** a client calls the hosted MCP endpoint on the public origin
- **THEN** an anonymous call SHALL be refused
- **AND** a call carrying a valid scoped grant or token SHALL complete `tools/list` and return a scoped record query result

#### Scenario: First live test excludes browser collection

- **WHEN** the first live test exercises the Core query path
- **THEN** the queried records SHALL come from a small hand-imported record set
- **AND** the test SHALL NOT require a browser-backed connector run inside the deployed service

#### Scenario: Rollback and cleanup are defined

- **WHEN** a deploy must be rolled back or torn down
- **THEN** a documented rollback or cleanup path SHALL return the project to a known-good or clean state
- **AND** it SHALL NOT orphan the public origin or the persistent storage volume

### Requirement: Managed-platform Core deploy target SHALL provide platform-neutral deploy artifacts

The reference implementation SHALL provide deploy artifacts that reproduce the
managed-platform Core deploy target from the existing Docker assembly. The
artifacts SHALL include a documented environment block consistent with the
committed Docker example environment, a deploy configuration and runbook
describing the public origin, the private AS/RS listener placement, the storage
choice, the public health probe, and the rollback steps, and an operator-voice
deployment guide section.

The deploy artifacts SHALL keep the public-versus-internal URL distinction
explicit, SHALL describe the storage choice and its persistence requirement, and
SHALL use operator voice. They SHALL NOT describe the reference deployment as a
hosted multi-tenant service, SHALL NOT imply that browser-backed connector
collection runs inside the deployed service, and SHALL keep Core, Collection
Profile, reference implementation, and operator console distinct.

#### Scenario: Deploy artifacts reproduce the target from the existing assembly

- **WHEN** an operator follows the deploy artifacts for the managed-platform Core deploy target
- **THEN** the documented environment block SHALL be consistent with the committed Docker example environment
- **AND** the runbook SHALL define the public origin, the private AS/RS listener placement, the storage choice, the public health probe, and the rollback steps

#### Scenario: Deploy documentation uses operator voice

- **WHEN** the deployment guide describes the deploy target
- **THEN** it SHALL use operator voice and SHALL NOT describe the reference deployment as a hosted multi-tenant service
- **AND** it SHALL NOT imply that browser-backed connector collection runs inside the deployed service
- **AND** it SHALL keep Core, Collection Profile, reference implementation, and operator console distinct

### Requirement: Managed-platform Core deploy target SHALL provide a pushbutton Railway Template handoff

The reference implementation SHALL provide a Railway Template publication
handoff that can produce a user-facing "Deploy on Railway" button after the
template owner publishes a validated project. The handoff SHALL define the
selected one-service `railway-core` template shape, private loopback AS/RS
listeners, durable storage binding, required owner secret, public-origin binding,
smoke checks, and button markup.

The template handoff SHALL NOT rely on an unencoded manual Docker build-target
setting or on topology constants that Railway turns into deploy-page prompts.
The selected application service SHALL be selectable by a public image source or
by an equivalent platform setting that is captured in the published template.
The user-facing deploy button SHALL NOT be published with a placeholder template
code.

The user-facing template SHALL use a source that an arbitrary Railway user can
deploy without organization-specific repository or registry access. Local-upload
services MAY be used for runtime proof, but SHALL NOT be published as the
user-facing template source. Private GitHub repositories and private container
images SHALL NOT be used for the public button unless the template intentionally
and safely supplies reusable public access; this template SHALL NOT embed private
registry credentials.

#### Scenario: Template service selection is encoded by public image source

- **WHEN** the Railway Template defines the selected pushbutton app service
- **THEN** the app service SHALL reference the public `railway-core` image or an equivalent reusable public source
- **AND** the image SHALL run the console plus private loopback AS/RS listeners
- **AND** the template SHALL NOT require the deploying operator to set a manual Docker target stage or AS/RS topology values after clicking the deploy button

#### Scenario: Template variables are sufficient for first boot

- **WHEN** an operator deploys from the published Railway Template
- **THEN** the template SHALL define the composed-mode public origin, owner password, and Postgres database binding needed for first boot
- **AND** AS/RS topology constants SHALL stay internal to the image/supervisor rather than becoming deploy-page prompts
- **AND** the core service SHALL be the only internet-reachable application origin

#### Scenario: Template source is reusable by arbitrary Railway users

- **WHEN** the template is published for user-facing deployment
- **THEN** the app service SHALL reference a public repository source or a public anonymously pullable image
- **AND** upload-only services SHALL NOT be used as the public template source
- **AND** private source credentials SHALL NOT be embedded in the template

#### Scenario: User-facing button is only published after template validation

- **WHEN** the template owner publishes the Railway Template
- **THEN** the owner SHALL deploy a scratch project from the published template and run the live smoke plus restart smoke before presenting the button to users
- **AND** the user-facing button URL SHALL contain Railway's assigned template code, not a placeholder

### Requirement: Canonical retained-history compaction SHALL be opt-in and convergence-preserving

The reference implementation SHALL support an explicit canonical retained-history compaction mode for streams whose compaction policy declares a semantic immutable change model and a current-row representative policy.

Canonical compaction SHALL use the same canonical record fingerprint definition as the connector runtime's no-op emit suppression for the same `(connector_id, stream)`. The canonical fingerprint SHALL remove only the policy-declared non-versioning fields and SHALL preserve real record-field changes as retained version boundaries.

Canonical compaction SHALL keep the current `records.version` row for the current same-fingerprint run, SHALL preserve tombstones and resurrection boundaries, SHALL preserve every distinct canonical fingerprint boundary, SHALL NOT renumber surviving versions, and SHALL NOT apply to streams without an explicit canonical eligibility policy.

Default historical compaction SHALL remain audit mode. Audit mode SHALL keep its existing conservative retention behavior unless canonical mode is requested and the stream is eligible.

#### Scenario: Ineligible stream fails closed

- **WHEN** an operator requests canonical compaction for a stream without `changeModel: "immutable_semantic"` and `representativePolicy: "current"`
- **THEN** the compaction tool refuses the canonical apply instead of deleting retained versions

#### Scenario: Immutable duplicate versions converge to the current semantic survivor

- **WHEN** an eligible immutable stream has multiple non-tombstone retained versions for the same key with the same canonical fingerprint
- **THEN** canonical compaction retains the current `records.version` row for that same-fingerprint run and removes the redundant retained history rows

#### Scenario: Real version boundaries survive

- **WHEN** an eligible immutable stream has retained versions for the same key with distinct canonical fingerprints
- **THEN** canonical compaction retains a survivor for each distinct canonical fingerprint boundary

#### Scenario: Tombstones and resurrections survive

- **WHEN** an eligible stream history contains a tombstone or a non-tombstone resurrection after a tombstone
- **THEN** canonical compaction retains the tombstone and the resurrection boundary

#### Scenario: Default compaction remains conservative

- **WHEN** the operator runs the compaction tool without canonical mode
- **THEN** the tool uses audit-mode retention rules and does not apply canonical-mode deletion rules

#### Scenario: Copied database validates destructive apply

- **WHEN** a stream is proposed for live canonical apply
- **THEN** the operator first validates the canonical dry-run and apply path on a copied or narrowed database and confirms no current row is orphaned before approving live mutation

### Requirement: Record-version churn rows SHALL carry a reference-derived remediation disposition

Each row of the owner-only `GET /_ref/records/version-stats` envelope SHALL carry
a reference-derived `version_remediation` that names the operator's available
next action for the row's retained history. This is orthogonal to
`version_disposition` (which classifies *why* the history exists);
`version_remediation` classifies *what the operator does about it*. The
remediation SHALL be one of:

- `none` — no operator action is available or warranted from this surface. The
  retained history is already minimal, is an actionable compaction candidate
  whose read-only dry-run command is the action, or is expected recurring history
  with no pending owner decision.
- `content_fingerprint_pending` — the stream is fingerprint-correct on its
  run-clock field but its retained history remains non-minimal until the
  connector emits a stable content fingerprint that lets the volatile
  acquisition or blob-identity fields be excluded losslessly. Running the
  existing compaction dry-run frees nothing; the durable remediation is connector
  work tracked by a separate change.
- `owner_migration_pending` — the retained history is the sole surviving copy of
  real observations that SHALL be migrated into their canonical append-keyed
  stream before the entity history could be collapsed. Compaction is not the
  remediation, and collapsing the row before the migration would destroy real
  history; the row carries a pending owner-gated data migration.
- `owner_retention_policy` — expected recurring history whose only open lever is
  an owner retention-policy decision (for example, whether to bound an
  unbounded-growth snapshot stream). This is not a defect and the owner MAY
  decline it.

The `version_remediation` SHALL be **derived by the reference implementation**
from signals it controls — the row's already-derived `version_disposition` and
reference-maintained `(connector, stream)` lists naming the
content-fingerprint-pending streams, the owner-migration-pending streams, and the
owner-retention-policy streams. A connector SHALL NOT be able to set, override,
or suppress a row's `version_remediation` through any manifest field or emitted
payload.

The derivation SHALL be consistent with the row's `version_disposition`: a row
classified `owner_retention_policy` SHALL also be classified
`recurring_point_in_time_snapshot`; a row classified
`active_defect_or_unclassified` or `lossless_compaction_candidate` SHALL be
classified `none`. A row SHALL NOT receive a `version_remediation` that
contradicts its `version_disposition`.

The `version_remediation` SHALL be a label only. It SHALL NOT alter the numeric
`risk_thresholds`, the computed `risk_level`, the `risk_reasons`, or the
`version_disposition`. The envelope SHALL make this threshold- and
disposition-independence explicit so a reader cannot mistake remediation for a
threshold or disposition override.

#### Scenario: Owner lists version churn stats with remediation

- **WHEN** an owner-authenticated caller requests `GET /_ref/records/version-stats`
- **THEN** each returned row SHALL include a reference-derived
  `version_remediation` that is one of `none`, `content_fingerprint_pending`,
  `owner_migration_pending`, or `owner_retention_policy`
- **AND** the response SHALL NOT include raw `record_json`, raw
  `record_changes.record_json`, credentials, or connector payload bodies.

#### Scenario: A fingerprint-pending residue stream names the connector fix

- **WHEN** a stream on the reference-maintained content-fingerprint-pending list
  (a statement stream whose blob-identity churn is run/acquisition noise but
  whose connector does not yet emit a content fingerprint — for example
  `chase/statements` or `usaa/statements`) crosses a churn threshold and is
  classified `reviewed_historical_residue`
- **THEN** the reference SHALL classify the row `content_fingerprint_pending`
- **AND** the row's `version_disposition` SHALL remain `reviewed_historical_residue`
  (remediation does not change disposition).

#### Scenario: A migration-pending residue stream is not offered compaction as the fix

- **WHEN** a stream on the reference-maintained owner-migration-pending list
  (an entity stream whose retained history is the sole surviving copy of
  pre-split real observations — for example `usaa/accounts`) crosses a churn
  threshold
- **THEN** the reference SHALL classify the row `owner_migration_pending`
- **AND** the row SHALL be distinguishable from a content-fingerprint-pending
  residue row even when both share the `reviewed_historical_residue` disposition.

#### Scenario: A recurring snapshot stream names the owner retention decision

- **WHEN** a stream classified `recurring_point_in_time_snapshot` is on the
  reference-maintained owner-retention-policy list (`claude-code/sessions` or
  `codex/sessions`)
- **THEN** the reference SHALL classify the row `owner_retention_policy`
- **AND** the row SHALL NOT count toward the operator "needs review" signal,
  because the only open lever is a decline-able owner retention-policy decision.

#### Scenario: A row with no available action is remediation none

- **WHEN** a row is classified `lossless_compaction_candidate`,
  `active_defect_or_unclassified`, or `point_in_time_retained_history` and is not
  named on any remediation list
- **THEN** the reference SHALL classify the row `version_remediation` `none`
- **AND** `none` SHALL mean this surface offers no further action for the row,
  not that the retained history is absent.

#### Scenario: A connector cannot self-declare its remediation

- **WHEN** a connector manifest or emitted record payload contains a field that
  attempts to assert a stream's churn remediation
- **THEN** the reference SHALL ignore that field when deriving
  `version_remediation`
- **AND** the derived remediation SHALL depend only on reference-controlled
  signals (the row's `version_disposition` and the reference-maintained
  remediation lists).

#### Scenario: Remediation does not change the risk thresholds or disposition

- **WHEN** the reference derives a `version_remediation` for a row
- **THEN** the row's `risk_level`, `risk_reasons`, `versions_per_record`, and
  `version_disposition` SHALL be computed exactly as they are without remediation
- **AND** the envelope's `risk_thresholds` SHALL be unchanged
- **AND** the envelope SHALL assert that remediation does not affect the
  thresholds.

### Requirement: Owner-session connection revoke and delete SHALL reuse the owner-agent cascade implementation

The reference implementation SHALL expose owner-session reference-control routes to revoke and to delete one configured connection so the operator console can act on a connection without an owner-agent bearer. These routes SHALL be reference-only, owner-session authenticated, and SHALL NOT be reachable over `/mcp` or with a grant-scoped token. They SHALL delegate to the same connector-instance store primitives and the same non-secret audit emission as the owner-agent bearer revoke and delete routes, so that the console path and the agent path share one cascade implementation per action rather than a duplicate Console-only path.

Revoke SHALL remain zero-cascade: it SHALL flip exactly one connector instance to `revoked`, preserving that connection's already-collected records, grants, and audit, and SHALL NOT widen to sibling connections. Delete SHALL remain the connection-scoped destructive purge of exactly one connection's source-of-truth records and configured state defined by the shipped delete contract, SHALL refuse a connection with an active run and a default-account binding with the existing typed errors, and SHALL preserve the audit spine, disclosure grants, and sibling connections. Each owner-session action SHALL emit the same non-secret audit event type as its bearer sibling, including actor kind, target connection identity, operation, and outcome, without logging session credentials, provider secrets, or record contents.

#### Scenario: Owner-session revoke flips one instance through the shared primitive

- **WHEN** an authenticated owner session requests revoke for one resolved connection over the reference-control route
- **THEN** the reference SHALL flip exactly that connector instance to `revoked` through the same store primitive the owner-agent bearer revoke route uses
- **AND** it SHALL preserve that connection's already-collected records, grants, and audit and SHALL NOT affect any sibling connection
- **AND** it SHALL emit the same non-secret revoke audit event type as the bearer route without logging session credentials or provider secrets

#### Scenario: Owner-session delete delegates to the shared delete cascade

- **WHEN** an authenticated owner session requests delete for one resolved connection over the reference-control route
- **THEN** the reference SHALL erase exactly that connection's source-of-truth records and configured state through the same `deleteConnection` cascade the owner-agent bearer delete route uses
- **AND** it SHALL refuse a connection with an active run or a default-account binding with the existing typed errors
- **AND** it SHALL preserve the audit spine, disclosure grants, and sibling connections, and SHALL emit the same non-secret delete audit event type as the bearer route

#### Scenario: The owner-session routes reject non-owner-session callers

- **WHEN** a request to the owner-session revoke or delete connection route lacks a valid owner session
- **THEN** the reference SHALL reject it
- **AND** defining these owner-session routes SHALL NOT make any revoke or delete capability reachable over `/mcp` or with a grant-scoped token
