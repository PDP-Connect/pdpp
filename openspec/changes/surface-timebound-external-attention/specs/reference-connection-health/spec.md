## MODIFIED Requirements

### Requirement: Connection Health Separates Condition Families

The reference implementation SHALL keep source coverage, local-device backlog,
dead letters, retryable detail gaps, and owner attention as separate condition
families.

Owner attention SHALL dominate the connection-health projection while the
attention evidence is current and owner-actionable. A `running` external-action
attention row with `owner_action: "act_elsewhere"`,
`response_contract: "none"`, and a future expiry SHALL count as current owner
action because the owner can still act before the deadline and the connector can
observe completion without a submitted response. A similar row without an expiry
MAY be treated as informational progress and SHALL NOT by itself drive an owner
action state.

When a no-response `ASSISTANCE` row carries `timeout_seconds`, the reference
runtime SHALL enforce that deadline. If the connector does not close the
assistance before the deadline with `ASSISTANCE_STATUS`, the runtime SHALL close
the attention as timed out, emit a timeout assistance event, terminate the
connector run, and release the active-run slot with a terminal run result.

#### Scenario: Time-bound external approval is current owner action

**WHEN** a connector opens a non-terminal, non-expired attention row with
`progress_posture: "running"`, `owner_action: "act_elsewhere"`,
`response_contract: "none"`, and an `expires_at` deadline
**THEN** the connection-health projection SHALL include that row as current owner
attention
**AND** owner surfaces SHALL expose the structured next action until the row is
resolved, expired, canceled, or superseded.

#### Scenario: Unbounded external progress remains quiet

**WHEN** a connector opens a non-terminal attention row with
`progress_posture: "running"`, `owner_action: "act_elsewhere"`,
`response_contract: "none"`, and no expiry
**THEN** the connection-health projection MAY treat it as informational progress
**AND** it SHALL NOT by itself produce an owner-action CTA.

#### Scenario: Time-bound external approval times out

**WHEN** a connector opens a no-response assistance row with
`owner_action: "act_elsewhere"` and `timeout_seconds`
**AND** the connector does not emit `ASSISTANCE_STATUS` before the deadline
**THEN** the runtime SHALL emit `run.assistance_timed_out`
**AND** the run SHALL reach a terminal failed state with reason
`assistance_timed_out`
**AND** the active-run slot SHALL be released.
