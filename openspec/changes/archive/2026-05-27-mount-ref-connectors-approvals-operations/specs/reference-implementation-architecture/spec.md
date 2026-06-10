## ADDED Requirements

### Requirement: Reference Connector And Approval Read Operations

The reference implementation SHALL expose operator connector catalog reads and pending-approval reads through canonical operation modules before host route adapters shape HTTP responses.

#### Scenario: Connector list operation preserves route behavior

**WHEN** the `/_ref/connectors` route serves an owner-authenticated request
**THEN** it SHALL delegate connector catalog response shaping to a boundary-checked operation module
**AND** SHALL preserve the existing response contract.

#### Scenario: Connector detail operation preserves route behavior

**WHEN** the `/_ref/connectors/:connectorId` route serves an owner-authenticated request
**THEN** it SHALL delegate connector detail response shaping to a boundary-checked operation module
**AND** SHALL preserve the existing success and not-found response contracts.

#### Scenario: Approval list operation preserves route behavior

**WHEN** the `/_ref/approvals` route serves an owner-authenticated request
**THEN** it SHALL delegate pending-approval response shaping to a boundary-checked operation module
**AND** SHALL NOT expose redeemable device codes, user codes, request URIs, bearer tokens, or other approval secrets.
