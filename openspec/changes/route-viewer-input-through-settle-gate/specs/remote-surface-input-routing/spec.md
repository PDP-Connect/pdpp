## ADDED Requirements

### Requirement: Mounted console input SHALL use the viewer settle-gated router

The console SHALL preserve its DOM capture and trusted-touch interaction policy while routing mounted pointer and wheel intents through the mounted remote-surface viewer handle. It SHALL NOT dispatch those mounted-path intents directly to the n.eko adapter or n.eko control bridge.

#### Scenario: Pointer capture reaches the mounted viewer
- **WHEN** the console captures an eligible pointer event while the video-element viewer is mounted
- **THEN** it SHALL dispatch a wire-shaped pointer intent through the viewer handle
- **AND** the trusted-touch focus sequence SHALL still execute in the console listener.

#### Scenario: Scroll arrives during a geometry transition
- **WHEN** the console dispatches a wheel intent while the viewer geometry is unsettled
- **THEN** the console SHALL rely on the viewer router to hold that intent
- **AND** the intent SHALL reach the adapter only after the viewer reports settled and flushes it.

#### Scenario: Rotation tap is delivered with settled geometry
- **WHEN** the console dispatches a tap during a portrait-to-landscape geometry transition
- **THEN** the viewer router SHALL NOT deliver the tap through the pre-transition projection
- **AND** after settling, the adapter SHALL receive coordinates projected by the post-transition console geometry seam.

#### Scenario: Mounted fallback tap uses the viewer router
- **WHEN** an unscrolled fallback touch ends while the mounted viewer dispatcher is available
- **THEN** the console SHALL dispatch production-shaped touch `pointerdown` and `pointerup` intents through that dispatcher
- **AND** it SHALL NOT call the direct n.eko tap helper on that mounted path.

#### Scenario: Remount releases a delivered active press once
- **WHEN** a pointer press was dispatched to the mounted viewer and the viewer begins teardown before its DOM terminal event arrives
- **THEN** the console SHALL dispatch exactly one pointer cancellation through the still-current viewer before unmounting it
- **AND** a late DOM terminal event SHALL NOT create a second release.

### Requirement: Cutover SHALL preserve delivered n.eko input effects

For identical eligible pointer and scroll gestures, routing through the mounted viewer SHALL preserve the resulting n.eko move, button, and scroll calls and their ordering relative to the previous direct path.

#### Scenario: Fixture gesture parity
- **WHEN** a pointer down/move/up sequence, wheel burst, and fallback touch-scroll drag are delivered through both paths under settled geometry
- **THEN** the routed path SHALL produce the same captured n.eko control calls as the direct path.

### Requirement: Fallback touch-scroll SHALL isolate each gesture's wheel residual

The fallback touch-scroll bridge SHALL label each mounted wheel intent with source `touch-gesture`. On each scrolling `touchend` or `touchcancel`, it SHALL emit a mounted-only terminal intent with `deltaX: 0`, `deltaY: 0`, and `gestureBoundary: true` at the last delivered touch coordinate; it SHALL NOT turn a changed terminal touch coordinate into an additional scroll sample. Desktop wheel intents SHALL retain the default source. The console SHALL use remote-surface 1.4.1 or later for this behavior.

#### Scenario: Consecutive touch gestures retain no residual
- **WHEN** a fallback touch gesture leaves a non-zero wheel remainder and ends
- **THEN** the terminal touch wheel intent SHALL clear the `touch-gesture` remainder
- **AND** the following touch gesture SHALL not realize the prior gesture's remainder.

#### Scenario: Desktop wheel remains independent
- **WHEN** desktop wheel and fallback touch-scroll intents are interleaved
- **THEN** the touch gesture remainder SHALL NOT affect the default desktop-wheel accumulator.

#### Scenario: Terminal boundary is metadata-only
- **WHEN** a scrolling fallback touch gesture ends after its last touchmove was delivered
- **THEN** the mounted path SHALL emit exactly one zero-delta boundary at that last delivered coordinate
- **AND** that boundary SHALL NOT add a n.eko map, move, or scroll call.
- **AND** a changed terminal touch coordinate SHALL NOT alter the boundary coordinate.

### Requirement: Mounted wheel delivery SHALL have one movement authority

When the viewer dispatcher is configured, the fallback touch-scroll bridge SHALL NOT call direct n.eko movement or scroll control methods. The mounted viewer router and adapter SHALL realize each non-zero wheel intent and its movement exactly once. The non-mounted direct bridge SHALL retain its historical lack of touchend/touchcancel delivery.

#### Scenario: Mounted fallback touch-scroll
- **WHEN** a fallback touch-scroll move is delivered while the viewer is mounted
- **THEN** the console SHALL dispatch the wheel intent to the viewer handle
- **AND** only the viewer adapter SHALL call n.eko movement for that intent.

### Requirement: Viewer input diagnostics SHALL reach console debug telemetry

The console SHALL pass the mounted viewer's input diagnostics to its debug logger so held, flushed, dropped, coalesced, and unsupported input outcomes are observable.

#### Scenario: Router coalesces an unsettled input
- **WHEN** the viewer router emits an input coalescing diagnostic
- **THEN** the console debug logger SHALL record the diagnostic kind, action, reason, and source.

### Requirement: Trusted touch SHALL use only fresh confirmed editable geometry

The console SHALL allow a trusted touch to focus its local keyboard proxy at pointerup only when the mapped pointer coordinate is inside a previously confirmed editable rect whose age is at most 1.5 seconds. It SHALL invalidate that cache on a geometry epoch change, remote navigation, and viewer remount. A cache miss or expiry SHALL preserve the existing late-confirmation affordance. The focus call SHALL remain synchronous in the trusted pointer handler.

#### Scenario: Warm confirmed rect receives a matching tap
- **WHEN** a trusted touch releases inside a fresh confirmed editable rect
- **THEN** the console SHALL synchronously focus the local keyboard proxy at pointerup.

#### Scenario: Cache entry no longer applies
- **WHEN** a cached rect has expired or is invalidated by a geometry epoch change, remote navigation, or viewer remount
- **THEN** a touch inside its former coordinates SHALL NOT focus the local keyboard proxy
- **AND** the late-confirmation affordance behavior SHALL remain available.

#### Scenario: Unrelated tap is outside the cached rect
- **WHEN** a trusted touch releases outside a fresh confirmed editable rect
- **THEN** the console SHALL NOT focus the local keyboard proxy.
