## Why

Client registration deletion currently enumerates only rows that are active at
the start of the request. A package that is already marked revoked can still
retain an active `grant_package_members` row, leaving the authorization
projection inconsistent after its client identity is deleted. Existing token
revocation does not repair that authority row.

The reference implementation also needs a bounded repair path for historical
orphans. A missing `oauth_clients` row is not sufficient evidence of deletion:
external/CIMD identities can legitimately have no local registration row. The
repair must therefore use the successful `client.deleted` spine fact, preserve
history, and make bounded progress across restarts.

## What Changes

- Add a status-only, idempotent client-access reconciler shared by client
  deletion and maintenance. It revokes active grants, packages, package
  members, access tokens, and refresh tokens while retaining rows and existing
  revocation timestamps.
- Run that reconciler after the existing event-producing revoke paths so normal
  grant/package audit events and owner-token counts remain intact while
  historical partial states are repaired before the client deletion completes.
- Add a fenced `auth_client_access` maintenance cursor and exact keyset walk of
  successful `client.deleted` spine events. Each round is capped by client
  count and wall-clock budget, and the existing periodic maintenance timer gets
  one startup acceleration round without making startup wait for the fleet.
- Keep SQLite and PostgreSQL schema/index/cursor behavior aligned.
- Add route and store coverage for the stale-member defect, idempotency,
  status-only history preservation, exact evidence scoping, and cursor budget.

## What Does NOT Change

- No console page or console behavior is changed.
- No deletion is inferred from names, absent registration rows, CIMD metadata,
  or token state alone.
- No live database is queried or mutated by this change; the report contains a
  read-only operator plan only.
- Existing client deletion semantics remain owner-gated and return `404` after
  the registration row has already been removed.

## Impact

Affected backend surfaces are `server/auth.ts`, the auth reconciliation store,
the shared connector-maintenance sweep/cursor, and SQLite/PostgreSQL schema
bootstrap/migration code. The only recurring work added is a bounded phase on
the existing maintenance timer.
