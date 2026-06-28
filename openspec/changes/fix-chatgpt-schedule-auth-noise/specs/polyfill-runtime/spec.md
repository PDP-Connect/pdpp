## MODIFIED Requirements

### Requirement: Polyfill manifests MAY declare refresh policy hints

First-party polyfill connector manifests MAY declare `capabilities.refresh_policy` as reference/runtime metadata describing recommended scheduling posture. These hints SHALL NOT be treated as finalized PDPP core protocol semantics in this tranche.

#### Scenario: Connector declares a refresh policy
- **WHEN** a polyfill manifest includes `capabilities.refresh_policy`
- **THEN** the policy SHALL identify a recommended mode and an owner-readable rationale
- **AND** it MAY include recommended interval, minimum interval, maximum staleness, interaction posture, session lifetime, rate-limit sensitivity, bot-detection sensitivity, background-safety hints, and an assisted-after-owner-auth hint

#### Scenario: Connector has high human-interaction friction
- **WHEN** a connector commonly requires OTP, credentials, or manual browser action
- **THEN** its refresh policy SHOULD recommend manual refresh or conservative automatic scheduling with assisted-after-owner-auth posture
- **AND** the rationale SHOULD explain the human-attention cost

#### Scenario: Connector has low interaction cost
- **WHEN** a connector can refresh safely with durable credentials, local files, or low-friction API access
- **THEN** its refresh policy MAY recommend automatic refresh with an appropriate interval

#### Scenario: Automatic browser refresh depends on reusable owner-authenticated session state
- **WHEN** a browser connector recommends automatic refresh only after owner-authenticated browser state exists
- **THEN** the connector SHALL treat automatic runs as session-reuse-only unless a later accepted connector policy explicitly permits background auth repair
- **AND** an automatic run that cannot reuse the session SHALL fail or defer before submitting credentials, requesting OTP, requesting external app approval, or opening manual browser handoff
- **AND** an owner-started manual run MAY perform the interactive auth repair path.

#### Scenario: A future spec wants portable scheduling semantics
- **WHEN** refresh policy hints need to become interoperable across implementations
- **THEN** the vocabulary SHALL be promoted through a separate Collection Profile or companion-spec change
- **AND** this reference/polyfill metadata SHALL NOT be retroactively treated as normative PDPP core protocol

## ADDED Requirements

### Requirement: Runtime SHALL expose bounded run automation metadata to connector children

The polyfill runtime SHALL pass the current run trigger kind and automation mode to connector child processes using bounded non-secret metadata. The metadata SHALL be sufficient for a connector to distinguish owner-started auth repair from unattended/session-reuse automatic collection.

#### Scenario: Scheduled connector child receives automation metadata
- **WHEN** the reference runtime starts a connector child for a scheduled run
- **THEN** the child environment SHALL include the scheduled trigger kind and the projected automation mode
- **AND** those values SHALL NOT contain owner tokens, credentials, record contents, browser bearer URLs, or raw grant payloads.

#### Scenario: Manual connector child receives automation metadata
- **WHEN** the reference runtime starts a connector child for an owner-started manual run
- **THEN** the child environment SHALL include the manual trigger kind and projected automation mode
- **AND** a connector MAY use that metadata to allow owner-interactive auth repair for that run.
