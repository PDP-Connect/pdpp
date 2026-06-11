# polyfill-runtime Specification

## Purpose
TBD - created by archiving change add-connector-refresh-policy-controls. Update Purpose after archive.
## Requirements
### Requirement: Polyfill manifests MAY declare refresh policy hints

First-party polyfill connector manifests MAY declare `capabilities.refresh_policy` as reference/runtime metadata describing recommended scheduling posture. These hints SHALL NOT be treated as finalized PDPP core protocol semantics in this tranche.

#### Scenario: Connector declares a refresh policy
- **WHEN** a polyfill manifest includes `capabilities.refresh_policy`
- **THEN** the policy SHALL identify a recommended mode and an owner-readable rationale
- **AND** it MAY include recommended interval, minimum interval, maximum staleness, interaction posture, session lifetime, rate-limit sensitivity, bot-detection sensitivity, background-safety hints, and an assisted-after-owner-auth hint

#### Scenario: Connector has high human-interaction friction
- **WHEN** a connector commonly requires OTP, credentials, or manual browser action
- **THEN** its refresh policy SHOULD recommend manual refresh or conservative automatic scheduling with assisted-after-owner-auth posture
- **AND** the rationale SHOULD explain the human-attention cost

#### Scenario: Connector has low interaction cost
- **WHEN** a connector can refresh safely with durable credentials, local files, or low-friction API access
- **THEN** its refresh policy MAY recommend automatic refresh with an appropriate interval

#### Scenario: A future spec wants portable scheduling semantics
- **WHEN** refresh policy hints need to become interoperable across implementations
- **THEN** the vocabulary SHALL be promoted through a separate Collection Profile or companion-spec change
- **AND** this reference/polyfill metadata SHALL NOT be retroactively treated as normative PDPP core protocol

### Requirement: Browser-backed connectors SHALL acquire browsers exclusively through the isolated patchright launcher

The polyfill-connector runtime SHALL provide exactly one browser-launch primitive (`acquireIsolatedBrowser`) that launches a per-connector patchright Chromium with an isolated profile directory. Browser-backed connectors and operator tools SHALL NOT use a long-lived shared Chromium daemon, CDP-attach, or a shared profile directory across connectors.

#### Scenario: A browser-backed connector run launches a browser
- **WHEN** the runtime begins a browser-backed connector run
- **THEN** it SHALL call the isolated patchright launcher with a per-connector profile name
- **AND** the launcher SHALL create or reuse a profile directory under `~/.pdpp/profiles/<profile-name>/`
- **AND** it SHALL NOT read or write `~/.pdpp/browser-daemon.json`
- **AND** it SHALL NOT call `chromium.connectOverCDP`.

#### Scenario: An operator tool needs a browser
- **WHEN** an operator-side script under `bin/` needs a Chromium context
- **THEN** it SHALL acquire that context through the same isolated patchright launcher
- **AND** it SHALL NOT spawn or attach to a separate browser-daemon process.

#### Scenario: Two connectors run in parallel
- **WHEN** the runtime executes two different browser-backed connectors concurrently
- **THEN** each connector SHALL receive an independent profile directory
- **AND** neither connector SHALL share cookies, localStorage, or fingerprint state with the other.

### Requirement: The runtime SHALL NOT expose browser-daemon lifecycle commands

The polyfill operator surface SHALL NOT advertise or implement commands to start, stop, restart, query, or tail logs for a long-lived shared browser process. Operator-facing browser commands SHALL NOT exist as a documented or functional CLI surface.

#### Scenario: An operator inspects the polyfill CLI surface
- **WHEN** an operator views `pdpp-connectors --help` or any equivalent help output
- **THEN** there SHALL be no `browser start`, `browser stop`, `browser status`, `browser restart`, `browser logs`, `browser bootstrap`, or `browser probe` subcommand.

#### Scenario: A doc references the legacy daemon
- **WHEN** any user-facing doc, runbook, or design note in the active set references the daemon CLI
- **THEN** the reference SHALL be removed or marked superseded
- **AND** the recommended path SHALL point to per-connector auto-login plus `INTERACTION kind=credentials` for initial credentialing.

### Requirement: Multi-account support SHALL be enabled by per-subject profile keys

The polyfill-runtime SHALL be extensible to support multiple owner accounts per platform without sharing browser profile state across accounts. The default profile-name derivation SHALL be replaceable with a per-subject derivation when multi-account support ships.

#### Scenario: Single-account default (current tranche)
- **WHEN** a browser-backed connector does not supply an explicit `profileName`
- **THEN** the runtime SHALL default to `profileName = <connector-name>`
- **AND** this is acknowledged as single-account by design.

#### Scenario: Multi-account derivation (future tranche)
- **WHEN** multi-account support is enabled in a later change
- **THEN** the default `profileName` derivation SHALL include a stable subject identifier
- **AND** two accounts on the same platform SHALL receive independent profile directories
- **AND** they SHALL be safe to run concurrently without collision on Chromium's per-profile `SingletonLock`.

