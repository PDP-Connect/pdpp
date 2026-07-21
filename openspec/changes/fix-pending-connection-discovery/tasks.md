## 1. Server: draft visibility on the dashboard summary read only

- [x] Add `connector-instances/list-by-owner-including-drafts.sql` (SQLite) and a Postgres `listByOwnerIncludingDrafts` method — same rows as `listByOwner`, no `status <> 'draft'` filter.
- [x] Register the new query key in `server/queries/index.ts`.
- [x] Point `listConnectorInstanceRowsForDashboard` (ref-control.ts) at `listByOwnerIncludingDrafts` instead of `listByOwner`.
- [x] Leave `listByOwner` and every other consumer (`/_ref/connections`, `/_ref/connector-instances`, owner-agent reads, `owner-connector-templates.ts`, device-exporter listings) unchanged.

## 2. Owner-state: `setup_in_progress` resolver

- [x] Add `setup_in_progress` to `OwnerStateResolver` and `OwnerStateLifecycle.status` (`runtime/owner-state.ts`).
- [x] Resolve it from `evidence.lifecycle.status === "draft"` at top priority (same discipline as `retired`), before every other check.
- [x] `owner_of_state: "owner"`, `posture: "observed"`.
- [x] Extend the exhaustive cross-product test (`test/owner-state.test.js`) with a `draft` lifecycle fixture and named-fixture gates proving reachability only from explicit draft evidence.

## 3. Console: honest projection + one Continue target

- [x] `source-actionability.ts`: `isSetupInProgressConnector`, a `pending` status kind, `deriveRenderedSourceStatus`/`sourceWorkItemFromConnector`/`formatRenderedRequiredAction`/`formatPrimaryVerdictAction` all honor it, overriding verdict-derived tone exactly like `revoked`.
- [x] `sources-view-model.ts`: `sourceDetailHrefFor` routes a draft's `detailHref` to `/connect/status/:id` instead of `/sources/:id` — the one link every Sources row/CTA/passport action already uses.
- [x] `sources/[connector]/page.tsx`: redirect (not 404) to `/connect/status/:id` for a draft resolved by exact route id.
- [x] `syncs-model.ts`: new `PendingSetupCard` type; drafts route to it instead of `SyncProjection`/`SyncGroup`/`FailureCard` (which need run history a draft doesn't have); counted in the shared `needYourHand` headline.
- [x] `syncs-view.tsx`: render pending-setup cards above failure cards, same needs-you tier.
- [x] `ref-client.ts`: mirror `setup_in_progress` in `RefOwnerStateResolver`.

## 4. Production cache-invalidation fix (found during test-writing)

- [x] `rs-mutation.ts`: `maybeActivateDraftAfterIngest` calls `ctx.invalidateConnectorSummariesCache?.()` after activating a draft, matching every other connection-mutating route.
- [x] `index.js`: wire `invalidateConnectorSummariesCache` into `rsMutationContext`.

## 5. Regression tests

- [x] `owner-state.test.js`: draft-lifecycle named-fixture gates + cross-product coverage (pre-first-record / waiting-owner-action shape).
- [x] `static-secret-draft-connection-route.test.js`: integration tests against a real server —
  - pre-first-record: draft discoverable on `/_ref/connectors` as `setup_in_progress`, still hidden from `/_ref/connections`.
  - waiting owner action: credential captured, no ingest yet — still `setup_in_progress`, never `healthy`/`system_degraded`.
  - success promotion: first successful ingest flips `owner_state` off `setup_in_progress` via the REAL production cache-invalidation path (no test-only cache surgery), connection stays visible on both feeds.
- [x] Console `test:view-models` suite (158 pre-existing tests) passes unchanged with the new `pending` status kind, `PendingSetupCard`, and `detailHref` routing added.

## 6. Validation

- [x] `node --test test/*.test.js` (reference-implementation): 6765 tests, 6698 pass, 5 pre-existing unrelated failures (H-E-B manifest/display-message/interaction-posture, browser-surface-hoist), 0 new failures.
- [x] `pnpm test:view-models` (console): 158/158 pass.
- [x] `pnpm exec tsc --noEmit` (console): clean.
- [x] `openspec validate fix-pending-connection-discovery --strict`.
