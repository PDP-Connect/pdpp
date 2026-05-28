# polyfill-runtime Specification

## Purpose
TBD - created by archiving change add-connector-refresh-policy-controls. Update Purpose after archive.
## Requirements
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

### Requirement: Browser-backed connectors SHALL acquire browsers exclusively through the isolated patchright launcher

The polyfill-connector runtime SHALL provide exactly one browser-launch primitive (`acquireIsolatedBrowser`) that launches a per-connector patchright Chromium with an isolated profile directory. Browser-backed connectors and operator tools SHALL NOT use a long-lived shared Chromium daemon, CDP-attach, or a shared profile directory across connectors.

#### Scenario: A browser-backed connector run launches a browser
- **WHEN** the runtime begins a browser-backed connector run
- **THEN** it SHALL call the isolated patchright launcher with a per-connector profile name
- **AND** the launcher SHALL create or reuse a profile directory under `~/.pdpp/profiles/<profile-name>/`
- **AND** it SHALL NOT read or write `~/.pdpp/browser-daemon.json`
- **AND** it SHALL NOT call `chromium.connectOverCDP`.

#### Scenario: An operator tool needs a browser
- **WHEN** an operator-side script under `bin/` needs a Chromium context
- **THEN** it SHALL acquire that context through the same isolated patchright launcher
- **AND** it SHALL NOT spawn or attach to a separate browser-daemon process.

#### Scenario: Two connectors run in parallel
- **WHEN** the runtime executes two different browser-backed connectors concurrently
- **THEN** each connector SHALL receive an independent profile directory
- **AND** neither connector SHALL share cookies, localStorage, or fingerprint state with the other.

### Requirement: The runtime SHALL NOT expose browser-daemon lifecycle commands

The polyfill operator surface SHALL NOT advertise or implement commands to start, stop, restart, query, or tail logs for a long-lived shared browser process. Operator-facing browser commands SHALL NOT exist as a documented or functional CLI surface.

#### Scenario: An operator inspects the polyfill CLI surface
- **WHEN** an operator views `pdpp-connectors --help` or any equivalent help output
- **THEN** there SHALL be no `browser start`, `browser stop`, `browser status`, `browser restart`, `browser logs`, `browser bootstrap`, or `browser probe` subcommand.

#### Scenario: A doc references the legacy daemon
- **WHEN** any user-facing doc, runbook, or design note in the active set references the daemon CLI
- **THEN** the reference SHALL be removed or marked superseded
- **AND** the recommended path SHALL point to per-connector auto-login plus `INTERACTION kind=credentials` for initial credentialing.

### Requirement: Multi-account support SHALL be enabled by per-subject profile keys

The polyfill-runtime SHALL be extensible to support multiple owner accounts per platform without sharing browser profile state across accounts. The default profile-name derivation SHALL be replaceable with a per-subject derivation when multi-account support ships.

#### Scenario: Single-account default (current tranche)
- **WHEN** a browser-backed connector does not supply an explicit `profileName`
- **THEN** the runtime SHALL default to `profileName = <connector-name>`
- **AND** this is acknowledged as single-account by design.

#### Scenario: Multi-account derivation (future tranche)
- **WHEN** multi-account support is enabled in a later change
- **THEN** the default `profileName` derivation SHALL include a stable subject identifier
- **AND** two accounts on the same platform SHALL receive independent profile directories
- **AND** they SHALL be safe to run concurrently without collision on Chromium's per-profile `SingletonLock`.