### Requirement: Runtime SHALL enforce the `resources` filter on every RECORD
The polyfill runtime SHALL reject any RECORD whose key is not in the grant's declared `resources` set for that stream, if the set is non-empty.

#### Scenario: Connector emits a record outside the declared resources set
- **WHEN** a connector emits a RECORD whose `key` is not present in `START.scope.streams[].resources`
- **THEN** the runtime SHALL raise a protocol violation and terminate the run
- **AND** the error SHALL name the offending stream and key

#### Scenario: Empty resources set is a no-op
- **WHEN** `START.scope.streams[].resources` is absent or empty
- **THEN** the runtime SHALL NOT filter records by key for that stream

### Requirement: Runtime SHALL expose a `filesystem` binding for local-file connectors
The polyfill runtime SHALL include a `filesystem` binding in `buildAvailableBindings` so connectors that parse local files (e.g. Claude Code sessions, Codex rollouts, iMessage sqlite, WhatsApp exports) satisfy their `runtime_requirements.bindings.filesystem.required: true` declaration.

#### Scenario: File-based connector starts successfully
- **WHEN** a manifest declares `runtime_requirements.bindings.filesystem.required: true` and the runtime spawns the connector
- **THEN** the runtime SHALL treat `filesystem` as available
- **AND** the connector SHALL NOT fail with "Runtime cannot satisfy required binding: filesystem"

### Requirement: Connectors SHALL emit tombstones for mutable_state streams that expose deletion
When a source platform exposes a "deleted" signal on a stream whose `semantics` is `mutable_state`, the connector SHALL emit a RECORD with `op: "delete"` for the tombstoned key.

#### Scenario: Mutable-state deletion
- **WHEN** the upstream reports that a record has been deleted (e.g. YNAB `deleted: true`, Notion archived page, Pocket `status: 2`, Gmail EXPUNGE)
- **THEN** the connector SHALL emit `{type: "RECORD", stream, key, op: "delete"}`
- **AND** the runtime SHALL persist the tombstone so downstream consumers can observe the deletion

#### Scenario: Append-only streams
- **WHEN** a stream's `semantics` is `append_only`
- **THEN** the connector SHALL NOT emit tombstones (there is no deletion on append-only data)

### Requirement: Connectors SHALL request credentials via INTERACTION when missing
When a connector starts and required credentials are absent from its environment, the connector SHALL emit `INTERACTION kind: "missing_credentials"` rather than failing silently.

#### Scenario: Missing credentials with interactive binding
- **WHEN** a connector is spawned with `interactive: {}` in its bindings and its required credentials env vars are unset
- **THEN** the connector SHALL emit an INTERACTION with `kind: "missing_credentials"` and a human-readable `message` explaining which env vars are needed
- **AND** the runtime SHALL park the run until the interaction is answered or the grant expires

#### Scenario: Missing credentials without interactive binding
- **WHEN** a connector is spawned without `interactive: {}` and credentials are missing
- **THEN** the connector SHALL emit DONE with status `failed` and an error message naming the missing credentials
- **AND** the run SHALL NOT hang waiting for an unavailable interaction channel

### Requirement: Connectors SHALL drain stdout before exiting
Connectors SHALL call a `flushAndExit(code)` helper (or equivalent) that waits for the Node stdout `drain` event before invoking `process.exit`, with a bounded safety timeout.

#### Scenario: Final DONE message on a pipe
- **WHEN** a connector emits its terminal DONE and then exits
- **THEN** the stdout pipe to the runtime SHALL NOT be closed before the final newline-delimited message is flushed
- **AND** the runtime SHALL observe a well-formed DONE (no truncation, no "Unterminated string in JSON" parser error)

#### Scenario: Safety timeout
- **WHEN** the stdout drain never fires (e.g. consumer died)
- **THEN** the connector SHALL exit after a bounded timeout (≤ 3 seconds) rather than hanging indefinitely

### Requirement: Connectors declaring manifest streams SHALL validate emitted records or be on a justified schemaless allowlist

A first-party polyfill connector whose manifest declares one or more streams SHALL wire emit-time record validation into its runtime entrypoint (`runConnector({ ..., validateRecord })`, conventionally built with `makeValidateRecord` over a `schemas.ts` registry), OR SHALL appear on an explicit schemaless allowlist with a per-connector justification.

This requirement is reference-implementation authoring policy and CI tooling. It
SHALL NOT be treated as PDPP Core protocol semantics or as a Collection Profile
runtime requirement: the runtime entrypoint's `validateRecord` parameter remains
optional so the framework can still execute a zero-dependency connector. The
requirement constrains how first-party connectors are authored and how the
reference build verifies them, not what a conformant resource server or
Collection Profile implementation must do.

A build-time check SHALL enforce this invariant in the path CI already runs, and
SHALL fail with the offending connector name when the invariant is violated.

#### Scenario: A connector declares manifest streams and wires validation

- **WHEN** a connector's manifest declares one or more streams
- **AND** the connector wires `validateRecord` into its `runConnector` entrypoint
- **THEN** the build-time check SHALL pass for that connector
- **AND** the connector SHALL NOT appear on the schemaless allowlist.

