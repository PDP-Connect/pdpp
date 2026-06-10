## Why

The connection lifecycle primitives `revoke_connection` (stop future collection, preserve records) and `delete_connection` (erase exactly one connection's source-of-truth records/state) are shipped and audited — but only over the owner-agent bearer REST control plane (`POST /v1/owner/connections/:id/revoke`, `DELETE /v1/owner/connections/:id`). The operator console exposes neither. The records-list no-data copy directs the operator to "ask your owner agent to revoke it … or delete it."

That is a UX trap. An owner running the reference console who has not wired an owner agent cannot drop a connection from the UI at all, and must fall back to an out-of-band `curl` with an owner bearer. The connections-manageability audit ranks this the single most consequential manageability gap (P1.1), and the action-parity design note (`design-notes/console-action-parity-findings-2026-06-03.md`, gaps G3/G4) already prescribes the disposition: close these in a dedicated change with a confirmation ceremony, after owner decision, revoke leading and delete behind a record-aware typed-confirmation flow.

This change closes G3/G4 for the console without re-implementing any cascade: it adds a thin owner-session `/_ref` adapter over the *same* connector-instance store primitives the bearer routes use (`updateStatus` for revoke, `deleteConnection` for delete), and wires confirmed console controls through the established grant-package revoke server-action pattern.

## What Changes

- Add per-connection **Revoke** and **Delete** controls to the connection detail page (`/dashboard/records/[connector]`). This page only ever renders for a resolved, configured connection (catalog-only / unavailable rows `notFound()` before reaching it), so destructive controls never attach to a catalog row.
- **Revoke** copy states that already-collected records, grants, and audit are retained and only future collection stops. **Delete** copy states that this connection's records are erased, distinguishes itself from revoke, and warns that an active run or a default-account binding may be refused. Delete requires a deliberate confirmation ceremony (typed connection-id confirmation), not a bare button.
- Add two owner-session reference routes — `POST /_ref/connections/:connectorInstanceId/revoke` and `DELETE /_ref/connections/:connectorInstanceId` — as cookie-session siblings of the existing bearer routes, sharing the same store primitives and emitting the same non-secret `owner_agent.connection.revoke` / `owner_agent.connection.delete` audit events. No new destructive semantic, no Console-only cascade.
- Surface the shared typed outcomes honestly in the console: repeat-revoke (`connector_instance_inactive`), active-run refusal (`connection_run_active`), default-account refusal (`default_account_delete_unsupported`), and not-found as in-place messaging rather than a generic error boundary.

## Capabilities

### Modified Capabilities

- `reference-surface-topology`: operator dashboard connection-detail affordances — add owner-visible, confirmed **Revoke** and **Delete** controls scoped to one configured connection, each requesting the action over an owner-session reference route, with copy that distinguishes the two and does not overclaim retention/grant behavior.
- `reference-implementation-architecture`: add owner-session `/_ref` revoke/delete connection routes that delegate to the same connector-instance store primitives and audit emission as the owner-agent bearer routes (one cascade implementation, two auth adapters).

## Impact

- Affected code: `reference-implementation/server/routes/ref-connectors.ts` (two new mount functions), `reference-implementation/server/index.js` (wire them with the same store primitives + audit deps the bearer routes use), `apps/console/src/app/dashboard/lib/operator-runs.ts` (two client wrappers), `apps/console/src/app/dashboard/records/[connector]/actions.ts` (two `"use server"` actions), a new danger-zone client component under `records/[connector]/`, and `records/[connector]/page.tsx` (render it).
- No protocol-semantics change. No change to `/mcp` or `/v1`. The owner-agent bearer routes are untouched. Revoke remains zero-cascade; delete remains the already-shipped all-or-nothing connection-scoped purge that refuses active runs and default-account bindings.
- Non-secret audit behavior is unchanged: the new console path emits the same audit event types as the bearer path; bearer tokens, provider secrets, and record contents are never logged.

## Out of scope

- Owner-agent `cancel_run`→console parity is already shipped (`add-console-run-cancel-control`).
- Browser/API connector reconnect/repair (audit P1.2, separate lane).
- Connection re-initiate / undo-revoke from the console.

## Residual Risks

- Owner-only live verification deferred. The contract is proven deterministically: the owner-session `/_ref/connections/:id/revoke` and `DELETE /_ref/connections/:id` routes share the SAME store primitives + audit as the bearer routes and are covered by integration tests against a real SQLite store (revoke soft-flips + preserves the row, repeat → `connector_instance_inactive`; delete removes the row, repeat/unknown → `connector_instance_not_found`), plus the bearer-route suites that already pin the active-run / default-account refusals. The console wiring (typed-outcome classifiers, server-enforced confirmation, danger-zone copy/gating) is pinned by unit + structural tests. The one remaining check is operator-visible end-to-end behaviour an owner must run on a live console: open a real connection's detail page, revoke it and confirm records remain readable + the badge reflects revoked; delete a disposable connection with the typed-id confirm and confirm the row disappears from the list and its records are gone; and confirm a delete against a connection with an active run / a default-account binding is refused in place. Per `AGENTS.md`, this owner-only live step is recorded here rather than holding the change active indefinitely.
- The danger zone surfaces the connection id (not a live record count) in the delete confirm prompt; the true `deleted_record_count` is reported in the success banner + audit summary after the fact. A record-count preflight preview is a possible later refinement.
