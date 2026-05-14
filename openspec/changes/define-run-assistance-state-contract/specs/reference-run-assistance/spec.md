## ADDED Requirements

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

#### Scenario: Assistance is requested
- **WHEN** a connector emits a structured assistance request
- **THEN** the reference timeline SHALL record the progress posture, owner action, response obligation, attachment kinds, sensitivity class, timeout metadata, and safe user-facing message
- **AND** the timeline SHALL NOT include raw secret values or raw browser bearer targets

#### Scenario: Assistance resolves automatically
- **WHEN** an `act_elsewhere` assistance request completes because the connector observes the external approval
- **THEN** the reference timeline SHALL record an assistance-resolved transition without requiring owner-submitted data

#### Scenario: Assistance times out and escalates
- **WHEN** a nonblocking assistance request can no longer make progress without explicit owner input
- **THEN** the reference SHALL record an explicit timeout or escalation transition before presenting a blocking assistance request

### Requirement: Dashboard assistance UX is derived from state
The reference dashboard SHALL derive assistance copy and controls from the structured assistance fields rather than from connector-specific string matching or from the presence of a pending interaction alone.

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
