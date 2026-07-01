# reference-run-assistance Specification

## Purpose
TBD - created by archiving change define-run-assistance-state-contract. Update Purpose after archive.
## Requirements
### Requirement: Run assistance separates progress, action, and response obligation
The reference runtime SHALL represent owner assistance with structured fields that distinguish progress posture, owner action, response obligation, attachments, and sensitivity. The reference runtime SHALL NOT collapse all owner involvement into a single generic human-help state.

#### Scenario: External approval is observable by the connector
- **WHEN** a connector detects that the owner must approve an app, device, or website prompt outside PDPP and the connector can observe completion by polling
- **THEN** the reference SHALL represent the assistance as progress posture `running`, owner action `act_elsewhere`, and response obligation `none`
- **AND** the reference SHALL NOT require a submitted interaction response solely to continue polling

#### Scenario: OTP requires submitted owner input
- **WHEN** a connector needs the owner to enter a one-time verification code
- **THEN** the reference SHALL represent the assistance as progress posture `blocked`, owner action `provide_value`, and response obligation `response_required`
- **AND** the assistance SHALL mark the submitted value as secret

#### Scenario: Backoff does not require owner action
- **WHEN** a connector is waiting for a retry, rate-limit, or scheduled backoff and no owner action is useful
- **THEN** the reference SHALL represent the run with progress posture `waiting_retry`, owner action `none`, and response obligation `none`
- **AND** the dashboard SHALL NOT render a browser-control or input-submit call to action

### Requirement: Assistance attachments are optional and typed
The reference runtime SHALL model browser streaming, URLs, QR codes, file prompts, and fixtures as optional typed attachments to an assistance request. The generic assistance contract SHALL NOT expose Playwright `Page`, CDP WebSocket URLs, n.eko stream URLs, or other browser-control implementation details as generic assistance fields.

#### Scenario: Browser control is required
- **WHEN** a connector requires the owner to operate a live browser page
- **THEN** the reference SHALL represent the assistance as progress posture `blocked`, owner action `operate_attachment`, and response obligation `response_required`
- **AND** the assistance SHALL include a `browser_surface` attachment or explicitly report that no browser surface is available

#### Scenario: Non-browser connector uses a URL or QR attachment
- **WHEN** a connector that is not Playwright-driven asks the owner to open a URL or scan a QR code
- **THEN** the reference SHALL represent the URL or QR code as an attachment
- **AND** the assistance SHALL remain valid without any browser-surface attachment

#### Scenario: Stream attach fails
- **WHEN** an assistance request requires browser operation but browser-surface registration or minting fails
- **THEN** the reference SHALL preserve the assistance state honestly
- **AND** the dashboard SHALL show that browser control is unavailable rather than implying that the owner can complete the action through a missing stream

### Requirement: Assistance lifecycle is durable and redacted

The reference runtime SHALL expose assistance request, resolution, timeout, cancellation, and escalation transitions in the reference run timeline using safe machine-readable metadata. The reference timeline SHALL NOT persist submitted secrets, raw bearer URLs, durable credentials, or sensitive attachment payloads.

#### Scenario: Background auth repair is required but not attempted

- **WHEN** a non-manual run detects that a source session is inactive and that repair requires owner participation
- **THEN** the run SHALL record bounded terminal evidence that classifies the failure as credential or source-session repair
- **AND** the run SHALL NOT emit repeated owner assistance or interaction prompts from the automatic path

#### Scenario: Stored credential is rejected before assistance

- **WHEN** a connector receives a connection-scoped stored credential and the provider definitively rejects it
- **THEN** the run SHALL record bounded terminal evidence with a stable non-secret credential-rejection code
- **AND** it SHALL NOT ask the owner for unrelated app approval, OTP, or browser assistance for that same rejected credential attempt

#### Scenario: Owner manual repair uses browser session

- **WHEN** an owner-attended browser-session repair starts without an active stored login credential
- **THEN** the reference MAY ask the owner to operate the secure browser
- **AND** the resulting repair SHALL be represented as browser-session state unless the owner explicitly submits a stored-credential capture flow.

### Requirement: Dashboard assistance UX is derived from state
The reference dashboard SHALL derive assistance copy and controls from the structured assistance fields and run terminal state rather than from connector-specific string matching or from the presence of a pending interaction alone.

#### Scenario: Owner must approve elsewhere
- **WHEN** the current assistance has progress posture `running`, owner action `act_elsewhere`, and response obligation `none`
- **THEN** the dashboard SHALL show passive waiting copy that explains the external approval
- **AND** it SHALL NOT show a required browser-stream or submit button unless an explicit fallback state is active

#### Scenario: Owner must provide a value
- **WHEN** the current assistance has progress posture `blocked`, owner action `provide_value`, and response obligation `response_required`
- **THEN** the dashboard SHALL render an input form derived from the assistance schema
- **AND** it SHALL treat secret inputs as ephemeral run responses rather than durable credentials