#### Scenario: A new connector declares streams but omits validation

- **WHEN** a connector's manifest declares one or more streams
- **AND** the connector does not wire `validateRecord`
- **AND** the connector is not on the schemaless allowlist
- **THEN** the build-time check SHALL fail and name that connector
- **AND** the failure message SHALL direct the author to either wire validation
  or add a justified allowlist entry.

#### Scenario: An allowlisted connector adds validation later

- **WHEN** a connector that is on the schemaless allowlist begins wiring
  `validateRecord`
- **THEN** the build-time check SHALL fail until the connector's allowlist entry
  is removed
- **AND** the allowlist SHALL therefore only ever shrink as connectors adopt
  validation.

#### Scenario: A connector declares no streams

- **WHEN** a connector's manifest declares zero streams
- **THEN** the build-time check SHALL NOT require validation wiring for that
  connector
- **AND** the connector SHALL NOT be required to appear on the allowlist.

#### Scenario: The schemaless allowlist carries justifications

- **WHEN** a connector is on the schemaless allowlist
- **THEN** its entry SHALL carry an owner-readable justification identifying why
  validation is not yet wired and the remediation path
- **AND** the allowlist SHALL be the authoritative, machine-checked census of
  connectors that emit records without emit-time shape validation.

### Requirement: Connector manifest stream schema SHALL declare and validate coverage_policy

The `packages/reference-contract` manifest stream schema SHALL include
`coverage_policy` as an optional field with a closed enum of accepted values:
`collect`, `deferred`, `inventory_only`, `unavailable`, and `unsupported`.

