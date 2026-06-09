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

