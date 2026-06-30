## Context

The Sources page is a dynamic server route. A transient read failure during `router.refresh()` ejects to the records segment error boundary. The boundary already auto-retries, but it renders explicit failure copy immediately. That creates noisy "Couldn't refresh your connections" flashes even when the next retry succeeds.

The existing boundary also says "Showing last-known status", but it only has a client-side timestamp marker. It does not have a cached copy of the prior `SourcesView` cards, so that phrase is too strong.

## Decision

Use the existing single auto-retry as the escalation boundary:

- Before the retry has run, render quiet "refreshing source status" copy.
- If the retry still fails, render the explicit read-failure banner and manual retry controls.
- Phrase the timestamp as "Last successful load" rather than "Showing last-known status".

## Alternatives

### Cache and re-render the full source list in `sessionStorage`

Rejected for this tranche. It would duplicate the server-owned `SourcesView` model into client storage and add drift risk. If we want a full stale-data cache, it should be designed as a separate server/client cache boundary, not added inside an error boundary.

### Hide the boundary completely until retry completes

Rejected. A blank segment is worse than quiet progress copy if the route remains in error for several seconds.

## Acceptance checks

- The first read failure renders quiet retrying copy, not the explicit failure headline.
- The boundary still retries automatically once.
- The explicit failure banner remains available after the automatic retry has already failed.
- Final fallback copy reports the last successful load timestamp without claiming to render cached source cards.