The field SHALL be optional; absence is treated as `collect` (the default, "this
stream is intended to be fully collected"). A connector author declaring a stream
as `unsupported` or `unavailable` SHALL also set `required: false` to avoid a
contradictory manifest signal (`required: true` + accepted-coverage policy
degrades health rather than projecting accepted-coverage-green).

#### Scenario: manifest schema accepts all valid coverage_policy values

**WHEN** a manifest stream declares `coverage_policy` with one of `collect`,
`deferred`, `inventory_only`, `unavailable`, or `unsupported`
**THEN** the reference-contract schema validation SHALL accept the manifest
without error.

#### Scenario: manifest schema rejects unknown coverage_policy values

**WHEN** a manifest stream declares a `coverage_policy` value outside the
recognized enum
**THEN** the reference-contract schema validation SHALL reject the manifest with
a type error.

#### Scenario: absence of coverage_policy is valid

**WHEN** a manifest stream does not declare `coverage_policy`
**THEN** the schema SHALL accept the manifest
**AND** the server SHALL treat the stream as `collect` (fully collected by
default).

### Requirement: Connectors with a detail lane SHALL emit DETAIL_COVERAGE once per run

A connector that runs a list+detail lane SHALL emit exactly one `DETAIL_COVERAGE`
message per run, after the detail lane completes. A list+detail lane is one that
fetches a list of records and then fetches per-record detail for at least a
subset of those records. The message SHALL carry:

- `stream`: the detail stream name.
- `state_stream`: the list/parent stream whose cursor anchors the detail pass.
- `required_keys`: the full set of record keys the connector considered for
  detail fetch in this run.
- `hydrated_keys`: the subset of `required_keys` for which detail was
  successfully fetched and emitted.
- `gap_keys` (optional): keys for which a `DETAIL_GAP` was emitted.
- `optional_skip_keys` (optional): keys skipped by explicit policy (e.g.
  rate-limited voluntarily, filtered by selection scope).

Connectors that emit only flat streams with no per-record detail fetch are
exempt from this requirement.

#### Scenario: list+detail run emits DETAIL_COVERAGE after the detail lane

**WHEN** a connector completes a list+detail run
**THEN** the connector SHALL emit a `DETAIL_COVERAGE` message
**AND** the message SHALL appear after the last RECORD or DETAIL_GAP emitted by
the detail lane in the same run
**AND** `required_keys` SHALL equal the set of keys the connector scanned for
detail

#### Scenario: fully hydrated run emits DETAIL_COVERAGE with no gap_keys

**WHEN** a list+detail run completes with no DETAIL_GAP messages
**THEN** `DETAIL_COVERAGE.hydrated_keys` SHALL equal `DETAIL_COVERAGE.required_keys`
**AND** `gap_keys` SHALL be absent or empty

#### Scenario: partially hydrated run carries gap_keys matching emitted DETAIL_GAPs

**WHEN** a list+detail run emits N DETAIL_GAP messages
**THEN** `DETAIL_COVERAGE.gap_keys` SHALL contain those N keys
**AND** `hydrated_keys` SHALL NOT contain keys that also appear in `gap_keys`

### Requirement: Browser runtime SHALL bound manual-action page-metadata reads

When the browser handoff reads page metadata (e.g. `page.title()`) to attach to a manual-action interaction, the read SHALL be bounded by a local deadline so a wedged renderer cannot prevent the interaction from being emitted. The interaction SHALL still be registered and emitted with whatever metadata is available, and a metadata read that times out SHALL be surfaced as a compact diagnostic rather than swallowed.

#### Scenario: Page metadata read times out

- **WHEN** the browser handoff prepares a manual-action interaction
- **AND** the page-title read does not resolve within the bounded deadline
- **THEN** the runtime SHALL stop waiting on the title read at the deadline
- **AND** it SHALL still emit and register the interaction using the page URL and any metadata already available
- **AND** it SHALL write a compact diagnostic noting the metadata timeout

#### Scenario: Page metadata read succeeds quickly

- **WHEN** the browser handoff prepares a manual-action interaction
- **AND** the page-title read resolves within the bounded deadline
- **THEN** the runtime SHALL attach the resolved title to the interaction
- **AND** it SHALL NOT write a metadata-timeout diagnostic

### Requirement: Browser runtime SHALL checkpoint session-establishment phases with durable diagnostics

The browser runtime SHALL expose a session-establishment checkpoint hook to the connector's `ensureSession` flow and SHALL itself record framing checkpoints around session establishment. Each checkpoint SHALL update the run's last-establishment-progress marker and, when fixture/trace capture is active, SHALL trigger a best-effort durable diagnostic capture labelled for that phase, so a hang during establishment does not leave only an initial blank-page artifact.

#### Scenario: Connector marks an auth phase

- **WHEN** a connector's `ensureSession` calls the provided checkpoint hook with a phase label
- **THEN** the runtime SHALL record that label and the time it was reached as the last establishment-progress marker
- **AND** when capture is active it SHALL attempt a durable diagnostic capture for that phase
- **AND** a failure of the diagnostic capture SHALL NOT fail the run

#### Scenario: Runtime frames the establishment window

- **WHEN** the runtime begins session establishment for a browser-backed run
- **THEN** it SHALL record at least one framing checkpoint before delegating to the connector's session flow
- **AND** the connector SHALL be able to add phase checkpoints specific to its own auth state machine

### Requirement: Browser runtime SHALL bound session establishment with a fail-closed watchdog

The browser runtime SHALL bound the session-establishment phase with a watchdog keyed on checkpoint progress. If session establishment makes no checkpoint progress within a bounded, configurable deadline, the runtime SHALL finalize diagnostics, fail the run fail-closed with a terminal failure, and release the browser so the run cannot remain active indefinitely. The watchdog SHALL be paused while an interaction is open so a run legitimately waiting on the owner is not killed.

#### Scenario: Establishment stalls with no checkpoint progress

- **WHEN** session establishment makes no checkpoint progress for longer than the configured watchdog deadline
- **AND** no interaction is currently open
- **THEN** the runtime SHALL finalize trace and capture diagnostics for the in-flight run
- **AND** it SHALL emit a terminal `DONE` with status `failed` and a `*_session_establish_timeout` error
- **AND** it SHALL release the browser so the run is not left active indefinitely

#### Scenario: Establishment is making checkpoint progress

- **WHEN** session establishment reaches successive checkpoints with no gap exceeding the watchdog deadline
- **THEN** the runtime SHALL NOT trip the watchdog
- **AND** the run SHALL be allowed to proceed even if total establishment time exceeds the deadline

#### Scenario: Establishment is blocked on an open interaction

- **WHEN** session establishment is blocked waiting for an owner interaction (e.g. CAPTCHA or OTP) to resolve
- **THEN** the watchdog SHALL be paused for the duration of the open interaction
- **AND** it SHALL resume with a reset deadline once the interaction resolves

#### Scenario: Watchdog deadline is configurable

- **WHEN** `PDPP_SESSION_ESTABLISH_WATCHDOG_MS` is set to a positive integer
- **THEN** the runtime SHALL use that value as the no-progress deadline
- **AND** when it is unset the runtime SHALL use a conservative default that clears the legitimate establishment envelope of proven runs

#### Scenario: Teardown diagnostic capture is bounded

- **WHEN** the runtime captures a diagnostic page snapshot during teardown of a wedged run
- **AND** the underlying DOM capture does not resolve within a bounded deadline
- **THEN** the runtime SHALL abandon that snapshot at the deadline and continue teardown
- **AND** the diagnostic capture SHALL NOT be able to re-hang the terminal failure or browser release

### Requirement: Connectors SHALL support an owner-configured detail-lane run cap as an opt-in, default-off bound
A connector with a serial detail lane SHALL be able to bound a single run by an
owner-configured **size** cap (number of detail fetches per run) and/or **time**
cap (wall-clock the detail phase may spend), and this cap SHALL be opt-in via
environment configuration and **default off**: an unset, empty, non-numeric, or
non-positive value SHALL resolve to no cap, and with no cap configured a run SHALL
behave exactly as it would without this feature (no cap branch is consulted). A
configured cap SHALL only ever cause a run to stop *earlier*; it SHALL NOT
increase concurrency, change pacing, raise a retry budget, or cause a run to fetch
more than it otherwise would.

The cap SHALL be **run-scoped and shared** across every pass of a single run — in
particular a detail-gap recovery pass and a forward-walk pass SHALL draw down one
shared budget — so that a recovery backlog plus newly listed records are bounded
together rather than each pass receiving a fresh budget. A wall-clock cap SHALL be
measured from the first time the budget is consulted (the start of the detail
phase), not from connector startup.

When a configured cap is reached, the connector SHALL stop launching new detail
fetches and SHALL defer the current and every remaining record as a resumable
`DETAIL_GAP`, using the same deferral, cursor-commit, and recovery machinery a
source-pressure deferral uses: the hydrated prefix's cursor SHALL commit, the
deferred keys SHALL appear in `DETAIL_COVERAGE.gap_keys`, and a later run SHALL
recover the deferred records (recovery selecting gaps by stream, not by reason)
and walk forward, so a large history fills in over several bounded runs.

#### Scenario: No cap configured leaves a run unbounded and unchanged

- **WHEN** neither the size knob nor the wall-clock knob is set (or both are
  empty / non-numeric / non-positive)
- **THEN** the run SHALL resolve to no cap
- **AND** no cap branch SHALL defer any record
- **AND** a large backlog SHALL run to completion exactly as it would without the
  cap feature

#### Scenario: A configured size cap defers the remaining tail as a resumable gap

- **WHEN** a detail run is configured with a maximum number of detail fetches per
  run
- **AND** the run has hydrated that many record details
- **THEN** the connector SHALL stop launching new detail fetches
- **AND** it SHALL defer the current and every remaining record as a resumable
  `DETAIL_GAP`
- **AND** the hydrated prefix's cursor SHALL commit
- **AND** the deferred keys SHALL appear in `DETAIL_COVERAGE.gap_keys`

#### Scenario: A configured wall-clock cap is bounded by at most one in-flight fetch

- **WHEN** a detail run is configured with a maximum detail-phase wall-clock
- **AND** the elapsed detail-phase wall-clock reaches that maximum
- **THEN** the connector SHALL check the cap between fetches, never interrupting a
  fetch already in flight
- **AND** the run MAY exceed the configured wall-clock by at most one in-flight
  fetch's processing time, itself bounded by the connector's per-fetch timeout

#### Scenario: One shared budget bounds the recovery pass and the forward pass together

- **WHEN** a single run performs a detail-gap recovery pass and then a
  forward-walk pass under a configured cap
- **THEN** both passes SHALL draw down one shared run-scoped budget
- **AND** a recovery backlog larger than the cap SHALL cause the forward pass to
  defer without starting a second budget

### Requirement: An owner-configured run-cap deferral SHALL NOT be treated as source pressure
A run-cap deferral SHALL be marked as a **self-imposed bound**, distinct from a
deferral caused by account/source pressure: a `DETAIL_GAP` deferred because a run
reached its owner-configured size or time cap is not a source-pressure signal. The
run-cap deferral SHALL carry a resumable wire reason
that is **not** in the source-pressure reason set (`upstream_pressure`,
`rate_limited`), so it SHALL NOT arm the cross-run source-pressure cooldown
governor and SHALL NOT be counted in the source-pressure detail-gap backlog
rollup. The deferral SHALL additionally carry a distinct error class identifying
the configured run cap, so an owner surface can render a self-imposed cap
separately from a busy-service deferral. The run-cap deferral SHALL NOT report an
HTTP failure status, because nothing failed — the run simply stopped at its
budget.

#### Scenario: A run-cap deferral does not arm the source-pressure cooldown

- **WHEN** a connector defers records because a run reached its owner-configured
  cap
- **THEN** the deferred `DETAIL_GAP` reason SHALL NOT be in the source-pressure
  reason set
- **AND** the deferral SHALL NOT arm the cross-run source-pressure cooldown
  governor
- **AND** the deferral SHALL NOT be counted in the source-pressure detail-gap
  backlog rollup

#### Scenario: A run-cap deferral is distinguishable from a source-pressure deferral

- **WHEN** a connector defers records because a run reached its owner-configured
  cap
- **THEN** the deferral SHALL carry an error class identifying the configured run
  cap
- **AND** that class SHALL be distinct from the class a source-pressure deferral
  carries
- **AND** the deferral SHALL NOT report an HTTP failure status

### Requirement: Run-cap and generic retry-exhausted deferrals SHALL have distinct, honest end-user copy
The end-user display copy SHALL be distinct for the generic retry-exhausted wire
reason and for the configured run-cap error class, and neither SHALL imply that the
source service was busy. The generic retry-exhausted reason SHALL read as a retry
budget having been used up — applicable to any retry-exhaustion path, not only a
configured cap. The run-cap error class SHALL read as a self-imposed per-run
budget that saved what it collected and will continue on the next run. Copy that
implies source pressure (for example "the service is busy") SHALL be reserved for
the source-pressure reasons.

#### Scenario: Run-cap copy names a self-imposed budget without implying source pressure

- **WHEN** an owner surface renders the copy for a configured run-cap deferral
- **THEN** the copy SHALL describe a per-run budget that saved a batch and will
  continue next run
- **AND** the copy SHALL NOT imply that the source service was busy or pressured

#### Scenario: Generic retry-exhausted copy is not specific to a configured cap

- **WHEN** an owner surface renders the copy for the generic retry-exhausted
  reason
- **THEN** the copy SHALL describe a retry budget that was used up
- **AND** the copy SHALL NOT be byte-identical to the configured run-cap copy
- **AND** the copy SHALL NOT imply that the source service was busy or pressured

### Requirement: A run-cap tail deferral SHALL bound its own foreground materialization

A run-cap trip SHALL bound the **foreground work of materializing the deferral
itself** when the remaining record tail is larger than an owner-configurable
finite chunk: the connector SHALL write at most the configured chunk of
per-record resumable `DETAIL_GAP` rows, then fold every older remaining record
into **one** durable backlog `DETAIL_GAP` carrying a content-derived list cursor
/ watermark (never a positional offset) for the un-materialized remainder. A run
SHALL NOT spend a long foreground stretch writing one gap row per remaining
record after it has already stopped fetching details.

This chunk SHALL be **opt-in and default off**: an unset chunk SHALL leave the
per-record deferral behavior byte-for-byte unchanged. When only a fetch/time cap
is configured (and no explicit chunk), the connector MAY derive a safe finite
chunk so an owner who opts into a run cap also gets a bounded tail. The backlog
gap SHALL reuse the run-cap deferral contract — a resumable reason outside the
source-pressure set and the run-cap error class — so it never arms the
source-pressure cooldown and is excluded from the source-pressure backlog rollup.

The deferral SHALL remain **resumable and convergent**: a later run's recovery
SHALL expand the backlog gap by re-listing the parent list at-or-older than the
stored inclusive watermark and materializing the next bounded chunk of that
window, resolving or rewriting the backlog gap with a new content-derived
watermark when remainder exists, and this expansion SHALL run before forward-walk
work so the deferred tail recovers first. The inclusive bound SHALL be
tie-safe: recovery MAY re-see an already-accounted record sharing the boundary
timestamp, but SHALL NOT strand an un-materialized record with that timestamp. A
history larger than the chunk SHALL drain over several bounded runs with no
record lost and no offset reconstruction; the monotone forward cursor SHALL NOT
advance past an unaccounted record (the backlog gap accounts for the older
remainder).

#### Scenario: A cap trip over a large remaining tail writes a bounded number of gap rows

- **WHEN** a run-cap trips with a configured finite tail-deferral chunk
- **AND** the remaining record tail is larger than that chunk
- **THEN** the connector SHALL write at most the chunk of per-record `DETAIL_GAP`
  rows
- **AND** it SHALL write exactly one durable backlog `DETAIL_GAP` for the older
  remainder, carrying a content-derived watermark and not a positional offset
- **AND** the run SHALL NOT write one gap row per remaining record

#### Scenario: Default-off leaves the tail deferral unchanged

- **WHEN** no tail-deferral chunk is configured and no fetch/time cap derives one
- **THEN** a run-cap tail SHALL be materialized one resumable `DETAIL_GAP` per
  record exactly as it would without this bound (no backlog gap is written)

#### Scenario: A later run expands the backlog gap before forward work and converges

- **WHEN** a later run is served a backlog `DETAIL_GAP`
- **THEN** recovery SHALL re-list the parent list at-or-older than the backlog's
  inclusive watermark and materialize the next bounded chunk of that window
  before any forward-walk work
- **AND** it SHALL resolve the old backlog gap or rewrite it with a new
  content-derived watermark when remainder exists
- **AND** it SHALL NOT strand records that share the backlog watermark timestamp
- **AND** over several bounded runs the older history SHALL fully drain with no
  record lost and no positional-offset reconstruction

#### Scenario: A bounded tail deferral is not source pressure

- **WHEN** a connector folds a run-cap tail into per-record chunk gaps plus a
  backlog gap
- **THEN** every such gap SHALL carry a resumable reason outside the
  source-pressure reason set and the run-cap error class
- **AND** none of them SHALL arm the source-pressure cooldown governor or be
  counted in the source-pressure detail-gap backlog rollup

### Requirement: A provider request path SHALL have exactly one pre-flight send governor

SHALL the polyfill-runtime gate the velocity of requests to a single provider
through exactly ONE pre-flight send governor. The send governor is the only
component permitted to wait (sleep) before a request is transmitted. Either a
concurrency governor (AIMD lane) or a rate governor (GCRA/token-bucket) MAY be
the send governor for a given provider, but NOT both as independent pre-flight
gates. For unknown-quota providers the runtime SHALL prefer the self-calibrating
concurrency governor; a GCRA rate signal, when present, SHALL be folded into the
single governor's pre-flight wait as a delay input, NOT run as a second
independent pre-flight wait.

Run-control decision layers — the run budget (request/wall-clock cap), the
retry budget, and the circuit breaker — SHALL make synchronous admit/deny
decisions and SHALL NOT perform a pre-flight wait. Retry backoff SHALL fire only
after a failed send (post-failure), never inside the same pre-flight wait as the
send governor.

#### Scenario: One pre-flight wait source per admitted request

- **WHEN** a request to a provider is admitted and transmitted
- **THEN** exactly one pre-flight wait source SHALL have governed it (the single
  send governor)
- **AND** no decision layer (run budget, retry budget, circuit breaker) SHALL
  have added a second pre-flight wait

#### Scenario: GCRA pacing contributes a signal, not a second gate

- **WHEN** a provider has both an AIMD concurrency send governor and a GCRA
  pacing bucket configured
- **THEN** the GCRA pacing SHALL contribute its computed inter-request delay to
  the single send governor's pre-flight wait
- **AND** the effective pre-flight wait SHALL be the maximum of the governor's
  own delay and the pacing delay, NEVER their sum
- **AND** the GCRA pacing SHALL NOT perform its own pre-flight wait

#### Scenario: Two independent pre-flight gates is a spec violation

- **WHEN** a request path is composed such that both a concurrency governor and
  a rate governor independently wait before the same provider send
- **THEN** the composition SHALL be treated as a defect
- **AND** the two pre-flight waits SHALL be detectable as more than one wait
  source on the request path
- **AND** the runtime SHALL NOT ship a default configuration in which two
  pre-flight waits gate the same provider request

### Requirement: Retry-After SHALL be honored exactly without double-paying the wait

SHALL the polyfill-runtime, when a provider returns a throttle response carrying
a `Retry-After` header, wait the specified interval exactly once before
retrying. The runtime SHALL NOT add jittered backoff on top of the `Retry-After`
interval for that retry, and SHALL NOT also queue the same interval as a
pre-flight pacing wait on the next request. A throttle response MAY decrease the
send governor's fill rate (multiplicative decrease signal), but the
`Retry-After` interval itself SHALL be slept exactly once, in the retry layer.

#### Scenario: Retry-After is slept once, not stacked on backoff

- **WHEN** a request receives a retryable response with a `Retry-After` header
- **THEN** the runtime SHALL wait exactly the `Retry-After` interval before the
  retry
- **AND** it SHALL NOT add jittered exponential backoff on top of that interval
- **AND** it SHALL NOT re-impose the same interval as a pre-flight pacing wait on
  the subsequent request

#### Scenario: Throttle still feeds the fill-rate decrease signal

- **WHEN** a `Retry-After` throttle is observed and slept in the retry layer
- **THEN** the send governor's pacing fill rate MAY be decreased (one-way error
  ratchet) as a signal
