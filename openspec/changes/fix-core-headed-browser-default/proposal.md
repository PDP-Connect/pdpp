## Why

The browser-capable Core image currently ships full Patchright Chromium but the connector runtime defaults local browser sessions to the headless shell. That loses browser-hostile parity for interactive connectors even though Core has the display and browser dependencies needed to run the full browser.

## What Changes

- Core supervises a managed Xvfb display and passes it to its runtime children.
- Local browser sessions default to headed full Patchright Chromium; one deployment-level `PDPP_BROWSER_HEADLESS=1` override selects headless mode.
- The in-container browser gate recognizes only the packaged browser runtime with its managed display as headed-capable; n.eko remote-CDP attachment remains separate.
- A production-image oracle proves browser binary selection, persistent profiles, direct-CDP registration, cleanup, and profile reuse after restart.

## Capabilities

### Modified

- `polyfill-runtime`

### Added

None.

### Removed

None.

## Impact

Docker/startup configuration, the shared browser runtime policy, and runtime tests/oracles. Connector manifests remain browser requests; they do not select browser visibility.
