## 1. Spec Deltas

- [ ] Land `ADDED Requirements` for the canonical `connection` noun, per-connection entries in `rs-streams-list`, optional `connection_id` filters on read/search/blob operations, fan-in default for list/search, exactly-one auto-select, typed `ambiguous_connection` read-path error for record/blob identifier ambiguity, grant scope extension, owner-editable `display_name` mutation, consent-card per-connection label requirement (no `legacy`/`default_account` leakage), and `connector_instance_id` compatibility window under `reference-implementation-architecture`.
- [ ] Run `openspec validate expose-connection-identity-on-public-read --strict` and `openspec validate --all --strict`.

## 2. Public Contract Naming

- [ ] Add `connection_id` and `display_name` to the public contract schemas in `packages/reference-contract/src/public/index.ts` for `rs.streams.list` items, the search/read/blob inputs, the search/read/blob response items, and the new typed `ambiguous_connection` error envelope.
- [ ] Document `connector_instance_id` as a deprecated request alias and response companion, with the deprecation window scoped to the migration of the hosted MCP gateway and dashboard consumers.
- [ ] Update generated artifacts (`pnpm --filter @pdpp/reference-contract run check:generated` / `verify`) and downstream OpenAPI/MCP tool descriptions.

## 3. Server-Side Connection Threading

- [ ] Thread `connection_id` + `display_name` through `reference-implementation/operations/rs-streams-list/index.ts` output items.
- [ ] Accept optional `connection_id` on `rs-records-list`, `rs-streams-detail`, `rs-records-detail`, `rs-search-lexical`, `rs-search-semantic`, `rs-search-hybrid`, `rs-blobs-read`.
- [ ] Implement fan-in default: list/search operations omitting `connection_id` SHALL return the union across the connections the grant authorizes for the addressed stream; each response item SHALL carry `connection_id`.
- [ ] Implement exactly-one auto-select: when the grant authorizes exactly one matching connection, omission of `connection_id` SHALL implicitly select it.
- [ ] Emit typed `ambiguous_connection` error from `rs-records-detail` and `rs-blobs-read` when the addressed identifier resolves to more than one connection under the grant; envelope includes `available_connections: [{ connection_id, display_name }]` and retry guidance.
- [ ] Accept `connector_instance_id` as a request-time alias for `connection_id`; reject requests that supply both with conflicting values via a typed `invalid_argument` error.
- [ ] Emit `connector_instance_id` alongside `connection_id` on response envelopes during the deprecation window; document the alias as deprecated in the schema.
- [ ] Confirm the new read-path error does not affect the existing scheduler-side `ambiguous_connector_instance` at `runtime/controller.ts:1994`.
- [ ] Confirm single-connection deployments preserve their current request/response shape with the new fields populated from the sole active connection.

## 4. Grant Scope Extension

- [ ] Extend `RecordsListGrant` (and the search/blob-read peers in `reference-contract/src/public/`) to accept optional `connection_id` per stream entry.
- [ ] Update grant evaluation to honor the connection constraint and to pass `null`/absent grants through with current cross-connection (fan-in) semantics.
- [ ] Update operator grant-request flow (`apps/web/src/app/dashboard/lib/operator-grant-request.ts`, `apps/web/src/app/dashboard/grants/request/page.tsx`) to offer per-connection scope selection.

## 5. Consent UI Changes

- [ ] Extend `apps/web/src/components/pdpp/consent-card.tsx` props with a connection dimension and render per-connection sub-rows when more than one connection falls under the grant.
- [ ] Group scope rows by connector type and use `display_name` as the per-connection label.
- [ ] Implement the owner-meaningful default label for never-renamed connections (connector type + stable disambiguator, e.g. `Gmail · account 2`).
- [ ] Remove user-visible `legacy`/`legacy (pre-header)`/`default_account` strings, including `apps/web/src/app/dashboard/components/views/deployment-diagnostics-view.tsx:94`.
- [ ] Add `apps/web/src/components/pdpp/consent-card.test.tsx` covering multi-connection render with owner-meaningful display names and no `legacy`/`default_account` text.

## 6. Owner Mutation Endpoint