- **BUT** the decrease SHALL NOT cause the slept `Retry-After` interval to be
  paid a second time

### Requirement: The retry layer SHALL bound retry volume with a ratio-based retry budget distinct from per-request attempts

SHALL the polyfill-runtime's shared retry helper accept an optional
ratio-based retry budget (a Finagle-style token bucket) that bounds total retry
*volume* across a run, distinct from and in addition to the per-request attempt
count. When a retry budget is configured and its tokens are exhausted, the retry
helper SHALL stop retrying immediately with the same terminal shape as
exhausting the per-request attempt count, so the run defers rather than spins.
When no retry budget is configured, only the per-request attempt count bounds
retries (prior behavior preserved). A retry-budget-driven stop SHALL carry a
reason that is NOT in the source-pressure reason set.

#### Scenario: Retry budget exhaustion stops retries before the attempt count

- **WHEN** a retry budget with capacity smaller than the per-request attempt
  count is configured
- **AND** a request keeps receiving retryable responses
- **THEN** the retry helper SHALL stop retrying once the retry budget is empty,
  before exhausting the per-request attempt count
- **AND** the terminal error SHALL be the same shape as attempt-count exhaustion

#### Scenario: No retry budget configured preserves attempt-count-only behavior

- **WHEN** no retry budget is configured on the retry helper
- **THEN** only the per-request attempt count SHALL bound retries
- **AND** the helper's behavior SHALL be unchanged from before a retry budget
  was available

