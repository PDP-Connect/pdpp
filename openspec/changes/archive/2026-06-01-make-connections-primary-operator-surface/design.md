## Context

`/dashboard/records` is already the Connections page and already calls the owner-authenticated run control route. The current console IA makes it discoverable only as an Explore subnav item, and the shared primary-action helper blocks `Sync now` for every browser-bound connector. That browser-bound rule was too broad: it is correct for connection creation and for push-mode local collectors, but not for an existing connection whose run can be started by the owner control surface and can request browser assistance through the run timeline.

## Goals / Non-Goals

**Goals:**

- Make Connections a first-class dashboard section.
- Let existing browser-bound connections start a run from the records row and detail page.
- Preserve honest non-clickable guidance for local-device push-mode connections.
- Keep Explore and Jump labels aligned with the existing search-surface split.

**Non-Goals:**

- Do not add a new connector enrollment flow.
- Do not change owner-agent REST semantics or scheduler behavior.
- Do not claim one-click source login completion for browser-bound sources.

## Decisions

- Promote `records` to a top-level `Connections` nav item. Alternative: keep it as an Explore subnav item and add more links. Rejected because run controls are operator actions, not record-content exploration.
- Make the primary-action classifier block only push-mode local-device connections. Alternative: continue blocking browser-bound connectors. Rejected because existing browser-bound connection runs are owner-runnable and can surface manual browser assistance after start.
- Keep browser-bound enrollment copy and runbook guidance separate from existing-connection run copy. Alternative: reuse one browser-bound rule for add, setup, and run. Rejected because those are different lifecycle states.

## Risks / Trade-offs

- Browser-bound run may immediately require owner interaction - the run timeline already owns that state, so the row only needs to start the run and refresh.
- A connector without configured browser runtime may fail after start - surfacing that as run/connection health evidence is more honest than hiding the run action for connections that are otherwise owner-runnable.
