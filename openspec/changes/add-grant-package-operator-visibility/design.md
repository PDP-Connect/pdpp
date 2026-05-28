## Context

`add-hosted-mcp-grant-packages` (archived complete, awaiting owner archive)
landed the grant-package primitive: one approval ceremony issues one
package-bound MCP refresh token plus one source-bounded child grant per
selected source. The protocol semantics and the resource-server enforcement
are intentionally narrow — each tool call still runs under exactly one
child-grant scoped bearer; the package never appears on persisted
subscription rows; the package's `revokeGrantPackage` is implemented as a
convenience wrapper that revokes every child.

The operator surface lags. From `/dashboard/grants` today:

- a multi-source approval looks like N independent rows with no shared
  attribution;
- there is no way to see the per-source breakdown that the OAuth picker
  showed at approval time;
- there is no way to revoke the package as a unit — the operator can
  only revoke each child grant manually;
- the existing `grant_package.issued` and `grant_package.revoked` spine
  events are recorded but the child-grant timeline does not surface them
  because the events' `object_type` is `grant_package`, not `grant`.

This is the discoverability / lifecycle gap the original change explicitly
deferred ("Decide how package-level audit works: package id, timeline
grouping, dashboard display, and whether a revoke-package affordance is
offered" — `design-fast-broad-agent-consent` tasks.md §3).

## Goals / Non-Goals

**Goals:**

- The operator can list every grant package on the deployment from
  `/dashboard/grants/packages` with status, source count, bound subject
  and client, created/revoked timestamps.
- The operator can open a package detail page that shows each member
  child grant, the source the child was approved for, the child's status,
  and a link to the child's standalone detail.
- The operator can revoke a package from its detail page using the same
  confirmation pattern as the grant detail page. Revocation cascades to
  the children exactly as `revokeGrantPackage` already does today.
- A child grant viewed standalone surfaces its `grant_package_id` and
  links back to the package detail page when applicable.
- The new endpoints are owner-session gated, return typed envelopes that
  mirror the existing `/_ref/*` conventions, and do not leak any
  protocol-internal fields that the existing grant or event-subscription
  surfaces already hide (token hashes, raw refresh secrets, etc.).

**Non-Goals:**

- Owner-authored package creation outside the OAuth ceremony. Letting the
  operator assemble a package from existing child grants would change the
  package's semantics (it is currently always issued atomically with its
  children) and would require new storage shape and authorization logic.
  Out of scope.
- Cross-source PDPP grants. The source-bounded child-grant model is
  preserved. The package is a grouping, not a new grant kind.
- Package-bound event subscriptions. Subscriptions are bound to a single
  child grant per `add-mcp-event-subscription-client-tools` (§4.6). The
  package detail page reuses the existing
  `/dashboard/event-subscriptions?grant_id=…` filter for navigation; no
  new subscription wire shape.
- CLI parity (`pdpp ref grant-packages …`). The operator console covers
  the SLVP visibility need. A CLI surface can land in a small follow-on.
- Owner-facing UI for the package CSRF / confirmation copy. Reuse the
  existing grant-revocation confirmation pattern.

## Decisions

### 1. Three new `_ref` endpoints, no new storage shape

```
GET    /_ref/grant-packages
GET    /_ref/grant-packages/:id
POST   /_ref/grant-packages/:id/revoke
```

The list endpoint paginates by `created_at DESC` and returns rows with
`{ package_id, subject_id, client_id, status, member_count, created_at, revoked_at }`.
The detail endpoint composes `getGrantPackageAccess` (already
implemented) with a lightweight source-per-child projection that mirrors
the shape returned by the existing hosted-MCP OAuth flow on
authorization. The revoke endpoint is a thin wrapper around the existing
`revokeGrantPackage` that re-verifies the owner session.

**Alternative considered:** add a list endpoint only and route the
revoke through the existing `/_ref/grants/:id/revoke` per child. Rejected
because the operator must perform N round-trips and cannot atomically
revoke the package — the very gap this change addresses.

**Alternative considered:** make `/v1/grants` expose package metadata
to clients. Rejected because the client-side API contract is documented
to be source-bounded; package context is an operator concern, not a
client concern.

### 2. Surface `grant_package_id` on child-grant rows