### Requirement: 429-prone connectors SHALL route provider requests through the shared send governor and retry layer

SHALL provider connectors that previously hand-rolled `if (status === 429) throw
"<name>_rate_limited"` route their provider requests through the shared
send-governor + retry helper instead of growing local rate-handling code. The
shared helper SHALL preserve each connector's terminal rate-limit error string
so the runtime `retryablePattern` cross-run source-pressure deferral and
cooldown contract is unchanged. A connector MAY configure the helper with a
single bounded attempt so its immediate-throw behavior is byte-identical while
the Retry-After-honor capability is wired and available behind that configured
attempt count.

#### Scenario: Terminal rate-limit preserves the cross-run cooldown contract

- **WHEN** a migrated connector exhausts its retries against a 429
- **THEN** the shared helper SHALL throw the connector's existing
  `<name>_rate_limited` terminal error
- **AND** that error SHALL match the connector's `retryablePattern`
- **AND** the cross-run source-pressure cooldown SHALL arm exactly as it did
  before the migration

#### Scenario: A single bounded attempt preserves immediate-throw behavior

- **WHEN** a migrated connector configures the shared helper with one bounded
  attempt
- **AND** a provider returns 429
- **THEN** the helper SHALL make exactly one provider call and throw the terminal
  rate-limit error immediately
