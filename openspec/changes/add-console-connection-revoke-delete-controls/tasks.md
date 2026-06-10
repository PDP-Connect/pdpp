# Tasks — add-console-connection-revoke-delete-controls

## 1. Owner-session `/_ref` revoke + delete adapters (shared cascade)

- [x] 1.1 Extend `MountRefConnectorsContext` in `reference-implementation/server/routes/ref-connectors.ts` with the shared revoke/delete dependencies: `updateConnectorInstanceStatus`, `deleteConnection`, `getOwnerSubjectId` (already present), `emitSpineEvent`, `createTraceContext`, `ensureRequestId`, `setReferenceTraceId`, `canonicalConnectorKey` (already present).
- [x] 1.2 Add `mountRefConnectionRevoke(app, ctx)` → `POST /_ref/connections/:connectorInstanceId/revoke`: resolve+verify the connection via `resolveRefConnectionNamespace`, call `ctx.updateConnectorInstanceStatus(id, { status: 'revoked', updatedAt, revokedAt })`, emit `owner_agent.connection.revoke` audit, return the revoked projection.
- [x] 1.3 Add `mountRefConnectionDelete(app, ctx)` → `DELETE /_ref/connections/:connectorInstanceId`: call `ctx.deleteConnection(id, { ownerSubjectId, now })`, emit `owner_agent.connection.delete` audit with the deletion summary, return the summary. Let the store's typed errors (`connection_run_active`, `default_account_delete_unsupported`, `connector_instance_not_found`) flow through `handleError`.
- [x] 1.4 Wire both mounts in `reference-implementation/server/index.js` alongside the existing `mountRefConnection*` calls, injecting the SAME `updateConnectorInstanceStatus` / `deleteConnection` (with `purge` phases) / audit deps the bearer routes already receive (lines ~3981/4022).
- [x] 1.5 Reference route tests: revoke flips one instance + emits audit + rejects non-owner-session; delete delegates to shared `deleteConnection` + emits audit + rejects non-owner-session; typed refusals surface unchanged.

## 2. Console client wrappers

- [x] 2.1 Add `revokeConnection(connectionId)` and `deleteConnection(connectionId)` to `apps/console/src/app/dashboard/lib/operator-runs.ts`, posting/deleting via `connectionControlPath(connectionId, "/revoke")` and `connectionControlPath(connectionId, "")` with `fetchAs` (owner-session cookie), classifying typed errors.
- [x] 2.2 Client-wrapper result tests for the typed-outcome classification (mirrors `cancel-run-result.test.ts`).

## 3. Console server actions

- [x] 3.1 Add `revokeConnectionAction(formData)` and `deleteConnectionAction(formData)` to `apps/console/src/app/dashboard/records/[connector]/actions.ts`: re-verify owner session (`requireDashboardAccess`), enforce `confirm_revoke=yes` / `confirm_delete === connection_id` server-side, call the client wrapper, redirect back with `message` / `error` query, `revalidatePath`.
- [x] 3.2 Server-action tests: confirmation enforced server-side; typed errors mapped to the in-place banner param; success revalidates.

## 4. Console danger-zone UI

- [x] 4.1 Add a `ConnectionDangerZone` client component under `records/[connector]/` with a Revoke form (confirm checkbox, destructive submit, retain-records copy) and a Delete form (type-the-connection-id confirm, destructive submit, erase + active-run/default-account copy).
- [x] 4.2 Render it on `records/[connector]/page.tsx` (always — the page only renders for a resolved connection), passing `connectionId`/`connectorInstanceId` and the typed-outcome banner from `searchParams`.
- [x] 4.3 Component/page tests: real connection shows both affordances; revoke copy retains records + stops future collection; delete copy erases this connection + may refuse active/default-account; delete submit gated on matching typed id; the danger zone is absent from catalog-only contexts (covered by the route guard — assert the list view / no-connection path renders no destructive control).

## 5. Validation

- [x] 5.1 `openspec validate add-console-connection-revoke-delete-controls --strict`
- [x] 5.2 `openspec validate --all --strict`
- [x] 5.3 Focused console tests green; reference route tests green.
- [x] 5.4 `pnpm --filter pdpp-console types:check`
- [x] 5.5 `git diff --check`

## Acceptance checks

- A resolved connection's detail page renders Revoke + Delete; a catalog-only / no-connection context renders neither.
- Revoke confirmation copy says records/grants retained + future collection stops; delete confirmation copy says this connection's records are erased and active/default-account may be refused; delete requires reproducing the connection id (server-enforced).
- The server actions call `POST /_ref/connections/:id/revoke` and `DELETE /_ref/connections/:id`; those routes delegate to the same store primitives + audit as the bearer routes (no duplicate cascade).
- All validations above pass.
