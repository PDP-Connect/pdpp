## Context

Retained-size rows are reference-only derived state. The reference already has a bounded `reconcileDirtyRetainedSize()` path that repairs dirty retained-size rows from durable local state. A dataset summary read can still see global retained-size metadata marked stale or failed after a best-effort dirty marker, including cases where stream and connection rows are already clean.

## Design

The `_ref/dataset/summary` retained-size projection read should attempt the existing reconcile path only when metadata is stale or failed. A successful reconcile should be followed by a fresh projection read. A failed reconcile should return the last-known projection with stale or failed metadata intact.

The read path must also avoid retry storms. After a reconcile failure, the process records a short cooldown before trying again. During that cooldown, dashboard reads return the existing stale/failure state without invoking reconcile. This keeps the dashboard honest without turning every refresh into derived-state maintenance.

Owner dashboard hero copy should describe only the freshness state. It should not render `projection.last_error`, SQL text, storage maintenance labels, connection identifiers, or other diagnostic strings. Detailed diagnostic fields may remain available in reference-only payloads for operator inspection, but the hero is product copy.

## Alternatives

- Full rebuild on stale read: rejected because retained-size rebuild can scan the corpus and would make a dashboard read expensive.
- Retry reconcile on every stale read: rejected because a persistent reconcile failure would create unbounded repeat work under page refreshes.
- Show sanitized `last_error` in the hero: rejected because diagnostic text is not owner-action copy.

## Acceptance Checks

- Global-only retained-size dirty metadata with clean stream and connection rows reconciles to fresh without a full rebuild.
- Dirty retained-size rows reconcile successfully from `_ref/dataset/summary`.
- Reconcile failure returns stale or failed metadata and does not clear dirty state.
- Reconcile failure enters cooldown so the next dashboard read does not immediately retry reconcile.
- Dashboard stale/failure hero copy is concise and excludes raw internal reasons.
- `openspec validate auto-reconcile-retained-size-projection --strict` passes.
