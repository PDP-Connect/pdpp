## ADDED Requirements

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
