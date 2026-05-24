## 1. Spec Deltas

- [ ] Land `ADDED Requirements` for instance-keyed `rs.streams.list`, optional-instance filters on read/search/blob operations, grant scope extension, typed `ambiguous_connector_instance` read-path error, owner-editable `display_name` mutation, and consent-card per-instance render under `reference-implementation-architecture`.
- [ ] Run `openspec validate expose-connector-instance-dimension-on-public-read --strict` and `openspec validate --all --strict`.

## 2. Server-Side Instance Threading

- [ ] Thread `connector_instance_id` + `display_name` through `reference-implementation/operations/rs-streams-list/index.ts` output items.
- [ ] Accept optional `connector_instance_id` on `rs-records-list`, `rs-streams-detail`, `rs-records-detail`, `rs-search-lexical`, `rs-search-semantic`, `rs-search-hybrid`, `rs-blobs-read`.
- [ ] Emit typed `ambiguous_connector_instance` read-path error with `available_instances: [{ connector_instance_id, display_name }]` when a multi-instance read is unconstrained under the caller's grant.
- [ ] Confirm the new read-path error does not affect the existing scheduler-side `ambiguous_connector_instance` at `runtime/controller.ts:1994`.
- [ ] Confirm single-instance deployments preserve their current request/response shape with the new fields populated from the sole active instance.

## 3. Grant Scope Extension

- [ ] Extend `RecordsListGrant` (and the search/blob-read peers in `reference-contract/src/public/`) to accept optional `connector_instance_id` per stream entry.
- [ ] Update grant evaluation to honor the instance constraint and to pass `null`/absent grants through with current cross-instance semantics.
- [ ] Update operator grant-request flow (`apps/web/src/app/dashboard/lib/operator-grant-request.ts`, `apps/web/src/app/dashboard/grants/request/page.tsx`) to offer per-instance scope selection.

## 4. Consent UI Changes

- [ ] Extend `apps/web/src/components/pdpp/consent-card.tsx` props with an instance dimension and render per-instance sub-rows when more than one instance falls under the grant.
- [ ] Group scope rows by connector type and use `display_name` as the per-instance label.
- [ ] Remove user-visible `legacy`/`default_account` strings, including `apps/web/src/app/dashboard/components/views/deployment-diagnostics-view.tsx:94` (`"legacy (pre-header)"`).
- [ ] Add `apps/web/src/components/pdpp/consent-card.test.tsx` covering multi-instance render with owner-meaningful display names and no `legacy` text.

## 5. Owner Mutation Endpoint

- [ ] Add an owner-authenticated mutation for `connector_instance.display_name` on the operator surface that already serves `ref-connectors-list`.
- [ ] Confirm the mutation is NOT reachable by grant-authorized clients.
- [ ] Add dashboard UI to edit `display_name` from the connector instance row.
- [ ] Ship the mutation before any read-contract change relies on `display_name` being meaningful.

## 6. MCP Gateway Coordination (External)

- [ ] File an issue/PR in the hosted MCP gateway repo to accept the optional `connector_instance_id` argument on `list_streams`, `query_records`, `search`, `fetch`, `fetch_blob`, `schema`, `aggregate_records`.
- [ ] Update gateway tool descriptions to advertise the new argument so LLM consumers know to pass it.
- [ ] Propagate the typed `ambiguous_connector_instance` read-path error through MCP error semantics.
- [ ] In-repo validation SHALL NOT block on this external item.

## 7. Test Matrix

- [ ] Extend `reference-implementation/test/connector-instance-store.test.js` with an MCP-path companion covering ambiguous read resolution.
- [ ] Extend `reference-implementation/test/pdpp.test.js` with owner + client cases for two active instances of the same `connector_id`.
- [ ] Add `reference-implementation/test/rs-streams-list-instance-disambiguation.test.js` asserting response items carry `connector_instance_id` + `display_name` and that grants can restrict to a single instance.
- [ ] Add `reference-implementation/test/rs-records-list-instance-scope.test.js` proving that passing `connector_instance_id` filters and that omitting it with multiple candidates yields the typed error with `available_instances`.
- [ ] Add a grant-scope unit test proving cross-instance grants preserve current semantics.
- [ ] Add a regression test confirming the scheduler-side `ambiguous_connector_instance` at `runtime/controller.ts:1994` is unchanged.

## 8. Legacy String Removal

- [ ] Remove `"legacy (pre-header)"` from `apps/web/src/app/dashboard/components/views/deployment-diagnostics-view.tsx:94`.
- [ ] Grep tree for residual user-visible `legacy`/`default_account` strings inherited from `connector-instance-store` and confirm none remain on consent or dashboard surfaces.

## Acceptance Checks

- [ ] `openspec validate expose-connector-instance-dimension-on-public-read --strict`
- [ ] `openspec validate --all --strict`
- [ ] All multi-instance read tests pass against a deployment with two Gmail accounts and two Claude Code device collectors.
- [ ] Consent card renders distinct per-instance scope rows for a grant covering multiple instances of the same connector type.
- [ ] Owner can rename a `connector_instance.display_name` from the dashboard and see the new label propagate to `rs-streams-list` output.
- [ ] No user-visible `legacy`/`default_account` strings remain on consent or dashboard surfaces.
