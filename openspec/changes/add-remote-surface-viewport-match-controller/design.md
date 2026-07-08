## Context

The package already has three primitives that should remain authoritative:

- `createContainerFitStreamViewerSurface(...)` observes the container and reports `containerBox`, fitted `displayRect`, current stream `viewport`, and `letterboxBars`.
- `classifyViewportTransition(previous, next)` classifies layout resize, orientation, keyboard occlusion, browser chrome, zoom, and stable transitions.
- `buildViewportPayload(...)` normalizes the viewport payload used by backend resize effects.

The missing behavior is orchestration: turn container observations into debounced backend resize requests and expose whether the visible stream now matches the container.

## Design Direction

Add `createViewportMatchController({ surface, applyViewport, options })`.

The controller is a client-side policy/effect coordinator:

- Input: `StreamViewerSurfaceGeometry` from `surface.subscribe`.
- Decision: `classifyViewportTransition(previousObservation, nextObservation)`.
- Target shaping: `buildViewportPayload` from the container box plus host-provided viewport defaults.
- Backend seam: `applyViewport(target)` supplied by the host or backend adapter.
- Optional snap policy: `snapViewport(target, context)` so n.eko can later snap to aligned modelines without forking the decision logic.
- Telemetry: current target, actual surface viewport, transition, bars, max bar, and `matched`.

The controller owns the debounce timer and disposal. It does not import CDP, n.eko runtime clients, Docker, React, or reference implementation code.

## Alternatives Considered

- **Extend the existing `stream-viewer-control` reducer.** Rejected for this tranche. That reducer already mixes viewport classification with n.eko media-settle policy and orientation settling. The new loop needs a smaller backend-agnostic interface around a `StreamViewerSurface` and an injected backend effect.
- **Put the loop in the playground.** Rejected. The playground should prove the package primitive rather than become the implementation.
- **Make CDP and n.eko implement separate loops.** Rejected. Keyboard suppression, orientation/layout classification, debounce, and telemetry are shared policy.

## Scope

In scope:

- Package controller, tests, exports, README.
- CDP playground wiring and telemetry panel.
- n.eko apply-viewport seam type/stub with comments pointing at existing media-settle/cover-crop helpers.

Out of scope:

- Docker/n.eko runtime work.
- Changing n.eko screen configuration or Browser.setWindowBounds now.
- Replacing existing viewer components in the reference console.

## Acceptance Checks

- `openspec validate add-remote-surface-viewport-match-controller --strict`
- `pnpm --filter @opendatalabs/remote-surface verify`
- `pnpm --filter @opendatalabs/remote-surface playground:test`
- Manual Playwright smoke on `REMOTE_SURFACE_PLAYGROUND_PORT=3995 REMOTE_SURFACE_PLAYGROUND_HOST=127.0.0.1` at desktop 1280x800 and Pixel 5 proving inline, modal, and odd container modes resize the CDP viewport and reduce mismatch.
