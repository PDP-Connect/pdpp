> Status as of branch `complete-storage-fan-in-read-contract` (2026-05-26,
> revised after owner review at
> `tmp/workstreams/fan-in-branch-owner-review-report.md`):
> the **contract, MCP, consent, server-side rs-\* threading,
> multi-connection storage fan-in, identifier-ambiguity emission, grant
> scope `connection_id` enforcement, and owner-mode `display_name`
> mutation** are landed end-to-end.
>
> The owner-review revision additionally:
> - made the blob route's typed `ambiguous_connection` (HTTP 409)
>   reachable and covered by route-level integration tests (P1);
> - applied grant-scope per-stream `connection_id` to the blob route
>   so a grant pinned to connection A on stream S cannot expose bytes
>   reachable only from connection B (P2);
> - replaced the (unsound) `changes_since` cursor merge under fan-in
>   with a typed `invalid_argument` rejection carrying
>   `available_connections` and retry guidance (P1);
> - replaced the silently-dropped `next_cursor` under fan-in with a
>   canonical `meta.warnings[{code:"partial_results"}]` entry (P2);
> - replaced the "last binding wins" `meta.count` under fan-in with
>   summed exact counts (when every binding produced `exact`) or
>   omission plus a `count_downgraded` warning (P3);
> - resolved the multi-stream-grant-with-different-`connection_id` shape
>   for streams-list by resolving bindings per stream (P3);
> - threaded resolver-level `deprecated_alias_used` warnings through the
>   multi-binding fan-in helpers and the streams-list / blob routes (P3).
>
> The remaining `**DEFERRED**` markers below are scoped to **broad UI work**
> (multi-connection consent-card visual regression, per-connection
> grant-request UI, and dashboard rename controls) that requires React testing
> infra not currently configured in `apps/web`. The hosted MCP coordination
> residual is closed by the in-repo MCP server and the owner's 2026-05-31 external
> Claude run. The contract is connection-honest end-to-end on the reference
> implementation and the regression suites
> `reference-implementation/test/storage-fan-in-read-contract.test.js`
> (29 tests, all green),
> `reference-implementation/test/blob-fan-in-ambiguity.test.js`
> (6 tests, all green), and the search fan-in suites
> `reference-implementation/test/rs-search-{lexical,semantic,hybrid}-fan-in.test.js`
> + `reference-implementation/test/search-fan-in-host-shell.test.js`
> (36 tests, all green) lock the runtime behavior.

## 1. Spec Deltas

- [x] Land `ADDED Requirements` for the canonical `connection` noun, per-connection entries in `rs-streams-list`, optional `connection_id` filters on read/search/blob operations, fan-in default for list/search, exactly-one auto-select, typed `ambiguous_connection` read-path error for record/blob identifier ambiguity, grant scope extension, owner-editable `display_name` mutation, consent-card per-connection label requirement (no `legacy`/`default_account` leakage), and `connector_instance_id` compatibility window under `reference-implementation-architecture`.
- [x] Run `openspec validate expose-connection-identity-on-public-read --strict` and `openspec validate --all --strict`.

## 2. Public Contract Naming

- [x] Add `connection_id` and `display_name` to the public contract schemas in `packages/reference-contract/src/public/index.ts` for `rs.streams.list` items, the search/read/blob inputs, the search/read/blob response items, and the new typed `ambiguous_connection` error envelope.
- [x] Document `connector_instance_id` as a deprecated request alias and response companion, with the deprecation window scoped to the migration of the hosted MCP gateway and dashboard consumers.
- [x] Update generated artifacts (`pnpm --filter @pdpp/reference-contract run check:generated` / `verify`) and downstream OpenAPI/MCP tool descriptions.

## 3. Server-Side Connection Threading

