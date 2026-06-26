## MODIFIED Requirements

### Requirement: Browser-backed connectors SHALL acquire browsers exclusively through the isolated patchright launcher

The polyfill-connector runtime SHALL provide exactly one browser-launch primitive (`acquireIsolatedBrowser`) that launches a per-connector patchright Chromium with an isolated profile directory. Browser-backed connectors and operator tools SHALL NOT use a long-lived shared Chromium daemon, CDP-attach, or a shared profile directory across connectors.

Browser-backed first-party connectors that drive upstream form controls SHALL keep availability waits and actions aligned to the same observed control family. When an upstream exposes multiple equivalent selector families or an accessible role/name for the same required control, the connector SHALL use those alternatives consistently before reporting the control unavailable.

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

#### Scenario: A connector waits for and acts on an upstream form control
- **WHEN** a browser-backed connector must wait for a required upstream form control before acting on it
- **AND** the connector has observed multiple equivalent selectors or an accessible role/name for that control
- **THEN** the connector SHALL use the same selector family for both the availability wait and the action
- **AND** it SHALL try the accessible control path before declaring the control unavailable when the structural selector path is not actionable.