#### Scenario: Owner must operate a browser surface
- **WHEN** the current assistance has progress posture `blocked`, owner action `operate_attachment`, response obligation `response_required`, and a `browser_surface` attachment
- **THEN** the dashboard SHALL render the streaming companion entry point and browser-control instructions

#### Scenario: Assistance is gone because the run failed
- **WHEN** a stream companion page has no current browser assistance
- **AND** the run terminal status is `failed`, `cancelled`, or `abandoned`
- **THEN** the dashboard SHALL NOT render success or recovery copy
- **AND** it SHALL direct the owner to the run timeline for the terminal details

#### Scenario: Assistance is gone but the run is still active
- **WHEN** a stream companion page has no current browser assistance
- **AND** the run has no terminal status
- **THEN** the dashboard SHALL NOT render success or recovery copy
- **AND** it SHALL explain that no browser action is waiting at that moment
- **AND** it SHALL revalidate the run status rather than remaining a static page

### Requirement: Existing interaction messages remain compatible during migration
The reference runtime SHALL continue accepting existing `INTERACTION` messages while mapping them into the structured assistance model for timeline and dashboard behavior.

#### Scenario: Existing OTP interaction is received
- **WHEN** a connector emits an existing `INTERACTION` with kind `otp`
- **THEN** the reference SHALL treat it as progress posture `blocked`, owner action `provide_value`, response obligation `response_required`, and secret sensitivity

#### Scenario: Existing manual action with browser handoff is received
- **WHEN** a connector emits an existing `INTERACTION` with kind `manual_action` and a registered browser streaming target
- **THEN** the reference SHALL treat it as progress posture `blocked`, owner action `operate_attachment`, response obligation `response_required`, and a `browser_surface` attachment

#### Scenario: Existing progress message is received
- **WHEN** a connector emits `PROGRESS`
- **THEN** the reference SHALL preserve it as observability
- **AND** once structured assistance is available to a connector, owner-action cases SHALL use structured assistance rather than plain progress when the owner is expected to act

### Requirement: Runtime SHALL detect and report browser-surface availability failure during an open interaction

The reference runtime SHALL monitor the browser surface during any open interaction that requires browser control and SHALL fail the interaction fail-closed if the surface becomes unavailable before the owner responds.

#### Scenario: Surface becomes unavailable during manual_action wait
- **WHEN** a connector emits a `manual_action` INTERACTION and the browser surface passes the preflight readiness probe
- **AND** the surface becomes unreachable (CDP endpoint stops responding) before the owner submits a response
- **THEN** the reference runtime SHALL detect the surface loss via periodic polling
- **AND** it SHALL emit a `run.browser_surface_lost` event with the typed probe failure code and detail
- **AND** it SHALL resolve the interaction as `cancelled` without waiting for owner input
- **AND** it SHALL NOT deliver a response to the connector that implies the owner completed the action

#### Scenario: Surface becomes unavailable during browser-backed OTP wait
- **WHEN** a connector emits an `otp` INTERACTION with an active browser surface
- **AND** the surface becomes unreachable before the owner submits a response
- **THEN** the reference runtime SHALL detect the surface loss via periodic polling
- **AND** it SHALL emit a `run.browser_surface_lost` event with the typed probe failure code and detail
- **AND** it SHALL resolve the interaction as `cancelled` without delivering the OTP to the connector

#### Scenario: Surface loss prevents re-prompt
- **WHEN** a `run.browser_surface_lost` event has been emitted for an interaction
- **AND** an owner attempts to submit a response for that same interaction id
- **THEN** the reference runtime SHALL reject the response with `no_pending_interaction`
- **AND** it SHALL NOT deliver that response to the connector

#### Scenario: Non-browser interactions are unaffected
- **WHEN** a connector emits an `otp` or `credentials` INTERACTION without a browser surface
- **THEN** the reference runtime SHALL NOT run a mid-wait surface loss detector
- **AND** the interaction SHALL wait for owner response or connector-specified timeout as normal

### Requirement: Browser-session run stream SHALL label a run with its connection identity when available

The run interaction stream SHALL use the run's connection instance identity when resolving owner-facing subject copy.

#### Scenario: Multiple connections share one connector type

- **WHEN** a run stream has a `connector_id`
- **AND** the run status or timeline identifies a `connector_instance_id` or `connection_id`
- **AND** the owner has multiple connector summaries for that `connector_id`
- **THEN** the stream SHALL choose the summary matching the run's connection identity
- **AND** it SHALL NOT choose the first summary for the connector type alone

#### Scenario: Connection identity is unavailable

- **WHEN** a run stream has only a `connector_id`
- **THEN** the stream MAY fall back to connector-type display copy

