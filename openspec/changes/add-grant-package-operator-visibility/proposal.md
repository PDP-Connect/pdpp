## Why

`add-hosted-mcp-grant-packages` issued one normal source-bounded child grant per
source plus a package-bound MCP refresh-token pair. The protocol-side semantics
are clear: the package is a convenience grouping for approval and revocation,
the child grants remain the enforcement unit. The operator console does not
reflect that today.

An owner viewing `/dashboard/grants` sees one row per child grant with no
indication of which approval ceremony issued them. There is no
`/dashboard/grants/packages` index, no per-package detail view, no
package-revoke affordance from the dashboard, and no link from a child grant
to the package it belongs to. The current path to revoke a package is "open
the dashboard, find each child grant, revoke each one separately, hope you
have not missed one" — the exact UX failure the package primitive was meant
to prevent at the approval ceremony.

This change scopes the smallest correct operator-visibility slice that
respects the existing protocol contract.

## What Changes

- Add a read-only `/_ref/grant-packages` index and `/_ref/grant-packages/:id`
  detail endpoint, owner-session gated, returning the package, its child
  grants (id, source, status), the bound subject and client, and timestamps.
  These read endpoints reuse the existing `getGrantPackageAccess` helper and
  the grant-package store; no new storage shape.
- Surface the existing `grant_package.issued` and `grant_package.revoked`
  spine events on a child grant's timeline by extending
  `executeRefSpineCorrelationsList` (kind=`grant`) and the grant-timeline
  envelope so the child carries its `grant_package_id` field whenever the
  bound token came from a package. The current child-grant spine row is not
  changed; the package id is read alongside it from the existing tokens
  table.
- Add a `/dashboard/grants/packages` index page (read-only) and a
  `/dashboard/grants/packages/[packageId]` detail page that show the
  member child grants, the sources the package was approved over, the
  current status (`active` or `revoked`), and a link to each child grant
  for per-source revocation. The dashboard does not invent any new
  revocation primitive in this change; package revocation routes through
  the same `/_ref/grant-packages/:id/revoke` server action that wraps
  `revokeGrantPackage` (already implemented at the storage layer).
- Surface the package linkage on `/dashboard/grants` rows and on the
  existing grant detail page: when a row was issued under a package, show
  the package id with a link to the package detail page.
- Cover the new endpoints, server actions, and dashboard surfaces with
  invariants tests next to the affected files.

## Capabilities

### Modified

- `agent-consent-bundling`: adds operator-facing read and revoke
  affordances for grant packages without altering the existing child-grant
  enforcement model.
- `reference-implementation-architecture`: adds `/_ref/grant-packages*` to
  the documented `_ref` surface and `/dashboard/grants/packages*` to the
  operator-console surface taxonomy.

### Added

- None. No new capability folders.

### Removed

- None.

## Impact

- Affected code (proposed):
  - `reference-implementation/server/auth.js` — small helper to list
    packages owned by a subject, paginating by created-at.
  - `reference-implementation/server/index.js` — new owner-session-gated
    `/_ref/grant-packages` and `/_ref/grant-packages/:id` routes plus a
    `/_ref/grant-packages/:id/revoke` route that calls the existing
    `revokeGrantPackage`.
  - `reference-implementation/operations/ref-spine-correlations-list/`
    and `ref-grant-timeline/` (if present) — annotate child-grant rows
    with their `grant_package_id` when the binding token has one.
  - `apps/console/src/app/dashboard/grants/packages/page.tsx` — new
    list page.
  - `apps/console/src/app/dashboard/grants/packages/[packageId]/page.tsx`
    — new detail page with the revoke server action.
  - `apps/console/src/app/dashboard/grants/page.tsx` and
    `[grantId]/page.tsx` — surface the package linkage on child-grant
    rows when present.
  - `apps/console/src/app/dashboard/lib/ref-client.ts` — typed helpers
    for the new `_ref` endpoints.
- Affected behavior:
  - Operators can list, inspect, and revoke grant packages from the
    console.
  - Owners viewing a child grant can see and jump to the parent package.
  - Per-grant revocation still works as before; package revocation
    cascades to children exactly as today's `revokeGrantPackage` already
    does.
- Protocol impact: none. No new protocol semantics; the package
  primitive is already in `add-hosted-mcp-grant-packages`. This change
  only exposes the already-issued packages to the operator surface.

## Out of scope (and why)

- **Owner-facing package authoring outside of OAuth ceremonies.** The
  package primitive is only created by the hosted MCP authorization flow
  today. Letting the owner pre-author a package, or assemble one from
  existing child grants, would change the package semantics and belongs
  in a follow-on change.
- **Cross-source MCP grants.** Still explicitly rejected; the source-
  bounded child-grant model is preserved.
- **Package event subscriptions.** Event subscriptions are bound to a
  single child grant per `add-mcp-event-subscription-client-tools`. The
  package detail page surfaces each child grant's subscriptions via the
  existing `/dashboard/event-subscriptions?grant_id=…` filter; no
  new subscription wire shape.
- **CLI parity.** Adding `pdpp ref grant-packages …` to the operator
  CLI is a separate small slice; the operator console covers the SLVP
  visibility need.
- **Inviting the owner to revoke a package from the grants page.** The
  revoke affordance lives only on the package detail page, behind the
  existing confirmation pattern used for grant revocation. The grants
  list page only surfaces a passive pivot link to the package detail.