- **AND** raising the attempt count SHALL activate inline Retry-After honor and
  bounded backoff without changing the terminal contract

### Requirement: Budget-exhaustion defer reasons SHALL be disjoint from source-pressure reasons

SHALL every reason with which the shared provider-budget controller defers a run
(request-cap reached, wall-clock deadline, retry-budget exhausted, circuit open)
be disjoint from the source-pressure reason set that arms the cross-run cooldown
governor. Budget exhaustion is a planned stop, not a provider-driven rejection,
and SHALL NOT be misread as source pressure by the scheduler.

#### Scenario: No budget-exhaustion reason arms the source-pressure cooldown

- **WHEN** a run defers because a provider-budget axis is exhausted (request cap,
  wall-clock, retry budget, or open circuit)
- **THEN** the defer reason SHALL NOT be a member of the source-pressure reason
  set
- **AND** the cross-run source-pressure cooldown governor SHALL NOT be armed by
  that deferral

### Requirement: The shared connector HTTP governor SHALL provide adaptive, fastest-safe collection by default

The shared API-connector HTTP governor (`createConnectorHttpGovernor`) SHALL,
when constructed with only a connector name, yield an adaptive rate controller:
it SHALL enter from a conservative slow-start discovery interval, accelerate
under sustained success (AIMD additive increase toward the rate ceiling), and
back off multiplicatively on a throttle signal — never crossing the
owner-authored rate ceiling. A connector author SHALL obtain this behavior with
no per-connector rate code beyond the bare factory call. The factory SHALL also
provide an explicit opt-out (a zero discovery interval) that disables pacing
entirely and preserves the pre-convergence byte-identical no-wait path.

