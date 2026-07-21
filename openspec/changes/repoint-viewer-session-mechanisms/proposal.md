## Why

The mounted console still reaches its injected n.eko adapter directly for keyboard focus and browser-selection copy. A rejected viewport application is diagnostic-only and can look like a stalled stream.

## What Changes

- Route mounted keyboard focus and browser-selection copy through the remote-surface viewer session.
- Preserve the console's trusted-touch, clipboard-policy, and typed-text sheet behavior.
- Show viewport-application failures in the existing retryable inline stream-error panel.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: mounted viewer mechanism calls and viewport failures are observable through the viewer boundary.

## Impact

- Affects the console stream viewer and its stream-directory tests.
- Does not change the PDPP protocol or server contract.
