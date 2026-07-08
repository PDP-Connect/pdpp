## Rationale

RBS handled mobile touches as mouse-backed gestures because stationary touch pairs were not the most reliable click primitive for the remote browser surface. The same convention is already documented in `NekoPointerController`: a tap is a primary-button down/up pair, and native touch is avoided by default when it can double-deliver or fail to synthesize a click.

The CDP adapter should use the same host-facing policy for local DOM touch events. The adapter owns this boundary because it already maps local DOM coordinates into stream viewport coordinates and dispatches CDP input commands.

## Design

The DOM touch listener path SHALL:

- call `preventDefault()` for handled touch events so the local browser does not scroll, zoom, or synthesize a second mouse gesture;
- suppress mouse events for 1 second after touch activity;
- blur the remote active element before starting the touch gesture, then focus the local surface container without scrolling;
- remember the first active touch's start and last client coordinates;
- treat movement below 8 CSS pixels as a tap candidate;
- on threshold crossing, send a CDP mouse press at the start coordinate and subsequent mouse moves with `buttons: 1`;
- on touch end, send a CDP mouse release for a drag, or a CDP mouse press/release pair for a tap;
- on touch cancel during a drag, release the held mouse button at the last known coordinate.

Programmatic `sendPointer()` continues to forward the caller's declared pointer type. This change only affects DOM touch events captured by the adapter after mount.

## Alternatives Considered

- Keep forwarding DOM touch as CDP `Input.dispatchTouchEvent`: rejected because the research target is RBS parity, and the current behavior is the documented gap.
- Extract a generic touch controller: deferred. The behavior is small and CDP-specific because it dispatches CDP mouse input and interacts with the adapter's throttling and coordinate mapping. A separate controller would be useful only if another backend consumes the same local DOM policy.
- Change `dispatchCdpPointerInput` globally so all touch payloads become mouse events: rejected because programmatic callers may intentionally request CDP touch input.

## Acceptance Checks

- Unit tests prove tap, drag threshold, drag cancel release, and synthetic mouse suppression.
- `pnpm --filter @opendatalabs/remote-surface test -- cdp-surface-adapter.test.ts` passes.
- `pnpm --filter @opendatalabs/remote-surface typecheck` passes.
- `openspec validate add-cdp-mobile-touch-parity --strict` passes.
