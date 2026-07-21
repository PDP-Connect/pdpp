## Context

An n.eko screen configuration POST changes the X root before Chromium's window watcher observes the new geometry. The existing selected-screen path waits for a container-local settle status, but baseline restore did not. Dynamic browser surfaces also did not carry that endpoint, leaving the necessary barrier unconfigured. Separately, abrupt runtime cleanup can release a leased surface without entering the route-owned presentation terminalizer.

## Decision

Treat the per-surface settle endpoint as required readiness data for a dynamically managed n.eko surface. Carry it with the allocated surface to the streaming target and require it before presentation mutations. Keep static Compose configuration compatible through its existing explicit endpoint.

Keep all restoration in the presentation lifecycle terminalizer. The adapter awaits settlement before marking a baseline restored. Runtime cleanup asks that terminalizer to restore or retire before releasing a managed lease. The terminalizer remains idempotent, so response, cancellation, expiry, child death, and watchdog paths share the same safety boundary.

Controller attachment cookies use a session-scoped name. Input and viewport routes require that controller attachment; secondary attachments remain read-only. Wire dimensions are floored before positivity validation so an accepted viewport cannot contain a zero dimension.

## Out of Scope

- Changing protocol Core or Collection Profile contracts.
- Changing the n.eko X11 watcher implementation.
- Adding browser fingerprint or device-emulation behavior.

## Acceptance Checks

- A blocked baseline restore blocks the interaction terminal path and `markRestored` until the surface reports its baseline dimensions.
- A failed restore settles through retire/recycle and never cleanly releases the surface.
- Dynamic allocation carries a valid settle endpoint into the adapter; its absence is an explicit readiness failure.
- Concurrent controllers retain authority only for their own sessions; observers receive read-only events but cannot mutate either session.
- Fractional dimensions that floor to zero are rejected at the wire seam.
