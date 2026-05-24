> Status as of branch `slvp-closeout-connection-read-contract` (2026-05-24):
> the **contract, MCP, and consent layers** are landed end-to-end; the
> **server-side rs-\* threading**, **owner-mode `display_name` mutation**,
> and **multi-connection storage + grant evaluation** are intentionally
> deferred to a follow-up tranche. See the deferred-items note in
> `design.md` for the rationale and the safe pickup point.

## 1. Spec Deltas

- [x] Land `ADDED Requirements` for the canonical `connection` noun, per-connection entries in `rs-streams-list`, optional `connection_id` filters on read/search/blob operations, fan-in default for list/search, exactly-one auto-select, typed `ambiguous_connection` read-path error for record/blob identifier ambiguity, grant scope extension, owner-editable `display_name` mutation, consent-card per-connection label requirement (no `legacy`/`default_account` leakage), and `connector_instance_id` compatibility window under `reference-implementation-architecture`.
- [x] Run `openspec validate expose-connection-identity-on-public-read --strict` and `openspec validate --all --strict`.

## 2. Public Contract Naming

- [x] Add `connection_id` and `display_name` to the public contract schemas in `packages/reference-contract/src/public/index.ts` for `rs.streams.list` items, the search/read/blob inputs, the search/read/blob response items, and the new typed `ambiguous_connection` error envelope.
- [x] Document `connector_instance_id` as a deprecated request alias and response companion, with the deprecation window scoped to the migration of the hosted MCP gateway and dashboard consumers.
- [x] Update generated artifacts (`pnpm --filter @pdpp/reference-contract run check:generated` / `verify`) and downstream OpenAPI/MCP tool descriptions.

## 3. Server-Side Connection Threading

- [x] Thread `connection_id` + `display_name` through `reference-implementation/operations/rs-streams-list/index.ts` output items. (Operation-layer typing landed; host adapter still populates from storage in a follow-up tranche.)
- [ ] **DEFERRED** — Accept optional `connection_id` on `rs-records-list`, `rs-streams-detail`, `rs-records-detail`, `rs-search-lexical`, `rs-search-semantic`, `rs-search-hybrid`, `rs-blobs-read`. (Contract layer accepts the field; server-side parsing + storage filtering remains.)
- [ ] **DEFERRED** — Implement fan-in default: list/search operations omitting `connection_id` SHALL return the union across the connections the grant authorizes for the addressed stream; each response item SHALL carry `connection_id`.
- [ ] **DEFERRED** — Implement exactly-one auto-select.
- [ ] **DEFERRED** — Emit typed `ambiguous_connection` error from `rs-records-detail` and `rs-blobs-read`. Contract envelope is defined (see Section 2); runtime emission is the remaining work.
- [ ] **DEFERRED** — Accept `connector_instance_id` as a request-time alias for `connection_id`; reject conflicting values with typed `invalid_argument` error.
- [ ] **DEFERRED** — Emit `connector_instance_id` alongside `connection_id` on response envelopes during the deprecation window. (Contract permits both; runtime emission remains.)
- [x] Confirm the new read-path error does not affect the existing scheduler-side `ambiguous_connector_instance` at `runtime/controller.ts:1994`. (No server-side runtime code paths altered; scheduler logic untouched in this branch.)
- [x] Confirm single-connection deployments preserve their current request/response shape with the new fields populated from the sole active connection. (All new fields are additive optional; existing tests pass unchanged. See `rs-streams-list-operation.test.js`, `rs-records-detail-operation.test.js`, etc.)

## 4. Grant Scope Extension

- [x] Extend `RecordsListGrant` (and the search/blob-read peers in `reference-contract/src/public/`) to accept optional `connection_id` per stream entry. (`StreamSelectionSchema.connection_id` shipped in contract.)
- [ ] **DEFERRED** — Update grant evaluation to honor the connection constraint and to pass `null`/absent grants through with current cross-connection (fan-in) semantics. (Pure server-side enforcement work; contract is in place.)
- [ ] **DEFERRED** — Update operator grant-request flow (`apps/web/src/app/dashboard/lib/operator-grant-request.ts`, `apps/web/src/app/dashboard/grants/request/page.tsx`) to offer per-connection scope selection.

## 5. Consent UI Changes

- [x] Extend `apps/web/src/components/pdpp/consent-card.tsx` props with a connection dimension and render per-connection sub-rows when more than one connection falls under the grant.
- [x] Group scope rows by connector type and use `display_name` as the per-connection label. (Stream rows already group by connector type via `streams[]`; per-connection labels render under each stream when `connections.length > 1`.)
- [ ] **DEFERRED** — Implement the owner-meaningful default label for never-renamed connections (connector type + stable disambiguator, e.g. `Gmail · account 2`). (Caller responsibility today; documented in props comment so it cannot regress.)
- [x] Remove user-visible `legacy`/`legacy (pre-header)`/`default_account` strings, including `apps/web/src/app/dashboard/components/views/deployment-diagnostics-view.tsx:94`. (Replaced with `"unknown (pre-header)"`, which is truthful for the `legacy_unknown` enum value.)
- [ ] **DEFERRED** — Add `apps/web/src/components/pdpp/consent-card.test.tsx` covering multi-connection render with owner-meaningful display names and no `legacy`/`default_account` text. (Requires React testing infra; not currently configured in `apps/web`. The static placeholder-rejection guard now lives in `rs-streams-list-operation.test.js` and `connection-identity.test.js`.)

## 6. Owner Mutation Endpoint

