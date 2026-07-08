## Why

The container-fit viewer primitive reports the local container geometry, and the viewport classifier already decides which local viewport transitions should resize the remote browser. The extracted package does not yet wire those pieces into a closed loop.

Without that loop, hosts can still show letterbox bars after the viewer container changes size. CDP and n.eko need the same decision half, with backend-specific resize effects supplied by the host.

## What Changes

- Add a backend-agnostic viewport-match controller under `packages/remote-surface/src/client/`.
- The controller subscribes to a `StreamViewerSurface`, classifies container observations with the existing viewport classifier, debounces postable resizes, shapes targets with the existing viewport payload helper, applies an injectable snap policy, and calls an injected `applyViewport` function.
- The controller exposes mismatch telemetry for the current fitted media versus the container.
- The CDP playground wires `applyViewport` to the existing CDP viewport resize path and displays target, actual, letterbox, and matched telemetry.
- The n.eko backend exports a documented apply-viewport seam type and stub for future aligned-modeline/window-bounds/gutter-crop work.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: remote-surface client viewport control shall remain backend-agnostic while backend adapters supply resize effects.

## Impact

- Affects `packages/remote-surface/src/client/**`, `packages/remote-surface/src/backends/neko/**`, package exports, README, dist artifacts, and the remote-surface playground.
- Does not change PDPP protocol semantics or reference runtime routes.
- Does not boot or require n.eko runtime work.
