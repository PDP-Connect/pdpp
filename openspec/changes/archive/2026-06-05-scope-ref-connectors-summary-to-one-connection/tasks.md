# Tasks: scope-ref-connectors-summary-to-one-connection

## 1. Reference projection

- [x] 1.1 Extract the per-connection projection in
  `reference-implementation/server/ref-control.ts` into a shared
  `projectConnectorSummaryForInstance(instance, deps)`; have
  `listConnectorSummaries` map it over all instances (pure refactor, same output).
- [x] 1.2 Add `getConnectorSummaryForRoute(routeId, controller?)` that resolves
  one instance by the console precedence (exact `connection_id` /
  `connector_instance_id`, else first `connector_id` match) and projects only it.
- [x] 1.3 Add a unit test proving `getConnectorSummaryForRoute` projects only the
  matched connection (it equals the connection's list entry modulo the projection
  timestamp) and honors the precedence, including the `connector_id`-only
  first-match fallback (parity with the list's first match).

## 2. Transport + contract

- [x] 2.1 Add the optional `connection` query parameter to the
  `GET /_ref/connectors` route handler in
  `reference-implementation/server/routes/ref-connectors.ts`; when present, wire
  the scoped projection, else the unscoped list. Preserve the
  `{object: "list", data}` envelope.
- [x] 2.2 Document the optional `connection` query on the `refListConnectors`
  descriptor in `packages/reference-contract/src/reference/index.ts` and
  regenerate (`pnpm --filter @pdpp/reference-contract run check:generated`).

## 3. Console resolver

- [x] 3.1 Add an optional `connectionRouteId` argument to `listConnectorSummaries`
  in `apps/console/src/app/dashboard/lib/ref-client.ts` that sets the `connection`
  query.
- [x] 3.2 Update `resolveConnectionForRecordsRoute` to pass the route param and
  keep the same `find` precedence on the returned 0-or-1 list.
- [x] 3.3 Add/extend a console test proving the resolver requests the scoped
  endpoint and does not fetch all connectors.

## 4. Validation

- [x] 4.1 `openspec validate scope-ref-connectors-summary-to-one-connection
  --strict`.
- [x] 4.2 Reference summary tests + new projection test (`node --test`).
- [x] 4.3 `pnpm --dir apps/console run types:check`; console resolver test.
- [x] 4.4 `pnpm --filter @pdpp/reference-contract run check:generated` (passes
  once the regenerated artifacts in this change are committed).

## Acceptance checks

- `GET /_ref/connectors?connection=<id>` returns the one matching connection;
  unscoped `GET /_ref/connectors` is byte-equivalent to before.
- The scoped path does not run the per-connection projection for non-matching
  connections.
- `resolveConnectionForRecordsRoute` no longer triggers an all-connector
  projection; `row-routing.test.ts` and `page-performance.test.ts` still pass.
