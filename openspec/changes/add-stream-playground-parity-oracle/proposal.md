## Why

The stream surface needs a deterministic oracle for the owner-selected phone presentation, restoration lifecycle, and keyboard-focus cache. A direct browser visit to a playground target and source-marker readiness states can falsely green those contracts.

## What Changes

- Bind phone verification to the owner-controlled stream route: portrait `412x915`, rotation `915x412`, n.eko screen-selection POSTs, window-size acknowledgements, and terminal `1440x900` baseline restoration.
- Bind restoration at the HTTP/controller seam, including acknowledgement ordering, restore failure cancellation, injected-clock token expiry, and boot recycle.
- Bind keyboard verification to state-machine behavior plus the viewer's navigation, geometry, and remount invalidation wiring.
- Make `pnpm stream:parity:oracle` green only when its behavior tests pass; no readiness state is accepted as a pass.
- Keep external calibration informational only.

## Capabilities

### New Capabilities

- `stream-playground-parity-oracle`: Deterministic behavior evidence for the reference stream presentation and keyboard-focus contracts.

### Modified Capabilities

- `reference-implementation-architecture`: Attached stream sessions terminalize on token expiry through the presentation restore barrier.

## Impact

Affected areas are the streaming route timer seam, n.eko route integration tests, keyboard tests, scoped verification commands, and reference-implementation architecture specs. CI requires no external service.
