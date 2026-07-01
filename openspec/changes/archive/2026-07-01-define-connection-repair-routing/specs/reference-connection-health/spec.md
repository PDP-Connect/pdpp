## ADDED Requirements

### Requirement: Connection repair state SHALL be evidence-derived and connection-scoped

The reference implementation SHALL derive current repair state for a connection from typed evidence such as credential validity, provider-grant validity, browser-session readiness, local-collector health, runtime-binding availability, run assistance, coverage gaps, and satisfied required actions. A run may create evidence, but the repaired object SHALL be the existing connection.

Repair state SHALL NOT be closed solely because a run ended, an owner-action row aged out, or a connector-specific status string disappeared. A connection may stop showing an old prompt when it expires or is superseded, but it SHALL NOT be projected healthy until current evidence proves readiness or the relevant issue no longer applies.

#### Scenario: Owner repairs the same connection

- **WHEN** the owner satisfies a reauthorization, credential rotation, browser-session repair, local-collector repair, or recoverable-gap action
- **THEN** the reference SHALL attach the repair evidence to the same `connection_id`
- **AND** it SHALL preserve that connection's schedules, grants, stored credential identity, and run history unless the owner explicitly creates a new connection.

#### Scenario: Old repair prompt expires without proof

- **WHEN** an owner-action prompt expires or is superseded without evidence that the connection is ready
- **THEN** the expired prompt SHALL NOT remain the dominant current action
- **AND** the connection SHALL still project any unresolved readiness, credential, session, coverage, or local-device condition that remains current.

#### Scenario: Confirmation run fails identically

- **WHEN** an owner repair action appears satisfied but the confirming run fails with the same repair cause
- **THEN** the connection SHALL return to the same repair-required class with updated evidence
- **AND** it SHALL NOT be projected healthy.

### Requirement: Unattended repair SHALL defer owner-mediated actions

Scheduled and otherwise unattended runs SHALL NOT initiate owner-mediated repair actions that require active owner participation. They SHALL record evidence that the existing connection needs repair and allow the connection-health projection to surface the appropriate owner action.

#### Scenario: Scheduled run needs a browser login

- **WHEN** a scheduled run detects that collection cannot proceed without owner browser operation
- **THEN** it SHALL record bounded repair-required evidence for the connection
- **AND** it SHALL NOT open an owner browser session, ask for a password, request OTP, or create repeated interactive prompts from the scheduled path.

#### Scenario: Owner repair can resume automatic collection

- **WHEN** the owner later starts and completes the required repair action
- **THEN** the reference SHALL verify the repair through current evidence or a bounded confirming run
- **AND** automatic collection MAY resume on the same connection if its schedule and policy allow it.
