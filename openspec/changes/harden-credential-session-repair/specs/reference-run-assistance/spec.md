## MODIFIED Requirements

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
