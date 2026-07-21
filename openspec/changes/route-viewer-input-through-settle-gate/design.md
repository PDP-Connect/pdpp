## Context

Increment 1 mounts a video-element remote-surface viewer with its input capture disabled because the console retains product-specific capture behavior. The host listener currently calls the injected adapter directly, and the fallback mobile touch-scroll bridge writes to n.eko control directly. Remote-surface 1.4.1 provides a host-facing `dispatchInput` method that routes pointer and wheel intents through its sole settle gate, preserves terminal pointer events under queue pressure, scopes wheel residuals by optional source, and realizes a zero-delta terminal boundary as metadata only.

## Goals / Non-Goals

**Goals:**

- Preserve console capture ordering, hover suppression, mouse-focus behavior, and the #347 trusted-touch focus state machine.
- Deliver pointer and wheel wire intents through the mounted viewer handle.
- Preserve n.eko pointer, scroll, and single-movement-authority behavior for representative gestures while allowing the required terminal wheel boundary to clear touch residual state.
- Hold intents during viewer geometry transitions without adding a second console-side queue.
- Make the common confirmed-editable touch path one tap without permitting a cached remote rect to authorize an unrelated tap.

**Non-Goals:**

- Changing viewport policy, keyboard/clipboard routing, n.eko transport, or the direct-path helpers used by non-mounted flows.
- Replacing the console's DOM event policy with remote-surface input capture.

## Decisions

### Keep capture and policy in the console; replace only the dispatch target

The console retains its capture-phase listeners and trusted-touch sequence. A stable viewer-handle ref supplies `dispatchInput`, avoiding a second event layer and preserving the product-specific gesture ordering. The direct adapter lifecycle check is replaced by a mounted-viewer lifecycle check.

### Express scroll as a neutral wheel intent with a gesture-scoped residual

The desktop wheel listener keeps the default wheel source. The fallback touch-scroll bridge emits `{ type: "pointer", action: "wheel", source: "touch-gesture" }` intents using client coordinates and the original pixel deltas. On a scrolling `touchend` or `touchcancel`, the mounted path emits a separate `{ deltaX: 0, deltaY: 0, gestureBoundary: true }` intent at the last delivered touch coordinate; it never converts the changed terminal touch coordinate into another scroll sample. Remote-surface 1.4.1 clears that source's remainder without mapping, movement, or scroll for this zero-delta boundary, so a small residual cannot leak into the next touch gesture or desktop-wheel accumulator. The non-mounted direct bridge emits no terminal delivery because its state is already gesture-local.

### Give mounted input one movement authority

The direct bridge only maps and calls `control.move` when no viewer dispatcher is configured. When mounted, the bridge sends the wheel intent without a direct movement; the viewer router and its adapter perform the single movement that accompanies each non-zero wheel delivery. The mounted-only terminal boundary is metadata-only in remote-surface 1.4.1, so it cannot add a second movement.

### Use the viewer router as the sole settle gate

The console does not queue, replay, or reject input based on geometry state. The viewer holds dispatched intents until its own settle transition flushes them, preventing stale-coordinate dispatch while keeping one explicit authority for this state.

The rotation acceptance instrument sends a production-shaped tap while the router is unsettled, then changes the active geometry from portrait media to settled landscape media before flushing. It projects both states through `stream-viewer-geometry.ts`; the test asserts no pre-settle n.eko calls and verifies the delivered button coordinates equal only the post-transition projection.

Fallback touch taps use the same viewer-dispatch path when a dispatcher is installed. The legacy direct `clickNekoAt` path remains only for a bridge without a dispatcher. This makes the router the sole mounted-path input gate, including unscrolled coarse-pointer taps.

The console records each pointer press after it successfully calls the mounted viewer. Before that viewer unmounts for config retry or remount, the console sends one `pointercancel` for each recorded press and clears the record. A late DOM terminal event after teardown has no viewer to dispatch through and cannot add a second release.

### Cache only freshly confirmed editable geometry for trusted touches

The keyboard state machine keeps a confirmed editable rect for 1.5 seconds, the same bounded window as its trusted-touch gesture. A pointerup can synchronously focus the local keyboard proxy only when its mapped point is inside that fresh rect. A miss, expired entry, or absent entry keeps the existing late-confirmation affordance path. Geometry changes, remote navigation, and viewer remounts clear the cache before a new tap can use it. The cache is an eligibility fact only; it does not defer or move the focus call out of the trusted pointer handler.

### Prove parity from executable paths

Tests run the exported production direct-control delivery seam (without a viewer dispatcher) and the full production-shaped console-to-viewer-to-router-to-adapter path for the same fixture gesture. The direct side stops at its last touchmove, while the routed side invokes the exported production touch-terminal handler with a changed touchend point; that handler appends the metadata-only boundary from the last delivered state. The captured n.eko calls therefore remain equal. The fixture includes non-zero residuals over consecutive touch gestures and interleaved default desktop-wheel/touch sources, and asserts exactly one touch movement per touchmove plus zero control calls for each boundary. A mutation that substitutes the changed terminal point is required to fail this fixture. A separate test proves an intent remains absent while unsettled and appears after the router is settled and flushed.

### Make router loss visible in console diagnostics

The viewer's `onInputDiagnostic` hook writes held, flushed, dropped, coalesced, and unsupported input events to the existing debug logger. It records the diagnostic kind, reason, action, and source rather than introducing a second event queue or a user-facing message.

## Risks / Trade-offs

- [Host dispatch is invoked before viewer mount or after teardown] → The handle ref is null-checked and no direct fallback dispatch is introduced.
- [Touch bridge refactor changes gesture policy] → Retain its existing recognition, cancellation, and telemetry; replace only its delivery target and explicit terminal boundary.
- [Router delivery changes mapping or scroll math] → Production-seam parity includes move, scroll deltas, buttons, call ordering, source isolation, and terminal boundaries.
- [Router queue loss is opaque] → Forward the router diagnostic hook to the existing debug stream.
- [Source-shape tests pin the retired call] → Update only pins that assert the dispatch site; stop if an assertion’s semantics require weakening.
- [Cached geometry reaches an unrelated target] → Require the pointerup coordinate to be inside a fresh confirmed rect; expire and invalidate entries aggressively.

## Migration Plan

1. Add the OpenSpec contract and deterministic oracles.
2. Add handle/bridge dispatch seams and route pointer plus wheel intents through the viewer.
3. Run stream-directory tests, console type checking, reference implementation tests, and unchanged #347 tests.
4. Roll back by restoring the direct adapter and bridge targets; no persisted data or protocol state migrates.

## Open Questions

- None for this bounded increment; the ratified viewer API supplies the required wheel and settle-gate semantics.
