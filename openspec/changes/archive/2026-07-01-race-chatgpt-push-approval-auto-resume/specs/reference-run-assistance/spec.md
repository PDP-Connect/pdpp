## ADDED Requirements

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
