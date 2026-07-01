## ADDED Requirements

### Requirement: Polyfill manifests SHALL declare stable setup and repair mechanisms, not live repair state

First-party polyfill connector manifests SHALL describe stable setup, automation, runtime-binding, and repair mechanisms the connector can support. They SHALL NOT represent whether a specific connection's stored credential, provider grant, browser session, local collector, or source account is currently valid.

Provider-specific source states observed during a run SHALL be represented as runtime evidence, run assistance, connection health, coverage, or required-action state rather than as manifest schema.

#### Scenario: Browser session availability changes without a manifest change

- **WHEN** a browser-backed connector manifest declares that it can use browser-session repair or reusable browser session state
- **AND** one connection has a valid reusable session while another has an expired session
- **THEN** both connections SHALL continue to use the same manifest
- **AND** their different readiness or repair status SHALL come from connection-scoped evidence.

#### Scenario: Stored secret is rejected

- **WHEN** a connector whose manifest supports stored-secret setup observes that the provider rejected the current stored secret for one connection
- **THEN** the manifest SHALL remain unchanged
- **AND** the runtime SHALL record credential-repair evidence for that connection.

#### Scenario: Provider-specific challenge appears

- **WHEN** a source page requests a provider-specific action such as push approval, OTP, file-type selection, or manual browser operation
- **THEN** the connector/runtime SHALL map that observation into the bounded run-assistance or required-action contract
- **AND** it SHALL NOT require a new manifest enum for that provider-specific page state.

### Requirement: Refresh policy hints SHALL NOT decide current repair routing by themselves

`capabilities.refresh_policy` SHALL remain reference/runtime scheduling metadata. Refresh policy hints MAY inform whether unattended runs are allowed, conservative, manual, paused, or session-reuse-only, but they SHALL NOT be the sole source of truth for whether a current connection is repairable, blocked, healthy, or owner-actionable.

Existing assisted-after-owner-auth style hints MAY be honored as compatibility metadata during migration, but new repair routing SHALL be derived from stable mechanism declarations plus observed connection evidence.

#### Scenario: Scheduled run lacks reusable session state

- **WHEN** a scheduled browser-backed run requires reusable owner-authenticated session state
- **AND** current connection evidence does not prove that reusable state is available
- **THEN** the runtime SHALL defer or fail with bounded repair-required evidence
- **AND** it SHALL NOT open an owner browser handoff solely because the manifest has an assisted-after-owner-auth hint.

#### Scenario: Owner-started repair is allowed

- **WHEN** the owner explicitly starts a repair flow for a connection whose manifest supports browser-session repair
- **THEN** the runtime MAY ask the owner to operate a secure browser session
- **AND** any resulting readiness SHALL be recorded as connection evidence, not as an update to the connector manifest.
