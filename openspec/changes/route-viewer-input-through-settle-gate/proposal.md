## Why

The mounted console viewer currently bypasses its remote-surface input router for pointer and scroll input. That split permits direct dispatch against geometry that the viewer has not yet settled.

## What Changes

- Route the console's captured pointer, desktop-wheel, and touch-scroll intents through the mounted viewer handle's settle-gated `dispatchInput` API.
- Preserve the console's DOM capture, gesture policy, and trusted-touch keyboard-focus sequence; only the downstream dispatch target changes.
- Make the viewer router the only mounted-path movement authority; retain direct control delivery only for non-mounted fallback flows.
- Scope fallback touch-scroll wheel intents to each touch gesture and emit a mounted-only, zero-delta terminal boundary at its last delivered coordinate so its residual cannot mix with desktop wheel or a following gesture.
- Route unscrolled fallback taps through the mounted viewer router and cancel tracked delivered presses before a viewer remount disposes its input controller.
- Upgrade the console dependency to remote-surface 1.4.1 and forward router drop/coalescing diagnostics to the console debug log.
- Add deterministic production-seam parity, unsettled-geometry queue/flush coverage, and remount terminal-release coverage.
- Warm the trusted-touch path with a short-lived confirmed-editable-rect cache that expires and invalidates on navigation, remount, and geometry changes.

## Capabilities

### New Capabilities

- `remote-surface-input-routing`: Console input dispatch through the mounted remote-surface viewer while preserving host-owned interaction policy.

### Modified Capabilities

- None.

## Impact

- Affects the console stream viewer and its stream-directory tests.
- Uses `@opendatalabs/remote-surface` 1.4.1's metadata-only terminal wheel boundary, per-source accumulator, and input diagnostics; no PDPP protocol contract changes.
