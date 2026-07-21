## Context

The prior oracle opened a playground target URL in a standalone phone-emulated page and treated source-marker readiness as an acceptable result. That bypassed the stream viewer route, its owner attachment, viewport dispatch, n.eko screen selection, window-follow request, and terminal restore barrier.

## Goals / Non-Goals

**Goals:**

- Exercise phone mode through the authenticated stream route and its controlling presentation attachment.
- Prove that the desktop baseline is captured and restored, not removed to make a phone check pass.
- Exercise restore behavior at the controller seam, including expiry with an injected clock/timer.
- Prove keyboard cache state transitions and their production wiring together.
- Fail the gate whenever the behavior evidence fails.

**Non-Goals:**

- Assert physical-device operating-system keyboard visibility.
- Use an external deployment as merge authority.
- Infer behavior from function names or source markers.

## Decisions

### Owner stream route is the phone-surface authority

The oracle opens the real run-interaction viewer route, retains its controller attachment cookie, and POSTs the portrait and landscape viewports through the route. Its deterministic n.eko boundary records the selected `412x915` and `915x412` configurations and the corresponding window-control acknowledgements. Resolving the interaction must then POST the captured `1440x900` baseline. An observer attachment is rejected, proving the selection belongs to the owner-present stream.

### Expiry is an attached-presentation terminal event

The streaming route schedules expiry after attach using injected `now`, timeout, and clear-timeout dependencies. Expiry enters the existing terminalizer, invalidates the token before restoration completes, waits for the companion stop/restore, and emits the resolved stream event. The test uses a store and timer controlled by an injected clock; it does not wait for wall time.

### Keyboard evidence has two required layers

`stream-keyboard-focus.ts` supplies pure state-machine cases for valid warm-cache focus and invalidation. The same test suite reads bounded production handler regions to establish that the actual viewer invokes `invalidateMobileKeyboardEditableRectCache` on remote navigation, geometry epochs, and n.eko remount. Neither layer is a green result alone.

### Calibration remains informational

The calibration command invokes the same local behavior gate and separately probes the external reference. External reachability never changes the command's exit status.

## Risks / Trade-offs

- [The n.eko HTTP boundary is simulated] → The route, controller, selection, acknowledgement, and restoration sequence are real; live n.eko remains separate evidence.
- [A terminal timer can retain a process] → The production timer is `unref`'d and is cleared by normal terminalization.
- [Viewer wiring is large to mount in a unit test] → The state machine is executed and the bounded production wiring is checked alongside it, rather than treating a name alone as proof.
