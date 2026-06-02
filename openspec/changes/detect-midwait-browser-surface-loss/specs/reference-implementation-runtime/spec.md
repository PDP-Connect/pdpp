# reference-implementation-runtime Specification Delta

## MODIFIED Requirements

### Requirement: Runtime SHALL broker interactions as in-process pauses
The reference runtime SHALL treat connector `INTERACTION` messages as blocking in-process pauses that are completed by a matching `INTERACTION_RESPONSE` while the connector child process remains alive. The reference runtime SHALL additionally monitor the browser surface during a `manual_action` or browser-surface-backed `otp` interaction wait and SHALL cancel the open interaction fail-closed if the surface becomes unavailable before the owner responds.

#### Scenario: Interaction is accepted
- **WHEN** a connector emits a valid `INTERACTION` and the run advertised `interactive`
- **THEN** the reference runtime SHALL record `run.interaction_required`
- **AND** it SHALL wait for a matching response or timeout before sending `INTERACTION_RESPONSE` to the connector

#### Scenario: Interaction completes
- **WHEN** the interaction handler returns `success`, `cancelled`, or `timeout` for the current interaction request id
- **THEN** the reference runtime SHALL record `run.interaction_completed` with status, kind, and stream
- **AND** it SHALL NOT record submitted credential, OTP, or manual-action response data in the durable run timeline

#### Scenario: Interaction is unavailable
- **WHEN** a connector emits `INTERACTION` but `START.bindings` omitted `interactive`
- **THEN** the reference runtime SHALL fail the run as a connector protocol violation
- **AND** it SHALL NOT record interaction-required or interaction-completed events for that invalid interaction

#### Scenario: Connector emits output while waiting
- **WHEN** a connector emits another message or invalid JSONL while the runtime is waiting for the current interaction response
- **THEN** the reference runtime SHALL fail the run as a connector protocol violation
- **AND** it SHALL terminate the connector child process

#### Scenario: Browser surface is lost during interaction wait
- **WHEN** a connector emits a `manual_action` or `otp` INTERACTION with an active browser surface
- **AND** the browser surface becomes unreachable (CDP HTTP probe fails) before the owner responds
- **THEN** the reference runtime SHALL detect the surface loss via periodic mid-wait polling
- **AND** it SHALL emit `run.browser_surface_lost` with `interaction_id`, `kind`, and a `browser_surface_probe` envelope carrying the typed failure code and detail
- **AND** it SHALL cancel the pending interaction and record `run.interaction_completed { status: "cancelled" }`
- **AND** it SHALL clear the pending interaction entry so any subsequent owner response is rejected as stale
