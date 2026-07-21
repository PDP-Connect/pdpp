## Why

A desktop-controlling stream attachment (operator viewport 1400x1005,
hasTouch=false) collapses to a phone-portrait n.eko screen (448x916) inside a
huge grey letterbox. n.eko's own logs show the correct desktop mode applied
first (1400x1050), then IMMEDIATELY overwritten by a portrait mode — on both
the first browser session and a same-session reconnect.

Production evidence (reference-implementation/server/streaming/routes.js:1419)
proves `backend_ready` fires on EVERY SSE `/events` GET — the first attach AND
every same-session reconnect (EventSource's internal auto-retry after a
transport blip; `companion.start` is a no-op on an already-started companion,
but `backend_ready` is written unconditionally after it regardless).

`stream-viewer.tsx`'s `backend_ready` handler requested an immediate viewport
measurement (`requestViewportMeasureRef.current?.("neko-backend-ready")`) in
the SAME synchronous handler that swaps which surface is rendered
(`setNekoSession(...)` mounts a new, differently-keyed `<NekoSurface
key={browserSessionId}>`). At that instant `containerRef.current` still
pointed at whichever surface was on screen a moment before — e.g. the CDP
placeholder's aspect-ratio-letterboxed box — so the measurement echoed the
OUTGOING surface's box back as the viewport for the INCOMING (desktop) surface.

## What Changes

- Defer the post-`backend_ready` viewport measurement until the surface it
  describes has actually attached its own container, keyed by
  `browserSessionId` so an unrelated attach can never drain it.
- On a same-session `backend_ready` replay (reconnect echo — the requested
  key already matches the currently-attached surface), measure immediately
  instead of deferring: that container is not an outgoing surface, and
  `<NekoSurface key={browserSessionId}>` does not remount on a reconnect, so
  a deferred request would never be drained.
- A request superseded by a new request (a second identity change arrives
  before the first surface attached) is discarded fail-closed, never left to
  drain against a later, unrelated attach.

## Capabilities

- Modified: `reference-implementation-architecture`

## Impact

- `apps/console/src/app/(console)/syncs/[runId]/stream/stream-viewer.tsx`
- New: `apps/console/src/app/(console)/syncs/[runId]/stream/stream-surface-measure-gate.ts`