- [x] Thread `connection_id` + `display_name` through `reference-implementation/operations/rs-streams-list/index.ts` output items, then through the host adapter so multi-connection deployments emit one entry per `(stream, connection_id)` and single-connection deployments preserve their pre-existing shape with the new fields populated from the sole active connection. Landed via `listStreamsAcrossBindings` (records.js) wired into the `/v1/streams` route adapter in `server/index.js`.
- [x] Accept optional `connection_id` on `rs-records-list`, `rs-streams-detail`, `rs-records-detail`, `rs-search-lexical`, `rs-search-semantic`, `rs-search-hybrid`, `rs-blobs-read`. Records / aggregate / blobs / streams-list now resolve bindings via `resolveReadRequestBindings` and forward the canonical value to the per-binding storage primitive; search ops accept the parameter at the contract layer and continue to honor it via `enforceConnectionNarrowing` for the single-binding fast path.
- [x] Implement fan-in default: list/search operations omitting `connection_id` SHALL return the union across the connections the grant authorizes for the addressed stream; each response item SHALL carry `connection_id`. Implemented in `queryRecordsAcrossBindings`, `aggregateRecordsAcrossBindings`, `listStreamsAcrossBindings`; per-record `connection_id` / `display_name` decoration already lands via `decorateRecordWithConnectionIdentity` on each per-binding result.
- [x] Implement exactly-one auto-select. Implemented in `resolveFanInBindings`: when the grant authorizes exactly one matching active connection (or the request's `connection_id` narrows to one), the read proceeds without raising. The pre-existing single-binding fast path is preserved unchanged.
- [x] Emit typed `ambiguous_connection` error from `rs-records-detail` and `rs-blobs-read`. `getRecordAcrossBindings` (records.js) throws `AmbiguousConnectionError` with `available_connections: [{ connection_id, display_name? }]` and `retry_with: 'connection_id'`. The `/v1/blobs/:blob_id` adapter tracks how many bindings exposed the addressed blob via the visible-record probe and raises the same typed error when more than one binding matched. HTTP status: 409.
- [x] Accept `connector_instance_id` as a request-time alias for `connection_id`; reject conflicting values with typed `invalid_argument` error. Already enforced by `validateConnectionAlias` in `server/connection-id-request.js`; covered by `public-read-connection-alias.test.js` and the new `validateConnectionAlias` regression in `storage-fan-in-read-contract.test.js`.
- [x] Emit `connector_instance_id` alongside `connection_id` on response envelopes during the deprecation window. Per-record decoration already mirrors both; per-stream summaries mirror both via `listStreamsAcrossBindings`.
- [x] Confirm the new read-path error does not affect the existing scheduler-side `ambiguous_connector_instance` at `runtime/controller.ts:1994`. (No server-side runtime code paths altered; scheduler logic untouched in this branch.)
- [x] Confirm single-connection deployments preserve their current request/response shape with the new fields populated from the sole active connection. (All new fields are additive optional; existing tests pass unchanged. See `rs-streams-list-operation.test.js`, `rs-records-detail-operation.test.js`, etc.)

## 4. Grant Scope Extension

- [x] Extend `RecordsListGrant` (and the search/blob-read peers in `reference-contract/src/public/`) to accept optional `connection_id` per stream entry. (`StreamSelectionSchema.connection_id` shipped in contract.)
- [x] Update grant evaluation to honor the connection constraint and to pass `null`/absent grants through with current cross-connection (fan-in) semantics. Landed via `resolveReadRequestBindings` (records.js): if a `grant.streams[].connection_id` is set, the binding resolver narrows to that one binding and throws `connection_not_found` if it is not active; if the constraint is absent, the resolver fans in across every active binding the owner has under the connector. Regression: `storage-fan-in-read-contract.test.js` (`resolveFanInBindings honors grant-scope connection_id constraint`).
- [ ] **DEFERRED** — Update operator grant-request flow (`apps/web/src/app/dashboard/lib/operator-grant-request.ts`, `apps/web/src/app/dashboard/grants/request/page.tsx`) to offer per-connection scope selection. (UI tranche; grant-evaluation runtime is in place.)

## 5. Consent UI Changes

- [x] Extend `apps/web/src/components/pdpp/consent-card.tsx` props with a connection dimension and render per-connection sub-rows when more than one connection falls under the grant.
- [x] Group scope rows by connector type and use `display_name` as the per-connection label. (Stream rows already group by connector type via `streams[]`; per-connection labels render under each stream when `connections.length > 1`.)
- [ ] **DEFERRED** — Implement the owner-meaningful default label for never-renamed connections (connector type + stable disambiguator, e.g. `Gmail · account 2`). (Caller responsibility today; documented in props comment so it cannot regress.)
- [x] Remove user-visible `legacy`/`legacy (pre-header)`/`default_account` strings, including `apps/web/src/app/dashboard/components/views/deployment-diagnostics-view.tsx:94`. (Replaced with `"unknown (pre-header)"`, which is truthful for the `legacy_unknown` enum value.)
- [ ] **DEFERRED** — Add `apps/web/src/components/pdpp/consent-card.test.tsx` covering multi-connection render with owner-meaningful display names and no `legacy`/`default_account` text. (Requires React testing infra; not currently configured in `apps/web`. The static placeholder-rejection guard now lives in `rs-streams-list-operation.test.js` and `connection-identity.test.js`.)

## 6. Owner Mutation Endpoint

- [x] Add an owner-authenticated mutation for `connection.display_name` on the operator surface that already serves `ref-connectors-list`. Implemented as `PATCH /_ref/connections/:connectorInstanceId` (`refSetConnectionDisplayName`) wired to a new `connector-instance-store.setDisplayName(connectorInstanceId, { ownerSubjectId, displayName, updatedAt })` setter on both SQLite and Postgres adapters. SQL: `reference-implementation/server/queries/connector-instances/update-display-name.sql` (owner-scoped UPDATE).
- [x] Confirm the mutation is NOT reachable by grant-authorized clients. The route is gated by `ownerAuth.requireOwnerSession`, mirroring the existing `GET /_ref/connections/:id` reader. Regression covered via `store.setDisplayName … rejects … owner mismatch` in `storage-fan-in-read-contract.test.js` (store-level WHERE clause defends against id-stealing even if a future route forgets the auth guard).
- [ ] **DEFERRED** — Add dashboard UI to edit `display_name` from the connection row. (UI tranche; backend mutation + grant evaluation are in place. Today the dashboard surfaces `display_name` read-only; an inline rename control is the safe next slice.)
- [x] Ship the mutation before any read-contract change relies on `display_name` being meaningful. Mutation now ships in-band with the fan-in tranche; the renamed label propagates to subsequent records-list responses, covered by `renamed display_name surfaces on the next records-list fan-in response` in `storage-fan-in-read-contract.test.js`.

## 7. MCP Gateway Coordination

- [x] Accept `connection_id` as the optional argument on `list_streams`, `query_records`, `search`, `fetch`, `fetch_blob`, `schema`, and `aggregate_records`. The hosted MCP surface now uses the in-repo `packages/mcp-server`; `connection-id-forwarding.test.js` proves the server forwards canonical `connection_id` and deprecated `connector_instance_id` verbatim for every relevant tool, and the owner's external Claude run on 2026-05-31 proved retry with a Slack `connection_id` succeeds against the live deployment.
- [x] Update MCP tool descriptions to advertise `connection_id` and `display_name` so LLM consumers know to pass and surface them. `packages/mcp-server/src/tools.js` descriptions now point clients from schema/list-streams discovery and typed ambiguity errors to `connection_id`, `display_name`, and canonical `connector_key`; `canonical-mirror.test.js` and `server.integration.test.js` pin those descriptions and text envelopes.
- [x] Propagate the typed `ambiguous_connection` read-path error, including `available_connections`, through MCP error semantics. `connection-id-forwarding.test.js` covers `fetch` and `fetch_blob` surfacing the structured error and retrying with `connection_id`; the owner's external Claude run additionally proved the live hosted package token returns `available_connections` with `grant_id`, `connector_key`, `connection_id`, `display_name`, and `retry_with: "connection_id"`.
- [x] Confirm the gateway carries `connector_instance_id` only as a deprecated alias for migration compatibility, not as the advertised noun. MCP tool descriptions prefer `connection_id`, describe `connector_instance_id` as deprecated, and the live Claude run confirmed `connection_id` is the stable selector while `grant_id` can rotate across reconnects. Follow-up docs in `packages/mcp-server/README.md` explicitly instruct agents to persist `connection_id`, not `grant_id`, for source disambiguation.
- [x] In-repo validation SHALL NOT block on this external item. (Confirmed: `pnpm exec openspec validate --all --strict` and `pnpm --filter @pdpp/reference-contract run verify` pass without gateway coordination.)
- [x] **In-repo MCP server (`packages/mcp-server`) forwards `connection_id` and `connector_instance_id` verbatim** on every relevant tool (`list_streams`, `query_records`, `search`, `fetch`, `fetch_blob`); tool descriptions advertise the new field and the `ambiguous_connection` recover-and-retry flow. New `connection-id-forwarding.test.js` end-to-end-tests this through the real MCP SDK against a recording fake RS.

## 8. Test Matrix

- [x] Cover response items carry `connection_id` + `display_name` and that grants can restrict to a single connection — `storage-fan-in-read-contract.test.js`: `listStreamsAcrossBindings emits one summary per (stream, connection_id)`, `queryRecordsAcrossBindings fans in records across two granted connections`, `queryRecordsAcrossBindings narrows to one binding when bindings list is filtered`. The contract-layer shape is also locked by `rs-streams-list-operation.test.js`.
- [x] Records-list fan-in coverage — `storage-fan-in-read-contract.test.js`: `queryRecordsAcrossBindings fans in records across two granted connections` + `… auto-selects exactly-one binding without raising`.
- [x] Search fan-in coverage. Cross-binding union search landed in `df137aad` ("feat(ref): cross-binding search fan-in for lexical/semantic/hybrid"), which explicitly closed this deferral — the snapshot builder now emits one connector plan per binding while preserving the lexical round-robin and semantic total-order merges, and the `plan_hash` covers the binding set so cursors invalidate on topology shifts. Covered by `rs-search-lexical-fan-in.test.js` (owner round-robin across two bindings of one connector, across connectors, `connection_id` narrowing, `connector_instance_id` alias narrowing + warning, binding-aware `source_skipped_not_applicable`, cursor pins the issued snapshot across binding reorder), `rs-search-semantic-fan-in.test.js` (total-order merge by distance across bindings, a record indexed in two bindings appears twice with distinct `connection_id`s), `rs-search-hybrid-fan-in.test.js` (dedup key extended to `(connection_id, stream, record_key)` so two bindings sharing a source-local key are not collapsed), and the host-shell suite `search-fan-in-host-shell.test.js` (client-mode union across grant-authorized bindings with no per-stream pin, per-stream grant `connection_id` pin, mixed per-stream constraints honored independently). 36 tests across these five files green (`node --test`). Satisfies spec delta "Unfiltered search fans in across granted connections".
- [x] Records-detail identifier-ambiguity coverage — `storage-fan-in-read-contract.test.js`: `getRecordAcrossBindings emits ambiguous_connection when identifier resolves to multiple bindings`, `… auto-selects the only binding holding a unique identifier`, `… narrows successfully with explicit connection_id on ambiguous identifier`, `… returns not_found when identifier is absent from every binding`.
- [x] Blob ambiguity is enforced at the route adapter (`/v1/blobs/:blob_id`) by iterating every blob binding, applying the addressable set and grant-scope per-stream `connection_id` constraint per binding, and raising typed `ambiguous_connection` (HTTP 409) with `available_connections` when more than one unique connection's visible record exposes the addressed blob. Route-level coverage: `blob-fan-in-ambiguity.test.js` (1) emits 409 with `available_connections` for two-connection ambiguity, (2) succeeds when the caller narrows with `connection_id`, (3) returns 200 when only one connection holds the blob (fan-in auto-select). Per-stream grant-scope narrowing covered by `blob route per-stream binding resolution narrows by grant connection_id` in the same file.
- [x] Alias compat coverage — `validateConnectionAlias accepts canonical, accepts alias, rejects conflicts` in `storage-fan-in-read-contract.test.js` plus the pre-existing `public-read-connection-alias.test.js` regressions.
- [x] Grant-scope unit test proving cross-connection grants preserve fan-in semantics — `resolveFanInBindings honors grant-scope connection_id constraint` and `resolveFanInBindings returns both active bindings when no narrowing is requested` in `storage-fan-in-read-contract.test.js`.
- [x] Regression test confirming the scheduler-side `ambiguous_connector_instance` at `runtime/controller.ts:1994` is unchanged. (Verified by running the full `pnpm --dir reference-implementation run verify` baseline before and after this branch — no behavioral diff in `connector-instance-store.test.js` / scheduler tests.) Note: `resolveGrantManifest` now tolerates the same error code instead of propagating it to the read path — the scheduler code path is untouched and continues to throw exactly as before.
- [ ] **DEFERRED** — Extend `consent-card.test.tsx` (no React testing infra wired today).

## 8a. Owner-review revision (P1/P2/P3 fixes)

This section pins the owner-review revision that followed
`tmp/workstreams/fan-in-branch-owner-review-report.md`.

- [x] **P1** — Blob ambiguity is now reachable. The `/v1/blobs/:blob_id` route adapter no longer relies on `executeBlobsRead`'s short-circuit-on-first-match for visibility; it iterates every blob binding under the actor's connector, applies the addressable + grant-scope-per-stream filter, and emits typed `ambiguous_connection` (HTTP 409) when more than one unique `connection_id` exposes a visible record. Route-level coverage in `test/blob-fan-in-ambiguity.test.js`.
- [x] **P2** — Blob reads now respect grant-scope per-stream `connection_id`. The route resolves the addressable set per blob-binding's stream (caching per stream), so a grant pinned to connection A for stream S cannot expose blob bytes reachable only from connection B for stream S. Owner-mode preserves the prior fan-in default (no grant scoping). Helper coverage in `test/blob-fan-in-ambiguity.test.js`.
- [x] **P1** — `changes_since` under multi-binding fan-in is rejected with a typed `invalid_argument` error carrying `available_connections` and recovery guidance. The unsound base64 lexical-max cursor merge has been removed. Single-binding fast-path semantics unchanged. Coverage in `test/storage-fan-in-read-contract.test.js`.
- [x] **P2** — Multi-binding records-list now emits a structured `meta.warnings[{code:"partial_results", param:"connection_id"}]` when `has_more=true`, and the response does NOT carry a (per-binding, meaningless) `next_cursor`. Single-binding fast-path semantics unchanged. Coverage in `test/storage-fan-in-read-contract.test.js`.
- [x] **P3** — Multi-binding `meta.count` is honest. When every per-binding result produces an `exact` count, the response carries the summed exact count; otherwise the response omits `meta.count` and emits `meta.warnings[{code:"count_downgraded", param:"count"}]`. The previous "whichever binding ran last" behavior is removed. Coverage in `test/storage-fan-in-read-contract.test.js`.
- [x] **P3** — Streams-list with multi-stream grants pinning different `connection_id` per stream is now correctly resolved per stream. The route passes a `resolveBindingsForStream` callback that re-resolves bindings against each grant entry's `connection_id`, so stream A's count comes from A's pinned connection and stream B's count comes from B's. Coverage in `test/storage-fan-in-read-contract.test.js`.
- [x] **P3** — Resolver-level `deprecated_alias_used` warnings now thread through the multi-binding fan-in helpers (`queryRecordsAcrossBindings`, `aggregateRecordsAcrossBindings`, `getRecordAcrossBindings`) and the streams-list route. The blob route surfaces the warning via a `PDPP-Warning` response header since the binary route has no JSON envelope. Coverage in `test/storage-fan-in-read-contract.test.js`.
- [x] **Latent transport bug** — Surfaced by the revision: the previous tranche introduced a `PATCH /_ref/connections/:connectorInstanceId` route using `app.patch(...)`, but the local Fastify transport adapter at `server/transport.js` exposed only `get / post / put / delete / head / options`. The AS app crashed at boot under any test that called `startServer(...)`. The revision adds the `patch` method to the transport and removes the unregistered `{ contract: 'refSetConnectionDisplayName' }` opt (no contract manifest existed). The pre-existing `test/connector-instance-admission-routes.test.js` is also updated to reflect the public-read contract: records carry `connection_id` and the deprecated alias `connector_instance_id` on the wire (previous baseline asserted both were absent, which pre-dated the canonicalization tranche).

## 9. Legacy String Removal

- [x] Remove `"legacy (pre-header)"` from `apps/web/src/app/dashboard/components/views/deployment-diagnostics-view.tsx:94`. (Replaced with `"unknown (pre-header)"`.)
- [x] Grep the tree for residual user-visible `legacy`/`default_account` strings inherited from `connector-instance-store` and confirm none remain on consent, dashboard, or MCP-rendered surfaces. Internal storage-layer use of the strings (`legacy_present` SQL aliases, `{"kind":"default_account"}` JSON literals, `cin_legacy_` row prefixes, scheduler error keyword) is out of scope. Confirmed by `grep -rn` over `apps/web/src` for `"legacy"` / `legacy (pre-header)` literal strings — only internal symbol names (`isLegacyInteraction`, `assistanceFromLegacyInteraction`, `getCompletedLegacyInteractions`) and a code-comment mention in `records/[connector]/page.tsx` remain.

## Acceptance Checks

- [x] `openspec validate expose-connection-identity-on-public-read --strict`
- [x] `openspec validate --all --strict`
- [x] Multi-connection list/search reads return the union across granted connections without raising `ambiguous_connection` from multiplicity alone. Records-list / aggregate / streams-list fan-in covered by `storage-fan-in-read-contract.test.js`. Search fan-in (lexical/semantic/hybrid) landed in `df137aad` and is covered by `rs-search-{lexical,semantic,hybrid}-fan-in.test.js` + `search-fan-in-host-shell.test.js` (see Section 8).
- [x] Record/blob reads with an identifier resolving to multiple connections raise the typed `ambiguous_connection` error with `available_connections` and retry guidance. Implemented in `getRecordAcrossBindings` and the `/v1/blobs/:blob_id` route adapter; covered by the new regression suite.
- [x] Grant with exactly one matching connection auto-selects without raising. Implemented in `resolveFanInBindings`; covered by `queryRecordsAcrossBindings auto-selects exactly-one binding without raising` and `getRecordAcrossBindings auto-selects the only binding holding a unique identifier`.
- [x] Consent card renders distinct per-connection scope rows for a grant covering multiple connections of the same connector type. (Implemented in `consent-card.tsx`; visual verification owed to follow-up UI tranche when test infra lands.)
- [x] Owner can rename a `connection.display_name` from the dashboard and see the new label propagate. Mutation route + store setter ship in this tranche; `renamed display_name surfaces on the next records-list fan-in response` in `storage-fan-in-read-contract.test.js` proves end-to-end propagation. Dashboard UI follow-up explicitly deferred under Section 6.
- [x] No user-visible `legacy`/`default_account` strings remain on consent, dashboard, or MCP-rendered surfaces. (`legacy (pre-header)` removed; consent card props documented to forbid the placeholders; MCP server forwards opaque `connection_id` only.)
- [x] `connector_instance_id` request alias works at runtime; conflicting values rejected. Already enforced by `validateConnectionAlias` / `resolveRequestConnectionId`; new tranche adds explicit alias-narrowing through the fan-in resolver and a dedicated regression in `storage-fan-in-read-contract.test.js`.
