# Design: scope-ref-connectors-summary-to-one-connection

## Problem

`apps/console/src/app/dashboard/records/connection-route.ts` resolves a record
subpage's `routeId` to a single connection by:

```ts
const response = await listConnectorSummaries(); // GET /_ref/connectors (all N)
return response.data.find(
  (s) => s.connection_id === routeId || s.connector_instance_id === routeId,
) ?? response.data.find((s) => s.connector_id === routeId) ?? null;
```

`listConnectorSummaries` (`reference-implementation/server/ref-control.ts`) maps a
per-connection projection over *every* configured connection: schedule, latest
run, last-successful run, detail-gap projection, outbox axis, attention
projection, browser-surface projection, local coverage axis. That is ~8 reads ×
N connections to render a page that consumes exactly one connection's summary.

The resolver is shared by five subpages (`[connector]`, `[connector]/[stream]`,
`[connector]/[stream]/[recordKey]`, `[connector]/[stream]/health`), so fixing the
resolver fixes all of them.

## Approach

Scope the work at the reference, not the console, so the console cannot grow a
second projection that drifts from the canonical one.

1. **Extract the per-connection projection.** Lift the body of the
   `listConnectorSummaries` map callback into a single
   `projectConnectorSummaryForInstance(instance, deps)`. `listConnectorSummaries`
   keeps mapping it over all instances. This is a pure refactor: same inputs,
   same output, proven by the existing summary tests.

2. **Add a connection-scoped entry point.** `getConnectorSummaryForRoute(routeId)`
   reads the registered connectors + the dashboard instance rows (the cheap reads
   `listConnectorSummaries` already does once), resolves the matching instance by
   the **same precedence** the console uses, and projects only that one instance
   via `projectConnectorSummaryForInstance`. Non-matching connections never enter
   the fan-out.

3. **Carry the selector over HTTP.** `GET /_ref/connectors` gains an optional
   `connection` query parameter. With it, the route projects the resolved
   connection (0 or 1 items); without it, the route returns all connections,
   byte-for-byte as before. The response stays `{object: "list", data}`.

4. **Pass the route param through in the console.** `listConnectorSummaries`
   (ref-client) gains an optional `connectionRouteId`;
   `resolveConnectionForRecordsRoute` passes the routeId and keeps the same
   `find`-precedence on the returned 0-or-1 list (a no-op on a single match, but
   it preserves the exact behavior for the `connector_id`-only fallback).

## Why scope at /_ref/connectors instead of a new route

A dedicated `/_ref/connections/:id/summary` route is cleaner REST but a larger
contract surface (new operation id, new response wiring, new docs entry) for no
behavioral gain — the console already filters a list and the honest answer to
"summary for this selector" is a list of 0 or 1. An optional query on the
existing route is the smallest durable-contract delta and keeps one operation
owning the connection-summary shape.

## Resolution precedence (must match the console exactly)

1. Exact match on `connection_id` **or** `connector_instance_id` === selector.
2. Else first connection whose `connector_id` === selector (the
   `/dashboard/records/gmail` fallback when the row had no concrete connection
   id). "First" is the dashboard instance-row order, identical to the list order
   the console filtered before.

The `row-routing.test.ts` contract (a known `connection_id` routes to its own
connection; two same-connector connections route distinctly) is preserved because
the precedence is unchanged — only *where* it runs moves from console to
reference, and the console keeps its `find` as a defensive no-op.

## Drift safety

The single-connection projection and the list projection call the *same*
`projectConnectorSummaryForInstance`. There is no second heuristic, no cache, and
no dashboard-only shortcut. A field added to the summary appears in both paths
automatically. This satisfies the guardrail "do not add another dashboard
heuristic or hidden cache that can drift from the all-connection projection".

## Out of scope

- The all-connector records-index page (`/dashboard/records`) still needs every
  connection's summary; it is not changed.
- Other `listConnectorSummaries` callers (`schedules`, `operator-grant-request`,
  `runs/[runId]/stream`, explore) genuinely need all connections and are not
  changed.
- The per-connection fan-out reads themselves (the ~8 reads) are not optimized
  here; this change stops running them N times for a one-connection page.

## Acceptance checks

- `GET /_ref/connectors?connection=<connection_id>` returns a 1-item list with the
  matching connection; `GET /_ref/connectors` is unchanged.
- A scoped request does not run the per-connection projection for non-matching
  connections (proven by a spy/probe on the projection dependency).
- `resolveConnectionForRecordsRoute` no longer triggers an all-connector
  projection; the existing `page-performance.test.ts` and `row-routing.test.ts`
  behavior holds.
- `openspec validate scope-ref-connectors-summary-to-one-connection --strict`.
- Reference summary tests, console `types:check`, and reference-contract
  `check:generated` pass.