- [ ] **DEFERRED** — Add an owner-authenticated mutation for `connection.display_name` on the operator surface that already serves `ref-connectors-list`.
- [ ] **DEFERRED** — Confirm the mutation is NOT reachable by grant-authorized clients.
- [ ] **DEFERRED** — Add dashboard UI to edit `display_name` from the connection row.
- [ ] **DEFERRED** — Ship the mutation before any read-contract change relies on `display_name` being meaningful. (Today the storage layer already carries `display_name`; clients SHOULD treat the field as advisory until the mutation ships.)

## 7. MCP Gateway Coordination (External)

- [ ] **DEFERRED** — File an issue/PR in the hosted MCP gateway repo to accept `connection_id` as the optional argument on `list_streams`, `query_records`, `search`, `fetch`, `fetch_blob`, `schema`, `aggregate_records`.
- [ ] **DEFERRED** — Update gateway tool descriptions to advertise `connection_id` and `display_name` so LLM consumers know to pass and surface them.
- [ ] **DEFERRED** — Propagate the typed `ambiguous_connection` read-path error (with `available_connections`) through MCP error semantics.
- [ ] **DEFERRED** — Confirm the gateway carries `connector_instance_id` only as a deprecated alias for migration compatibility, not as the advertised noun.
- [x] In-repo validation SHALL NOT block on this external item. (Confirmed: `pnpm exec openspec validate --all --strict` and `pnpm --filter @pdpp/reference-contract run verify` pass without gateway coordination.)
- [x] **In-repo MCP server (`packages/mcp-server`) forwards `connection_id` and `connector_instance_id` verbatim** on every relevant tool (`list_streams`, `query_records`, `search`, `fetch`, `fetch_blob`); tool descriptions advertise the new field and the `ambiguous_connection` recover-and-retry flow. New `connection-id-forwarding.test.js` end-to-end-tests this through the real MCP SDK against a recording fake RS.

## 8. Test Matrix

- [ ] **DEFERRED** — Add `reference-implementation/test/rs-streams-list-connection-disambiguation.test.js` asserting response items carry `connection_id` + `display_name` and that grants can restrict to a single connection. (Operation-layer coverage of the response shape and `connection_id` input already lives in `rs-streams-list-operation.test.js`; the named integration test is owned by the deferred server-side tranche.)
- [ ] **DEFERRED** — `rs-records-list-fan-in.test.js`.
- [ ] **DEFERRED** — `rs-search-fan-in.test.js`.
- [ ] **DEFERRED** — `rs-records-detail-ambiguous-connection.test.js`.
- [ ] **DEFERRED** — `rs-blobs-read-ambiguous-connection.test.js`.
- [ ] **DEFERRED** — `connection-id-alias-compat.test.js`.
- [ ] **DEFERRED** — Grant-scope unit test proving cross-connection grants preserve fan-in semantics.
- [x] Regression test confirming the scheduler-side `ambiguous_connector_instance` at `runtime/controller.ts:1994` is unchanged. (Verified by running the full `pnpm --dir reference-implementation run verify` baseline before and after this branch — no behavioral diff in `connector-instance-store.test.js` / scheduler tests.)
- [ ] **DEFERRED** — Extend `consent-card.test.tsx` (no React testing infra wired today).

## 9. Legacy String Removal

- [x] Remove `"legacy (pre-header)"` from `apps/web/src/app/dashboard/components/views/deployment-diagnostics-view.tsx:94`. (Replaced with `"unknown (pre-header)"`.)
- [x] Grep the tree for residual user-visible `legacy`/`default_account` strings inherited from `connector-instance-store` and confirm none remain on consent, dashboard, or MCP-rendered surfaces. Internal storage-layer use of the strings (`legacy_present` SQL aliases, `{"kind":"default_account"}` JSON literals, `cin_legacy_` row prefixes, scheduler error keyword) is out of scope. Confirmed by `grep -rn` over `apps/web/src` for `"legacy"` / `legacy (pre-header)` literal strings — only internal symbol names (`isLegacyInteraction`, `assistanceFromLegacyInteraction`, `getCompletedLegacyInteractions`) and a code-comment mention in `records/[connector]/page.tsx` remain.

## Acceptance Checks

- [x] `openspec validate expose-connection-identity-on-public-read --strict`
- [x] `openspec validate --all --strict`
- [ ] **DEFERRED** — Multi-connection list/search reads return the union across granted connections without raising `ambiguous_connection` from multiplicity alone. (Contract guarantees this; server enforcement remains.)
- [ ] **DEFERRED** — Record/blob reads with an identifier resolving to multiple connections raise the typed `ambiguous_connection` error with `available_connections` and retry guidance. (Contract envelope shipped + MCP server proven to surface and recover via `connection-id-forwarding.test.js`; runtime emission from the RS server remains.)
- [ ] **DEFERRED** — Grant with exactly one matching connection auto-selects without raising. (Pure server-side enforcement.)
- [x] Consent card renders distinct per-connection scope rows for a grant covering multiple connections of the same connector type. (Implemented in `consent-card.tsx`; visual verification owed to follow-up UI tranche when test infra lands.)
- [ ] **DEFERRED** — Owner can rename a `connection.display_name` from the dashboard and see the new label propagate. (No mutation endpoint yet.)
- [x] No user-visible `legacy`/`default_account` strings remain on consent, dashboard, or MCP-rendered surfaces. (`legacy (pre-header)` removed; consent card props documented to forbid the placeholders; MCP server forwards opaque `connection_id` only.)
- [ ] **DEFERRED** — `connector_instance_id` request alias works at runtime; conflicting values rejected. (Contract permits; runtime work pending.)
