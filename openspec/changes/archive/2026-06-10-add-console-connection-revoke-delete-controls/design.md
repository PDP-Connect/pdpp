# Design — Console connection revoke & delete controls

## Context

Backend connection-lifecycle is complete and DRY behind a single controller/store layer; the gap is purely at the console UI edge (connections-manageability audit, matrix #10/#11). The action-parity design note (`console-action-parity-findings-2026-06-03.md`) already decided the direction and the ceremony:

> Close G3 and G4 in a dedicated change … with a proper confirmation ceremony, after owner decision. Revoke (non-destructive of past data) can lead; delete should ship behind a record-count-aware, typed-confirmation flow.

This change implements that decision.

## Decision 1 — Where the controls live: the connection detail page only

The detail page `/dashboard/records/[connector]` resolves a concrete connection via `resolveConnectionForRecordsRoute(routeId)` and `notFound()`s when none resolves. A catalog-only connector, an unavailable/fallback catalog row, or a connector type with no configured connection therefore *never* reaches this page. Placing the danger zone here is the cheapest possible way to satisfy "catalog-only connectors must not get destructive controls" — the guard is the route itself, not a new branch. The records *list* keeps its existing "ask your owner agent" copy out of scope; the per-connection action is the trap-removal.

This also resolves the parity-note ambiguity concern (G3/G4 #2): the page already resolves one concrete `connection_id` / `connector_instance_id`, so the control addresses exactly one connection — never the ambiguous connector-only selector. We deliberately do **not** mirror the bearer routes' `connector_id` auto-select / `ambiguous_connection` path into the console; the console always has the resolved id in hand.

## Decision 2 — One cascade, two auth adapters

The bearer routes (`owner-connection-revoke.ts`, `owner-connection-delete.ts`) already prove the shape: resolve+verify owner ownership, call the store primitive, emit a non-secret audit event. The store primitives are:

- Revoke: `createRequestConnectorInstanceStore().updateStatus(id, { status: 'revoked', updatedAt, revokedAt })`
- Delete: `createRequestConnectorInstanceStore().deleteConnection(id, { ownerSubjectId, now, purge: {…} })`

The new `/_ref` routes call the *same* primitives with the *same* injected `purge` phases and the *same* `emitSpineEvent` event types. They differ from the bearer routes only in: (a) `requireOwnerSession` (cookie) instead of `requireToken`+`requireOwner` (bearer), and (b) the owner subject comes from `getOwnerSubjectId(req)` (session) instead of `getOwnerTokenSubjectId(req)` (token). No deletion/revoke logic is re-implemented; the console path cannot diverge from the agent path because both bottom out in one store method per action.

Rejected alternative: a console-only server action that talks to the bearer route with a minted owner token. That would require teaching the console an owner-bearer setup — explicitly forbidden by this lane's boundaries and by the owner-token separation the bearer route comment calls out ("without teaching `requireOwnerSession` a second identity source"). The cookie-session adapter keeps the console on its existing owner-session auth.

## Decision 3 — Confirmation ceremony asymmetry

Revoke is reversible-in-spirit (records preserved; re-initiate restores collection) and non-destructive of data, so it uses the lightweight grant-package pattern: a confirm checkbox + a destructive-variant submit, enforced server-side (`confirm_revoke=yes`).

Delete erases records irreversibly. Per parity-note ceremony requirement #1, the console delete requires the operator to **type the connection id** into a field that must match before the destructive submit enables, plus a server-side `confirm_delete` equal to the connection id. A scripted POST without the matching id round-trips back with a banner — confirmation is enforced server-side, not just client-side, exactly as the grant-package revoke action enforces its checkbox.

We surface the connection id (already shown on the page's identity line) rather than a record count in the confirm prompt: the page does not always have an authoritative, current record count cheaply, and the delete route's audit summary reports the true `deleted_record_count` after the fact. The copy states records "for this connection" are erased without inventing a specific N the page cannot guarantee — honest-denominator discipline from the voice guide.

## Decision 4 — Honest typed-outcome surfacing

The shared store raises typed errors that the console must not flatten into a generic boundary:

| Outcome | Code | Console message |
|---|---|---|
| repeat revoke | `connector_instance_inactive` (400) | already revoked / not active |
| delete during active run | `connection_run_active` (409) | a run is in flight; stop it first |
| delete default-account binding | `default_account_delete_unsupported` (409) | this default-account connection can't be deleted from here |
| foreign/unknown id | `connector_instance_not_found` (404) | connection not found |

These come back from the same `handleError` envelope the bearer route uses. The server action maps them to a redirect query param the page renders as an in-place banner (grant-package `revoke_error` pattern), then revalidates so the now-revoked status or removed connection is reflected.

## Out of scope / non-goals

- No undo-revoke / re-initiate control (separate lane).
- No connector-only ambiguous addressing in the console (the page resolves one id).
- No record-count preflight call before delete (the post-hoc audit summary carries the true count; a preflight is a later refinement if owners want a "this will erase N records" preview).
- No change to the records *list* "ask your owner agent" copy beyond what falls out naturally; trap removal is the per-connection control.

## Acceptance checks

- `openspec validate add-console-connection-revoke-delete-controls --strict` and `openspec validate --all --strict` pass.
- Console tests: a resolved connection renders revoke + delete affordances; revoke copy says records/grants retained + future collection stops; delete copy says this connection's records are erased and active/default-account may be refused; delete requires typed-id confirmation; the server actions call the `/_ref/connections/:id/revoke` and `DELETE /_ref/connections/:id` routes (shared route, not a duplicate cascade).
- Reference route tests: `POST /_ref/connections/:id/revoke` flips one instance to `revoked` via the shared store primitive and emits the audit event; `DELETE /_ref/connections/:id` delegates to the shared `deleteConnection` and emits the audit event; both reject a non-owner session.
- `pnpm --filter pdpp-console types:check`; `git diff --check`.
