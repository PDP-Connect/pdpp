# polyfill-runtime Specification Delta

## ADDED Requirements

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