#### Scenario: A bare governor cold-starts adaptive

- **WHEN** a connector constructs the governor with only its name
- **THEN** the governor SHALL cold-start at the shared conservative discovery
  interval
- **AND** its live rate snapshot SHALL be available (pacing is on by default)

#### Scenario: Sustained success accelerates the rate toward the ceiling

- **WHEN** the governor records a sequence of successful responses
- **THEN** the inter-request interval SHALL monotonically shrink (the rate rises)
- **AND** it SHALL never shrink below the rate ceiling

#### Scenario: A throttle backs the rate off and the back-off is legible

- **WHEN** the governor records a throttle signal
- **THEN** the inter-request interval SHALL increase (the rate slows)
- **AND** the back-off SHALL be visible in the governor's rate snapshot as a
  legible event with its reason

#### Scenario: A connector opts out of pacing

- **WHEN** a connector constructs the governor with a zero discovery interval
- **THEN** the governor SHALL perform no pre-flight pacing wait
- **AND** its rate snapshot SHALL be absent (no adaptive controller exists)

### Requirement: The shared governor SHALL expose a warm-start runtime seam so the learned rate compounds across runs

The shared governor SHALL accept a restored learned interval at construction
(seeding the controller warm-started, clamped to never be faster than the rate
ceiling) and SHALL expose a snapshot of its learned interval for persistence.
The runtime SHALL provide framework-owned helpers — restore (applying a staleness
guard), persist (durable state fields), and observability — so a connector author
threads only its durable state location and never hand-rolls the read/write or
the staleness logic. Warm-start state SHALL be persisted onto a declared stream
cursor (the runtime gates connector STATE on declared streams); a connector SHALL
NOT persist warm-start state under a synthetic, undeclared stream.

#### Scenario: A fresh resume restores the prior run's learned interval

- **WHEN** a run persists its learned interval and the next run restores it
  within the staleness window
- **THEN** the next run's controller SHALL warm-start FROM the restored interval,
  not the cold discovery seed

#### Scenario: A stale resume cold-starts conservatively

- **WHEN** a persisted learned interval is older than the staleness guard, or is
  absent or malformed
- **THEN** the restore SHALL yield nothing and the controller SHALL cold-start at
  the conservative discovery interval

#### Scenario: Warm-start state rides a declared stream cursor

- **WHEN** a connector persists its learned interval for warm-start
- **THEN** it SHALL merge the pacing fields onto an already-declared stream's
  cursor
- **AND** it SHALL NOT emit STATE for a synthetic stream the run never declared

### Requirement: The adaptive controller's live rate SHALL be legible for every governor-using connector

Any connector using the shared governor SHALL be able to emit its controller's
live rate as the redacted `collection_rate` run-trace progress via a single
framework-owned helper, so an operator can watch the controller speed up and back
off. The emitted rate state SHALL carry no account or content data — only rate
numbers (current and ceiling interval / effective rate) and the last back-off
reason. When pacing is opted out, the helper SHALL yield an explicit absence
rather than a false zero rate.

#### Scenario: Rate state is emitted as redacted progress

- **WHEN** a governor-using connector surfaces its controller state
- **THEN** the emitted `collection_rate` SHALL carry the current and ceiling
  interval, the corresponding rates per minute, and the last back-off reason
- **AND** it SHALL carry no account/content fields

#### Scenario: Absent controller reads as honest unknown

- **WHEN** the connector has opted out of pacing
- **THEN** the observability helper SHALL yield an explicit absence
- **AND** it SHALL NOT emit a false zero rate

