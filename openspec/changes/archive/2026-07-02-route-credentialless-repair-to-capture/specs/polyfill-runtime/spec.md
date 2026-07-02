## MODIFIED Requirements

### Requirement: Polyfill manifests MAY declare refresh policy hints

First-party polyfill connector manifests MAY declare `capabilities.refresh_policy` as reference/runtime metadata describing recommended scheduling posture. These hints SHALL NOT be treated as finalized PDPP core protocol semantics in this tranche.

Owner-mediated repair selection SHALL be connection-binding-first: a connection bound as a browser session (`source_binding.kind` a browser-session kind such as `browser_collector` or `browser_enrollment_shell`) SHALL repair by browser/session repair, NOT static-secret credential capture, even when the connector also declares a static-secret (e.g. username_password) setup. Static-secret credential capture SHALL be the repair only for a connection actually bound as static-secret, or after the owner explicitly converts the connection's auth mode. Connector-level static-secret capability alone SHALL NOT route a browser-session-bound connection to credential capture.

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

#### Scenario: Browser-session-bound connection repairs by session, not credential capture
- **WHEN** a connection is bound as a browser session (a browser-session `source_binding.kind`) and needs repair
- **AND** the connector ALSO supports a static-secret credential at the connector level
- **THEN** the owner-facing repair SHALL be browser/session repair for that connection
- **AND** it SHALL NOT be static-secret credential capture, because the connection authenticates by owner-authenticated browser session, not a stored credential.

#### Scenario: Static-secret-bound connection with no usable credential
- **WHEN** a connection is bound as static-secret and has no usable stored credential
- **THEN** the owner-facing repair SHALL be durable credential capture for the existing connection
- **AND** a static-secret run that cannot resolve a usable credential SHALL fail closed before starting the connector, rather than falling through to a browser login.

#### Scenario: Reusable session needs no credential prompt
- **WHEN** a browser-session-bound connection has a valid reusable owner-authenticated session
- **THEN** the run SHALL proceed on the reused session without prompting the owner for a credential or opening a repair action.

#### Scenario: Browser-session repair does not store provider-page passwords
- **WHEN** an owner operates a secure browser to repair a browser-session-bound connection
- **THEN** the connector SHALL NOT silently store credentials typed into that provider page as a stored credential.

#### Scenario: A future spec wants portable scheduling semantics
- **WHEN** refresh policy hints need to become interoperable across implementations
- **THEN** the vocabulary SHALL be promoted through a separate Collection Profile or companion-spec change
- **AND** this reference/polyfill metadata SHALL NOT be retroactively treated as normative PDPP core protocol
