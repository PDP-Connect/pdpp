## MODIFIED Requirements

### Requirement: Browser-backed connectors SHALL use the deployment-owned browser mode

The polyfill runtime SHALL treat browser visibility as deployment policy. A browser-backed connector SHALL request a browser and profile only; it SHALL NOT select a connector-specific headed/headless compatibility mode. In the browser-capable Core image, local browser sessions SHALL default to headed full Patchright Chromium under the supervisor-managed virtual display. The deployment MAY set `PDPP_BROWSER_HEADLESS=1` to select headless Chromium for all local browser sessions.

#### Scenario: Core launches the default local browser

**WHEN** a browser-backed connector runs in the browser-capable Core image
**AND** `PDPP_BROWSER_HEADLESS` is unset or set to `0`
**THEN** the runtime SHALL launch the full Patchright Chromium executable with `headless: false`
**AND** the browser SHALL use the supervisor-managed `DISPLAY`
**AND** the connector SHALL use its isolated persistent profile.

#### Scenario: Deployment opts into headless mode

**WHEN** a browser-backed connector runs with `PDPP_BROWSER_HEADLESS=1`
**THEN** the runtime SHALL launch the headless Chromium implementation
**AND** every local browser-backed connector SHALL receive the same deployment-wide mode.

#### Scenario: n.eko owns a remote browser

**WHEN** a browser-backed connector has a managed n.eko remote-CDP endpoint
**THEN** the runtime SHALL attach with Patchright over CDP
**AND** it SHALL NOT replace n.eko's browser, display, or persistent profile lifecycle with a local launch.

### Requirement: Core SHALL manage the virtual display lifecycle for headed browser sessions

The browser-capable Core startup SHALL start Xvfb before browser-capable runtime children, wait until the display is ready, pass the display environment to those children, and stop Xvfb when Core stops or a supervised child exits.

#### Scenario: Core starts normally

**WHEN** the Core supervisor starts the browser-capable image
**THEN** Xvfb SHALL be a supervisor-owned child
**AND** the reference runtime SHALL inherit its managed `DISPLAY`
**AND** a headed Patchright launch SHALL be possible without n.eko.

#### Scenario: Core restarts

**WHEN** Core is stopped or a supervised child exits
**THEN** the supervisor SHALL terminate Xvfb with the other children
**AND** a later Core start SHALL be able to create a fresh display and reacquire the same persistent browser profile.
