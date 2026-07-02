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

Owner-mediated repair for a browser-session-bound connection SHALL be browser/session repair, not static-secret credential capture, even when the connector also supports a static-secret credential. A static-secret-bound connection with no usable stored credential SHALL fail closed before starting the connector rather than falling through to a browser login.

#### Scenario: Background auth repair is required but not attempted

- **WHEN** a non-manual run detects that a source session is inactive and that repair requires owner participation
- **THEN** the run SHALL record bounded terminal evidence that classifies the failure as credential or source-session repair
- **AND** the run SHALL NOT emit repeated owner assistance or interaction prompts from the automatic path

#### Scenario: Stored credential is rejected before assistance

- **WHEN** a connector receives a connection-scoped stored credential and the provider definitively rejects it
- **THEN** the run SHALL record bounded terminal evidence with a stable non-secret credential-rejection code
- **AND** it SHALL NOT ask the owner for unrelated app approval, OTP, or browser assistance for that same rejected credential attempt

#### Scenario: Browser-session-bound connection repairs by session, not credential capture

- **WHEN** an owner-attended run for a browser-session-bound connection finds no reusable session
- **THEN** the owner-mediated repair SHALL be browser/session repair (operate the secure browser to re-establish the session)
- **AND** the owner-facing surfaces SHALL NOT route this connection to static-secret credential capture, because it authenticates by browser session rather than a stored credential.

#### Scenario: Static-secret-bound connection fails closed rather than opening a browser login

- **WHEN** a static-secret-bound connection has no usable stored credential
- **THEN** the run SHALL fail closed in credential resolution before the connector starts
- **AND** the owner-mediated repair SHALL be durable credential capture for the existing connection, not a browser login.

#### Scenario: Owner manual repair uses browser session

- **WHEN** an owner-attended browser-session repair starts without an active stored login credential
- **THEN** the reference MAY ask the owner to operate the secure browser
- **AND** the resulting repair SHALL be represented as browser-session state unless the owner explicitly submits a stored-credential capture flow.

#### Scenario: Browser-session repair preserves the pre-assistance state

- **WHEN** an owner-attended browser-session repair run has started and has an active browser surface
- **AND** the run has not yet emitted the current browser-surface assistance request
- **THEN** owner-facing stream surfaces SHALL present the browser repair as preparing or waiting for browser input
- **AND** they SHALL continue checking the run timeline for a current browser-surface assistance request
- **AND** they SHALL NOT present the generic "no browser action" state for that browser-session repair path.

### Requirement: Dashboard assistance UX is derived from state
The reference dashboard SHALL derive assistance copy and controls from the structured assistance fields and run terminal state rather than from connector-specific string matching or from the presence of a pending interaction alone.

#### Scenario: Browser surface is needed but no response is required
- **WHEN** the current assistance has progress posture `blocked`, owner action `operate_attachment`, response obligation `none`, and a `browser_surface` attachment
- **THEN** the dashboard SHALL render the streaming companion entry point and browser-control instructions
- **AND** it SHALL NOT render a submit, continue, or interaction-response control
- **AND** the run SHALL continue to rely on connector-observed completion rather than an owner-submitted response

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

### Requirement: Externally-approvable observation windows SHALL auto-resume across their full budget without an owner response

The reference SHALL continue to observe completion of an externally-approvable
owner action across the entire non-blocking observation budget, and SHALL
continue the run automatically when completion is observed during that budget,
resolving the assistance without requiring an owner-submitted response. The
reference SHALL escalate to a blocking owner action only after the observation
budget is exhausted.

#### Scenario: Approval completes during the non-blocking observation budget
- **WHEN** a connector represents an externally-approvable owner action as a non-blocking assistance request and polls for completion
- **AND** completion (for example session readiness) is observed at any point within the observation budget
- **THEN** the reference SHALL continue the run automatically without emitting a blocking interaction
- **AND** the reference SHALL record an assistance-resolved transition without requiring owner-submitted data

#### Scenario: Observation budget is exhausted before completion is observed
- **WHEN** the observation budget for a non-blocking externally-approvable assistance request elapses with no observed completion
- **THEN** the reference SHALL record an assistance-escalated transition before presenting a blocking owner action
- **AND** the reference SHALL then present the blocking owner action as a fallback

### Requirement: A non-blocking observation window SHALL NOT be killed by the session-establishment watchdog

The reference SHALL ensure that a connector legitimately waiting in a
non-blocking observation window during session establishment reports
forward-progress to the session-establishment watchdog, so the run is not failed
closed while it is observing an external approval it can complete automatically.
The watchdog SHALL still fail a genuinely stalled session establishment that
reports no forward progress.

#### Scenario: Connector polls an external approval longer than the watchdog deadline
- **WHEN** a connector observes an externally-approvable action by polling during session establishment
- **AND** the polling window is longer than the session-establishment watchdog's no-progress deadline
- **THEN** the connector SHALL report forward-progress to the watchdog on each poll iteration
- **AND** the reference SHALL NOT fail the run closed for lack of session-establishment progress while the poll is making progress

#### Scenario: Session establishment genuinely stalls
- **WHEN** session establishment makes no forward progress for longer than the watchdog deadline and no owner interaction is open
- **THEN** the reference SHALL fail the run closed via the session-establishment watchdog as today

### Requirement: Browser-surface assistance can mint a stream without an interaction
The reference implementation SHALL allow an owner to open the streaming companion for current no-response browser-surface assistance without requiring a pending interaction response.

#### Scenario: No-response browser assistance has a ready leased surface
- **WHEN** a run has current assistance with response obligation `none`, owner action `operate_attachment`, and a `browser_surface` attachment
- **AND** a ready browser-surface lease is active for that run
- **AND** the owner requests a stream session using that assistance id
- **THEN** the reference implementation SHALL mint a stream session for the leased browser surface
- **AND** it SHALL NOT require `run.interaction_required` to be pending
- **AND** it SHALL reject stale assistance ids or missing/non-ready browser surfaces

### Requirement: Runtime repair requests SHALL use bounded owner-action surfaces

The reference runtime SHALL route owner-mediated repair through bounded owner-action surfaces rather than connector-specific dashboard branches or manifest-specific provider-state enums. A connector MAY provide safe, source-specific instructions inside a bounded action after observing source state, but the owner-action surface itself SHALL be one of the shared product classes used by the reference projection.

#### Scenario: Connector observes an owner challenge

- **WHEN** a connector observes that the owner must provide a value, approve an external prompt, operate a browser, provide an artifact, or wait for provider/system retry
- **THEN** it SHALL emit or record structured assistance or required-action evidence using the shared action surface that matches the owner task
- **AND** it MAY include safe provider-specific instructions under that action.

#### Scenario: Connector-specific strings do not define actionability

- **WHEN** the dashboard, CLI, owner-agent, or scheduler decides whether a current item is owner-actionable
- **THEN** it SHALL use the structured assistance, required-action, or connection-health contract
- **AND** it SHALL NOT infer actionability from connector-specific progress text or error-string matching.

#### Scenario: Browser-session repair is explicit owner participation

- **WHEN** a connector asks the owner to operate a browser session for repair
- **THEN** the action SHALL be represented as browser-session operation with its response obligation and attachment state
- **AND** the runtime SHALL NOT treat credentials typed into the provider page as stored credentials unless the owner explicitly used a stored-credential capture flow.