- [ ] Add an owner-authenticated mutation for `connection.display_name` on the operator surface that already serves `ref-connectors-list`.
- [ ] Confirm the mutation is NOT reachable by grant-authorized clients.
- [ ] Add dashboard UI to edit `display_name` from the connection row.
- [ ] Ship the mutation before any read-contract change relies on `display_name` being meaningful.

## 7. MCP Gateway Coordination (External)

- [ ] File an issue/PR in the hosted MCP gateway repo to accept `connection_id` as the optional argument on `list_streams`, `query_records`, `search`, `fetch`, `fetch_blob`, `schema`, `aggregate_records`.
- [ ] Update gateway tool descriptions to advertise `connection_id` and `display_name` so LLM consumers know to pass and surface them.
- [ ] Propagate the typed `ambiguous_connection` read-path error (with `available_connections`) through MCP error semantics.
- [ ] Confirm the gateway carries `connector_instance_id` only as a deprecated alias for migration compatibility, not as the advertised noun.
- [ ] In-repo validation SHALL NOT block on this external item.

## 8. Test Matrix

- [ ] Add `reference-implementation/test/rs-streams-list-connection-disambiguation.test.js` asserting response items carry `connection_id` + `display_name` and that grants can restrict to a single connection.
- [ ] Add `reference-implementation/test/rs-records-list-fan-in.test.js` proving that omitting `connection_id` on a multi-connection grant returns the union across granted connections, that each item carries `connection_id`, and that no `ambiguous_connection` error is raised from multiplicity alone.
- [ ] Add `reference-implementation/test/rs-search-fan-in.test.js` covering the three search operations with the same fan-in expectations.
- [ ] Add `reference-implementation/test/rs-records-detail-ambiguous-connection.test.js` proving that an identifier resolving to multiple connections without `connection_id` yields the typed error with `available_connections` and retry guidance.
- [ ] Add `reference-implementation/test/rs-blobs-read-ambiguous-connection.test.js` covering the blob ambiguous case.
- [ ] Add `reference-implementation/test/connection-id-alias-compat.test.js` proving that `connector_instance_id` is accepted as a request alias, that supplying both with conflicting values is rejected with `invalid_argument`, and that response envelopes carry both fields during the deprecation window.
- [ ] Add a grant-scope unit test proving cross-connection grants preserve fan-in semantics.
- [ ] Add a regression test confirming the scheduler-side `ambiguous_connector_instance` at `runtime/controller.ts:1994` is unchanged.
- [ ] Extend `apps/web/src/components/pdpp/consent-card.test.tsx` (Section 5) with a scenario asserting no `legacy`/`default_account` text leaks into the rendered primary label.

## 9. Legacy String Removal

- [ ] Remove `"legacy (pre-header)"` from `apps/web/src/app/dashboard/components/views/deployment-diagnostics-view.tsx:94`.
- [ ] Grep the tree for residual user-visible `legacy`/`default_account` strings inherited from `connector-instance-store` and confirm none remain on consent, dashboard, or MCP-rendered surfaces. Internal storage-layer use of the strings (`legacy_present` SQL aliases, `{"kind":"default_account"}` JSON literals, `cin_legacy_` row prefixes, scheduler error keyword) is out of scope.

## Acceptance Checks

- [ ] `openspec validate expose-connection-identity-on-public-read --strict`
- [ ] `openspec validate --all --strict`
- [ ] Multi-connection list/search reads return the union across granted connections without raising `ambiguous_connection` from multiplicity alone.
- [ ] Record/blob reads with an identifier resolving to multiple connections raise the typed `ambiguous_connection` error with `available_connections` and retry guidance.
- [ ] Grant with exactly one matching connection auto-selects without raising.
- [ ] Consent card renders distinct per-connection scope rows for a grant covering multiple connections of the same connector type.
- [ ] Owner can rename a `connection.display_name` from the dashboard and see the new label propagate to `rs-streams-list` output and to `available_connections` in subsequent error envelopes.
- [ ] No user-visible `legacy`/`default_account` strings remain on consent, dashboard, or MCP-rendered surfaces.
- [ ] `connector_instance_id` request alias works during the deprecation window; conflicting values are rejected; response envelopes carry both fields.
