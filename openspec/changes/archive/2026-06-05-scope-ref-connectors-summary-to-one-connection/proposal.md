# Proposal: scope-ref-connectors-summary-to-one-connection

## Why

Every operator-console record subpage — the per-connection record list
(`/dashboard/records/[connector]`), the per-stream list, the per-record detail,
and the stream health page — resolves its route param to one connection by
calling `resolveConnectionForRecordsRoute(routeId)`, which fetches the
**all-connector** summary projection (`GET /_ref/connectors`) and filters the
result down to the single matching connection in the browser.

The all-connector projection is expensive: `listConnectorSummaries` runs a
per-connection fan-out (schedule, latest run, last-successful run, detail-gap
projection, outbox axis, attention projection, browser-surface projection, local
coverage axis — roughly eight reads per connection) for **every** configured
connection, even though a record subpage needs exactly one. On an instance with
N connections, opening one connection's records page does ~8N reads to render a
page that depends on one connection's summary. This path runs on every
records-dashboard poll, so the wasted reads compound under the active-run poll
cadence — the same hot path a prior lane already trimmed from 2N to 2 for the
shared browser-surface tables.

The summary the subpage needs is a single element of the list the reference
already produces. The reference can resolve one connection and project only that
connection from the same code path, with no second source of truth: the
single-connection projection SHALL be the same per-connection projection the list
uses, so the two cannot drift.

## What Changes

- Add a `reference-implementation-architecture` requirement that the
  `GET /_ref/connectors` connection-summary route accepts an **optional**
  connection-selector query parameter. When present, the route SHALL project and
  return only the connection(s) the selector resolves, using the same
  per-connection projection as the unscoped list. When absent, the route behaves
  exactly as before (all configured connections).
- Require the selector to use the **same resolution precedence** the console
  resolver uses today: an exact match on `connection_id` / `connector_instance_id`
  is preferred; otherwise the first connection whose `connector_id` matches. The
  route SHALL NOT invent a new addressing scheme.
- Require the scoped response to remain the **same `{object: "list", data}`
  envelope** with the same per-connection item shape — a list of zero or one
  matching connection. A selector that resolves nothing returns an empty list,
  not a 404 and not a silently-unscoped full list.
- Require the scoped path to be a **read that does not persist a connection** and
  to **not** run the per-connection fan-out for non-matching connections, so a
  one-connection request costs one connection's worth of reads rather than N.

## Capabilities

Modified:
- `reference-implementation-architecture`

Added:
- None

Removed:
- None

## Impact

- Reference implementation and operator-console surface only. Does not change the
  public record / query / search / schema / blob `/v1` API, the grant model, or
  owner-auth posture: the route remains owner-session-gated exactly as before.
- The query parameter is additive and optional. `refListConnectors` is not in the
  reference's request-validation allowlist, so the added parameter passes through
  to the handler with no transport-level rejection and unscoped callers are
  unaffected. The change updates the reference-contract route descriptor (and the
  regenerated OpenAPI/docs) to document the optional selector.
- No new table, column, or migration. The scoped path reuses the existing
  per-connection projection; the list and the single-connection projection share
  one function, so they cannot drift. The console resolver passes the route param
  through and keeps the same match precedence, so existing record list/detail
  pages and relationship links render from the same canonical data.
