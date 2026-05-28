# Tasks

## 1. OpenSpec

- [x] 1.1 Draft proposal, design, tasks, and spec deltas.
- [x] 1.2 `openspec validate add-grant-package-operator-visibility --strict` passes.
- [x] 1.3 `openspec validate --all --strict` passes.

## 2. Reference server `_ref` endpoints

- [x] 2.1 Add `listGrantPackagesForOwner({cursor, limit})` to
  `reference-implementation/server/auth.js`, paginating by created_at DESC
  with a bounded page size.
- [x] 2.2 Mount `GET /_ref/grant-packages` (owner-session gated) returning
  an envelope `{ data: GrantPackageSummary[], next_cursor, truncated }`.
- [x] 2.3 Mount `GET /_ref/grant-packages/:id` returning `{ data:
  GrantPackageDetail }` where the detail composes `getGrantPackageAccess`
  with the per-child source projection used by the hosted-MCP OAuth
  flow on issue. Honor 404 with the typed `not_found` envelope.
- [x] 2.4 Mount `POST /_ref/grant-packages/:id/revoke` calling
  `revokeGrantPackage`. Reject with `409 already_revoked` if the package
  is not active.
- [x] 2.5 Extend `executeRefSpineCorrelationsList` (kind=`grant`) so each
  spine row carries `grant_package_id` when the grant id is present in
  `grant_package_members`. The field is omitted when the grant is not a
  package member; existing consumers that ignore unknown fields continue
  to work. (The package's MCP refresh token has a NULL `grant_id`, so
  the binding fact lives on the membership table, not on tokens.)

## 3. Console: list + detail pages

- [x] 3.1 Add typed helpers `listGrantPackages`, `getGrantPackage`,
  `revokeGrantPackage` to `apps/console/src/app/dashboard/lib/ref-client.ts`.
  (Also `lookupGrantPackageIdForGrant` for the grant-detail pivot.)
- [x] 3.2 Add `/dashboard/grants/packages/page.tsx` mirroring the
  `ListWithPeekView` shape of `/dashboard/grants`.
- [x] 3.3 Add `/dashboard/grants/packages/[packageId]/page.tsx` with
  a revoke server action.
- [x] 3.4 Add `revoke-action.ts` next to the detail page that
  re-verifies the owner session and enforces a server-rendered
  `confirm_revoke=yes` field before calling `revokeGrantPackage`.
- [x] 3.5 Surface `grant_package_id` on `/dashboard/grants` rows as a
  small pivot link to the package detail page.
- [x] 3.6 Surface the package linkage on
  `/dashboard/grants/[grantId]/page.tsx` as a pivot link.
- [x] 3.7 Add the `Packages` entry to the Grants subnav in
  `apps/console/src/app/dashboard/components/shell.tsx`.

## 4. Tests

- [x] 4.1 Reference-implementation tests for `/_ref/grant-packages`,
  `/_ref/grant-packages/:id`, and `/_ref/grant-packages/:id/revoke`
  including the typed `not_found` and `already_revoked` cases.
  (`reference-implementation/test/ref-grant-packages.test.js`.)
- [x] 4.2 Spine correlations list test asserting
  `grant_package_id` is returned for child-grant rows whose grant id is
  present in `grant_package_members` and omitted otherwise.
  (Covered by the last case in `ref-grant-packages.test.js`, which
  drives `_ref/grants` end-to-end through the reference server.)
- [x] 4.3 Console invariants tests for the new list and detail pages:
  no secret material, confirm-required revoke form, package-id round-
  trip through URL, child-grant link targets.
  (`apps/console/src/app/dashboard/grants/packages/page.invariants.test.ts`
  and `…/grants/packages/[packageId]/page.invariants.test.ts`.)
- [x] 4.4 Update `apps/console/src/app/dashboard/grants/[grantId]/page.invariants.test.ts`
  to lock the new package pivot link when the grant is package-bound.

## 5. Validation

- [ ] 5.1 `pnpm -C reference-implementation run verify` passes.
  (Not yet rerun in this lane; focused targeted tests pass — see
  `repair-report.md`. Full `verify` is reserved for owner-merge.)
- [x] 5.2 `pnpm -C apps/console run types:check` passes.
- [x] 5.3 Targeted node --test passes for the new console tests.
- [x] 5.4 `openspec validate add-grant-package-operator-visibility --strict` passes.
- [x] 5.5 `openspec validate --all --strict` passes.

## Acceptance checks

- A hosted-MCP OAuth ceremony that approves two sources surfaces a
  package row on `/dashboard/grants/packages` with `member_count: 2`.
- Visiting the package detail page shows both child grants with their
  source, status, and a link to each child grant detail.
- Submitting the revoke form on the package detail page revokes both
  package memberships and flips the package row to `status: revoked`.
  The package's MCP refresh-token exchange is rejected on the next
  attempt (already verified end-to-end by `hosted-mcp-oauth.test.js`).
- A child grant viewed at `/dashboard/grants/[id]` shows the package
  pivot link when the grant is a package member, and does not show it
  for grants issued outside a package ceremony.

## Residual risks

- Full `pnpm -C reference-implementation run verify` was not rerun on
  this branch; targeted reference tests + `hosted-mcp-oauth.test.js` +
  spine regressions all pass. Owner should run full `verify` before
  merging to main.
- The protocol-level cascade leaves `grants.status` on each child row
  unchanged when a package is revoked. Enforcement runs through the
  revoked package-bound MCP token + revoked `grant_package_members`
  row; the operator-visible cascade on the package detail page lives on
  `member_status` and the member `revoked_at`. This matches existing
  `hosted-mcp-oauth.test.js` behavior and is intentional.
