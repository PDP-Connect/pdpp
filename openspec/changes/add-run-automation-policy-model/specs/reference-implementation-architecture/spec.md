## ADDED Requirements

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
