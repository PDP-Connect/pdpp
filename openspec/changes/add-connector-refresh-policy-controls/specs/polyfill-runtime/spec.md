## ADDED Requirements

### Requirement: Polyfill manifests MAY declare refresh policy hints

First-party polyfill connector manifests MAY declare `capabilities.refresh_policy` as reference/runtime metadata describing recommended scheduling posture. These hints SHALL NOT be treated as finalized PDPP core protocol semantics in this tranche.

#### Scenario: Connector declares a refresh policy
- **WHEN** a polyfill manifest includes `capabilities.refresh_policy`
- **THEN** the policy SHALL identify a recommended mode and an owner-readable rationale
- **AND** it MAY include recommended interval, minimum interval, maximum staleness, interaction posture, session lifetime, rate-limit sensitivity, bot-detection sensitivity, and background-safety hints

#### Scenario: Connector has high human-interaction friction
- **WHEN** a connector commonly requires OTP, credentials, or manual browser action
- **THEN** its refresh policy SHOULD recommend manual or conservative automatic scheduling
- **AND** the rationale SHOULD explain the human-attention cost

#### Scenario: Connector has low interaction cost
- **WHEN** a connector can refresh safely with durable credentials, local files, or low-friction API access
- **THEN** its refresh policy MAY recommend automatic refresh with an appropriate interval

#### Scenario: A future spec wants portable scheduling semantics
- **WHEN** refresh policy hints need to become interoperable across implementations
- **THEN** the vocabulary SHALL be promoted through a separate Collection Profile or companion-spec change
- **AND** this reference/polyfill metadata SHALL NOT be retroactively treated as normative PDPP core protocol