`/_ref/grants` already returns rows joined from the existing spine
correlations table. The token table carries `package_id`; when the
binding token for the spine row's most recent grant.issued event is a
package token, the spine row surface adds `grant_package_id`. The
existing `RefSpineCorrelationsList` operation extends its envelope with
this optional field. Clients that do not understand the new field ignore
it.

The grant detail timeline does not gain new event types in this change
— the existing `grant_package.issued` event under `object_type:
grant_package` is enough for an operator who lands on the package detail
page to see the audit trail. A future tranche could fold the
`grant_package.issued` event into the child-grant timeline view as a
pinned "issued under package" header; not in scope here.

**Alternative considered:** invent a `grant.bound_to_package` event type
keyed against the child grant. Rejected because the binding fact is
already represented in the tokens table and the existing
`grant_package.issued` event; minting a redundant event type would
require schema migration and new operation code for no behavioral gain.

### 3. Dashboard surface: list + detail, no cross-cutting affordances

- `/dashboard/grants/packages` — list page, mirrors the existing
  `/dashboard/grants` `ListWithPeekView` shape so the user does not have
  to learn a new layout.
- `/dashboard/grants/packages/[packageId]` — detail page with: package
  metadata, child-grant table (source, status, link), revoke server
  action, link to filtered event subscriptions across all children.
- `/dashboard/grants` rows that belong to a package surface the package
  id as a small pivot link. The package row does not replace per-grant
  revocation; both affordances coexist.
- The Grants subnav grows by one entry: `Packages` between `Pending
  approvals` and `Grant request`.

**Alternative considered:** absorb packages into the grants list as
collapsible rows. Rejected because (a) packages are a separate noun
operators need to address as a unit, and (b) hiding individual grants
under a package collapse complicates the existing per-grant revocation
workflow.

### 4. Revocation UX mirrors grant revocation

The revoke server action on the package detail page:

- requires the owner session via `requireDashboardAccess`,
- enforces a server-rendered `confirm_revoke=yes` field exactly like
  the event-subscription disable affordance,
- calls `revokeGrantPackage` on the storage layer,
- redirects back to the package detail page with a confirmation banner
  on success or a typed error on failure.

The detail page renders the existing list of child grants with their
post-revocation statuses; the operator sees the cascade directly.

### 5. Apps/web is not mirrored

`split-public-site-and-operator-console` (tasks 4.x) plans the removal
of `apps/web/src/app/dashboard/**` in favor of `apps/console`. New
operator surfaces ship only in `apps/console`. The migration plan is the
single source of truth for which surface receives new dashboard pages.

## Risks / Trade-offs

- **Token-table read on every spine row.** Surfacing `grant_package_id`
  on the grants list adds a join. The existing spine query is already
  doing one join; adding the tokens table is bounded by the number of
  active grants the operator owns (small in practice). If the query
  becomes a hotspot, the implementation lane can cache the projection
  on the spine row at issuance time.
- **Operator could revoke a package they thought was small.** The
  detail page must show the full child list before the revoke
  confirmation so the operator sees the blast radius. The implementation
  lane SHALL surface the count and the source list above the revoke
  button, not in a collapsed section.
- **Pagination on `/_ref/grant-packages`.** Cursor pagination by
  created-at descending matches the grants list contract. Default page
  size 50, max 200, same as `_ref/grants`.

## Acceptance Checks

- `openspec validate add-grant-package-operator-visibility --strict`
  passes.
- `openspec validate --all --strict` passes.
- After implementation:
  - `GET /_ref/grant-packages` returns a paginated envelope of packages
    with the listed fields.
  - `GET /_ref/grant-packages/:id` returns the detail shape with
    children, status, and timestamps.
  - `POST /_ref/grant-packages/:id/revoke` revokes every child and
    flips the package row to `status: revoked`.
  - `/dashboard/grants/packages` renders the index against the new
    endpoint.
  - `/dashboard/grants/packages/:id` renders the detail and exposes
    the revoke server action; revocation invalidates the package's
    MCP refresh token on the next exchange (already implemented at
    the auth layer).
  - `/dashboard/grants` rows whose binding token is a package token
    surface a "package …" pivot link to the package detail page.
  - A regression test verifies each page's invariants (no secret
    fields, package id round-trips through the URL, child-grant link
    targets, etc.).
