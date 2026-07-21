## Context

Two independent client-side viewport authorities read the same stream
container: PDPP's own `measureAndPost`/`prepareViewportPost`, and
`@opendatalabs/remote-surface`'s `ViewportMatchController` (wired via
`createRemoteSurfaceViewer`). Both were ruled out as reading a genuinely
mis-measured desktop container in steady state — `.pdpp-stream-frame` fills
its full-viewport `.pdpp-stream-dialog` with no aspect-ratio constraint of
its own.

The actual defect is upstream of both: the `backend_ready` handler requests a
measurement in the same synchronous tick that it swaps `nekoSession` (and
therefore which surface renders). `containerRef.current` at that instant is
whichever surface was mounted immediately before — for the CDP-fallback
placeholder, that box carries `style={{ aspectRatio: aspect, height:"100%",
width:"100%" }}` with `aspect` defaulting to `"16/10"` when `viewportInfo` is
not yet the desktop value, which is letterboxed inside a centered flex
wrapper rather than filling it edge-to-edge.

Production log evidence
(`reference-implementation/server/streaming/routes.js:1419`) additionally
proved `backend_ready` fires on every SSE `/events` GET, not only first
attach — ruling out a naive "always defer" fix, which would leave a
same-session reconnect's request permanently unqueued (its surface's React
key is unchanged, so its container ref callback never fires again).

## Decision

A key-scoped gate (`stream-surface-measure-gate.ts`) tracks which surface key
(`browserSessionId`, or `"cdp"`) is currently attached:

- `requestSurfaceMeasure(state, source, surfaceKey)`: if `surfaceKey` already
  matches the attached surface, return `measureSourceNow` for the caller to
  measure synchronously (safe — not an outgoing container). Otherwise queue
  the request, discarding any prior pending request outright (fail-closed
  against a superseded transition).
- `drainSurfaceMeasureOnAttach(state, node, surfaceKey)`: called from the
  surface's ref callback on every non-null attach. Records `surfaceKey` as
  attached. Drains a pending request ONLY when its `surfaceKey` matches this
  attach.

This makes both the desktop-collapse race (identity change: must defer) and
the reconnect-forever-pending failure mode (same identity: must measure now)
correct from the same state machine, verified by directly opposing mutation
tests on the pure module.

`createStreamSurfaceMeasureCoordinator(measure)` wraps the pure reducer as a
single stateful object exposing `requestBackendReady(surfaceKey)` and
`attachSurface(node, surfaceKey)`. `stream-viewer.tsx` constructs exactly one
instance via `useRef` and both production call sites (the `backend_ready`
listener, and `setStreamSurfaceNode`'s ref callback) call only the
coordinator's methods — neither calls `requestViewportMeasureRef` directly.
This closes a gap an independent review caught: a first-pass version of this
fix had `stream-viewer.tsx` call the pure `requestSurfaceMeasure`/
`drainSurfaceMeasureOnAttach` functions directly at two call sites, threading
the gate-state ref itself. Unit tests against the pure functions (and even a
source-regex checking for the correct function names) could not detect an
accidental *third*, stray direct call to `requestViewportMeasureRef` added
alongside the correct wiring — since the tests never drove production code,
only a reimplementation of the same sequence. The coordinator collapses "call
the gate correctly" into a single production object with a single production
call site each, and the test suite drives that literal object (constructed
exactly as `stream-viewer.tsx` constructs it) with an injected measurement
spy, plus a narrow source-guard confirming the `backend_ready` handler's
bounded block contains zero direct `requestViewportMeasureRef` calls. Mutation-
proved: reintroducing the exact double-wire the review specified
(`requestViewportMeasureRef.current?.("neko-backend-ready")` immediately
before the coordinator call) fails the source-guard test.

## Alternatives considered

- **Always defer, drain on any next attach.** Rejected: a same-session
  reconnect's surface never re-attaches (stable React key), so the request
  would never drain — proven against real production `backend_ready`
  semantics.
- **Always measure immediately.** Rejected: reintroduces the exact
  desktop-collapse bug on a genuine identity change, where the outgoing
  surface's container is still attached.
- **Rely solely on the existing debounced `ResizeObserver` pipeline** (which
  already correctly re-measures the new container once it mounts, ~200ms
  later). Kept as an independent backstop, but not sufficient alone: the
  eager measurement exists to avoid a visible flash of the wrong-shaped
  frame before the debounce fires, so removing it outright (rather than
  gating it) would be an observable regression.

## Out of Scope

- The CDP (non-neko) `backend_ready` branch was NOT given a gated deferral —
  `<BrowserSurface>` has no React key, so its container is stable across a
  same-branch re-render and there is no proven race for it (it never called
  `requestViewportMeasureRef` before this change either). Adding an unproven
  deferral there risks stranding pending state with no drain path.
