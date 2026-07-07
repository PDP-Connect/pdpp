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
