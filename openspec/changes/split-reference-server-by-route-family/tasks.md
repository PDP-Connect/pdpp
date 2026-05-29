## 1. Root and discovery family

- [x] 1.1 Create `reference-implementation/server/routes/root-and-discovery.ts` exporting `mountAsRootAndDiscovery(app, ctx)` and `mountRsRootAndDiscovery(app, ctx)`. (Landed as five per-route mount fns: `mountAsRoot`, `mountAsAuthorizationServerMetadata`, `mountRsRoot`, `mountRsProtectedResourceMetadata`, `mountRsMcpProtectedResourceMetadata`.)
- [x] 1.2 Move the AS `GET /` content-negotiated handler from `server/index.js` into `mountAsRoot`, preserving the `servedRootLandingIfBrowser` branch and the `executeAsDiscoveryIndex` envelope.
- [x] 1.3 Move the AS `GET /.well-known/oauth-authorization-server` handler into `mountAsAuthorizationServerMetadata`.
- [x] 1.4 Move the RS `GET /` content-negotiated handler from `server/index.js` into `mountRsRoot`, preserving the browser-landing branch and `executeRsDiscoveryIndex` envelope.
- [x] 1.5 Move the RS `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-protected-resource/mcp` handlers into `mountRsProtectedResourceMetadata`/`mountRsMcpProtectedResourceMetadata`, preserving the trusted-metadata-host guard and the `getProtectedResourceMetadata`/`getMcpProtectedResourceMetadata` operation contracts.
- [x] 1.6 Update `buildAsApp` and `buildRsApp` in `server/index.js` to call the new mount functions at the same point in route registration; delete the moved blocks.
- [x] 1.7 Acceptance: targeted tests under `reference-implementation/test/` that exercise the moved routes pass; typecheck passes (full `verify` blocked on pre-existing unrelated biome errors on `.ts` files outside this tranche).

## 2. `_ref` operations family

The original §2.1 plan called for one combined `ref-operations.ts` adapter
covering every `_ref` family. In practice each sub-bullet (2.2–2.6) is a
clean, independently verifiable extraction; bundling them into one file
would put a ~3,000-LOC adapter under one commit. We are instead landing
per-sub-family adapter files (e.g. `ref-spine-correlations.ts`) using
the same `mount...` pattern established in `root-and-discovery.ts`. The
acceptance bar (no protocol-observable change, parity tests pass) is
unchanged.

- [x] 2.1 Adapter files live under `server/routes/<sub-family>.ts`,
  exporting per-route `mount...` functions following the
  `root-and-discovery.ts` pattern. (Decision revision: one combined
  `ref-operations.ts` would be ~3,000 LOC; per-sub-family files match
  the §1 precedent and keep each tranche reviewable in one commit.)
- [x] 2.2 Move `_ref` traces / grants / runs / timelines routes
  (`GET /_ref/traces`, `GET /_ref/traces/:traceId`, `GET /_ref/grants`,
  `GET /_ref/grants/:grantId/timeline`, `GET /_ref/runs`,
  `GET /_ref/runs/:runId/timeline`).
  - [x] List endpoints (`/_ref/traces`, `/_ref/grants`, `/_ref/runs`)
    extracted to `server/routes/ref-spine-correlations.ts` with
    `mountRefTraces`, `mountRefGrants`, `mountRefRuns`. Behaviour-
    preserving; covered by `test/control-plane.test.js` (21 tests pass)
    and `test/ref-read-owner-gate.test.js` (3 tests pass).
  - [x] Detail / timeline endpoints (`/_ref/traces/:traceId`,
    `/_ref/grants/:grantId/timeline`, `/_ref/runs/:runId/timeline`)
    extracted to `server/routes/ref-spine-timelines.ts` with
    `mountRefTraceTimeline`, `mountRefGrantTimeline`,
    `mountRefRunTimeline`. Behaviour-preserving: same `limit`/`cursor`
    parsing, same 404-on-empty-first-page, same `invalid_cursor`
    discrimination. `parseTimelinePageOptions` and the
    `TIMELINE_DEFAULT_LIMIT` / `TIMELINE_MAX_LIMIT` constants moved
    into the new module (sole call site). `executeRefSpineEventsPage`
    continues to own envelope shape and live-bearer redaction. The
    spine substrate read (`listSpineEventsPage`) is host-injected via
    ctx, matching the `ref-spine-correlations.ts` adapter pattern.
- [x] 2.3 Move `_ref` dataset routes (`GET /_ref/dataset/summary`, `…/summary/streams`, `POST …/summary/rebuild`, `…/summary/reconcile`, `GET /_ref/dataset/size`, `…/top`, `POST …/size/rebuild`, `…/size/reconcile`, `GET /_ref/records/version-stats`).
  - [x] All 9 routes extracted to `server/routes/ref-dataset.ts` with `mountRefDatasetSummary`, `mountRefDatasetSummaryStreams`, `mountRefDatasetSummaryRebuild`, `mountRefDatasetSummaryReconcile`, `mountRefDatasetSize`, `mountRefDatasetTop`, `mountRefRecordsVersionStats`, `mountRefDatasetSizeRebuild`, `mountRefDatasetSizeReconcile`. Behaviour-preserving: same owner-session posture, same contract metadata, same query-string parsing, same Postgres/SQLite backend bifurcation, same response envelopes and error handling. `buildDatasetSummaryDeps` and `buildRetainedSizeProjection` moved from `buildAsApp` closure into the adapter (sole call sites). Covered by `test/ref-dataset-routes.test.js` (10/10), `test/ref-read-owner-gate.test.js` (3/3), `test/ref-dataset-summary-operation.test.js`, and `test/ref-dataset-summary-streams-operation.test.js`.
- [x] 2.4 Move `_ref` connectors / connections / connector-instances routes (list/get/run/schedule pause/resume/delete and `PATCH /_ref/connections/:connectorInstanceId`).
  - [x] All 18 routes extracted to `server/routes/ref-connectors.ts` with
    per-route `mount...` fns: `mountRefConnectorsList`,
    `mountRefConnectorDetail`, `mountRefConnectorScheduleGet`,
    `mountRefConnectionsList`, `mountRefConnectorInstancesList`,
    `mountRefConnectionDetail`, `mountRefConnectorInstanceDetail`,
    `mountRefConnectionSetDisplayName`, `mountRefConnectorRun`,
    `mountRefConnectionRun`, `mountRefConnectorScheduleUpsert`,
    `mountRefConnectionScheduleUpsert`, `mountRefConnectorSchedulePause`,
    `mountRefConnectionSchedulePause`, `mountRefConnectorScheduleResume`,
    `mountRefConnectionScheduleResume`, `mountRefConnectorScheduleDelete`,
    `mountRefConnectionScheduleDelete`. Behaviour-preserving: same
    owner-session posture, contract metadata, response envelopes, status
    codes, error mapping, owner-subject namespace resolution, and the
    `onScheduleMutation` callback. `projectRefConnection`,
    `sendRefConnectionDetail`, `resolveRefConnectorNamespace`, and
    `resolveRefConnectionNamespace` moved from the `buildAsApp` closure
    into the adapter (sole call sites). Controller surface
    (`runNow`/`upsertSchedule`/`setScheduleEnabled`/`deleteSchedule`/
    `getSchedule`/`listSchedules`) and substrate reads
    (`listConnectorSummaries`/`getConnectorDetail`/
    `resolveRegisteredConnectorManifest`/
    `resolveOwnerConnectorNamespace`/`createRequestConnectorInstanceStore`)
    are host-injected via ctx. Covered by
    `test/ref-connectors-routes.test.js` (17/17),
    `test/connector-instance-admission-routes.test.js` (7/7),
    `test/ref-control-connection-scope.test.js`,
    `test/ref-connectors-{list,detail}-{boundary,operation}.test.js`,
    `test/ref-connectors-connection-projection.test.js`,
    `test/ref-connector-schedule-get-{boundary,operation}.test.js`,
    `test/connector-instances-acceptance.test.js`, and
    `test/control-plane.test.js`.
- [x] 2.5 Move `_ref` approvals, records-timeline, schedules, deployment, clients, search routes.
  - [x] All 6 routes extracted to `server/routes/ref-admin.ts` with per-route mount fns:
    `mountRefSearch`, `mountRefApprovals`, `mountRefRecordsTimeline`, `mountRefSchedules`,
    `mountRefDeployment`, `mountRefClients`. Behaviour-preserving: same owner-session posture,
    same contract metadata, same query-string parsing (limit, connector_id, stream, since, until,
    order, timestamp_mode), same response envelopes, same error mapping
    (`RefClientsListInvalidRequestError` → 400 `invalid_request`). `collectDeploymentDiagnostics`
    closure (device-exporter pairing, semantic-index state, connector manifests) moved into
    the `refAdminContext.collectDeploymentReport` capability injected from `buildAsApp`.
    `getOwnerSubjectId` and `resolveSingleConnectorIdQueryValue` pass through as context
    capabilities. Covered by `test/ref-admin-routes.test.js` (7/7) and all pre-existing
    operation-level tests (47/47 — approvals, clients, deployment, records-timeline,
    schedules boundary + operation suites).
- [x] 2.6 Move `_ref` device-exporters routes (enrollment-codes/enroll, list, source-instances, diagnostics, revoke, heartbeat, ingest-batches, source-instance state/local-collector-gaps).
  - [x] All 12 routes extracted to `server/routes/ref-device-exporters.ts` with per-route `mount...` fns:
    `mountRefDeviceExporterEnrollmentCodes`, `mountRefDeviceExporterEnroll`,
    `mountRefDeviceExportersList`, `mountRefDeviceExporterSourceInstances`,
    `mountRefDeviceExporterDiagnostics`, `mountRefDeviceExporterRevoke`,
    `mountRefDeviceExporterHeartbeat`, `mountRefDeviceExporterIngestBatches`,
    `mountRefDeviceExporterSourceInstanceStateGet`, `mountRefDeviceExporterSourceInstanceStatePut`,
    `mountRefDeviceExporterLocalCollectorGaps`, `mountRefDeviceExporterLocalCollectorGapsRecovered`.
    Behaviour-preserving: same owner-session and device-credential posture, same collector-protocol
    enforcement, same contract metadata, same response envelopes, status codes, error mapping.
    Module-level helpers (`buildDeviceExporterDiagnostics`, `resolveAuthorizedDeviceSource`,
    `normalizeHeartbeatSourceInstances`, `normalizeDeviceIngestRecords`, `deriveSourceInstanceOutboxState`,
    `referenceLocalDeviceStorageTarget`, `sameConnectorType`, `deviceExporterSourceBindingIdentity`,
    `optionalObject`, `requireNonEmptyString`) move into the adapter; all infrastructure (stores, sync
    state, record ingest, gap store, canonical key) is host-injected via `refDeviceExportersContext`.
    `pnpm --dir reference-implementation run verify` passes; `openspec validate
    split-reference-server-by-route-family --strict` passes; 21/21 targeted tests pass.
- [~] 2.7 Update `buildAsApp` in `server/index.js` to call each
  sub-family's mount function at the same point in route registration;
  delete the moved blocks. (Partial: 2.2 list endpoints wired via
  `refSpineCorrelationsContext`; 2.2 detail/timeline endpoints wired
  via `refSpineTimelinesContext`; 2.3 dataset endpoints wired via
  `refDatasetContext`; 2.4 connectors / connections /
  connector-instances wired via `refConnectorsContext`; 2.5 admin
  routes wired via `refAdminContext`; 2.6 device-exporters wired via
  `refDeviceExportersContext`; remaining
  sub-families pending.)
- [~] 2.8 Acceptance: targeted tests under `reference-implementation/test/` (ref-control, dataset summary, device exporter, web push, schedules) pass; `pnpm --dir reference-implementation run verify` passes.
  - [x] Tests covering 2.2 list endpoints pass: `node --test test/control-plane.test.js` (21/21), `node --test test/ref-read-owner-gate.test.js` (3/3), `node --test test/ref-spine-correlations-list-{boundary,operation}.test.js` (10/10).
  - [x] Tests covering 2.2 detail/timeline endpoints pass: `node --test test/control-plane.test.js`, `node --test test/ref-read-owner-gate.test.js`, `node --test test/ref-spine-events-page-{boundary,operation}.test.js`.
  - [x] Tests covering 2.3 dataset routes pass: `node --test test/ref-dataset-routes.test.js` (10/10), `test/ref-read-owner-gate.test.js` (3/3), `test/ref-dataset-summary-operation.test.js`, `test/ref-dataset-summary-streams-operation.test.js`.
  - [x] Tests covering 2.4 connectors / connections / connector-instances routes pass: `node --test test/ref-connectors-routes.test.js` (17/17), `test/connector-instance-admission-routes.test.js` (7/7), `test/ref-control-connection-scope.test.js`, `test/ref-connectors-list-{boundary,operation}.test.js`, `test/ref-connectors-detail-{boundary,operation}.test.js`, `test/ref-connectors-connection-projection.test.js`, `test/ref-connector-schedule-get-{boundary,operation}.test.js`, `test/connector-instances-acceptance.test.js`, `test/control-plane.test.js` (all green, 126 total).
  - [x] Tests covering 2.5 admin routes pass: `node --test test/ref-admin-routes.test.js` (7/7), `test/ref-approvals-list-{boundary,operation}.test.js`, `test/ref-clients-list-{boundary,operation}.test.js`, `test/ref-deployment-{boundary,operation}.test.js`, `test/ref-records-timeline-{boundary,operation}.test.js`, `test/ref-schedules-list-{boundary,operation}.test.js` (all green, 54 total).
  - [x] Tests covering 2.6 device-exporters routes pass: `pnpm test -- test/device-exporter-routes.test.js test/device-exporter-state-routes.test.js` (21/21, 0 fail).
  - [ ] Remaining sub-family acceptance still gated by §2.7 landing.

## 3. RS read family

- [ ] 3.1 Create `reference-implementation/server/routes/rs-read.ts` exporting `mountRsRead(app, ctx)`.
- [ ] 3.2 Move `/v1/connectors`, `/v1/schema`, `/v1/streams`, `/v1/streams/:stream`, `/v1/streams/:stream/aggregate`, `/v1/streams/:stream/records`, `/v1/streams/:stream/records/:id`, `/v1/blobs/:blob_id`.
- [ ] 3.3 Move `/v1/search`, `/v1/search/semantic`, `/v1/search/hybrid` routes.
- [ ] 3.4 Update `buildRsApp` in `server/index.js` to call `mountRsRead` at the same point in route registration; delete the moved blocks.
- [ ] 3.5 Acceptance: targeted RS read-path tests pass; `pnpm --dir reference-implementation run verify` passes.

## 4. RS mutation family (conditional on §1–§3 passing)

- [ ] 4.1 Create `reference-implementation/server/routes/rs-mutation.ts` exporting `mountRsMutation(app, ctx)`.
- [ ] 4.2 Move `POST /v1/blobs`, `DELETE /v1/streams/:stream/records`, `DELETE /v1/streams/:stream/records/:id`, `POST /v1/ingest/:stream`, `GET /v1/state/:connectorId`, `PUT /v1/state/:connectorId`.
- [ ] 4.3 Move the `/v1/event-subscriptions` cluster (6 routes) into the same file unless diff size requires a sibling adapter.
- [ ] 4.4 Update `buildRsApp` to call `mountRsMutation`; delete the moved blocks.
- [ ] 4.5 Acceptance: targeted RS mutation/ingest/event-subscription tests pass; `pnpm --dir reference-implementation run verify` passes.

## 5. Smaller families (each its own commit, after §1–§4)

- [x] 5.1 `server/routes/run-interaction.ts` — `POST /_ref/runs/:runId/interaction` plus dev playground. Landed: `mountRefRunInteraction` (owner-session, contract metadata, validation, 202 ack) and `mountRefDevPlaygroundSession` (gate-conditional at call site, owner-session, 200 playground session). Behaviour-preserving. Adapter logic covered by `test/run-interaction-adapter.test.js` (15/15 — focused fake-app unit tests for all validation branches, success paths, error forwarding, and playground surface). Integration test `test/run-interaction-control.test.js` is 2 pass / 10 fail on **both** `main` and this branch due to a pre-existing run-start regression (connector run endpoint returns 404); this failure is not introduced by this extraction. `test/run-interaction-stream-playground.test.js` also passes where applicable.
- [x] 5.2 `server/routes/web-push.ts` — `_ref/web-push/*` (5 routes). Landed: five per-route mount fns (`mountRefWebPushConfig`, `mountRefWebPushListSubscriptions`, `mountRefWebPushCreateSubscription`, `mountRefWebPushDeleteSubscription`, `mountRefWebPushTest`). Behaviour-preserving; covered by `test/web-push-notifications.test.js` (36/37 pass, 1 pre-existing skip).
- [x] 5.3 `server/routes/source-webhooks.ts` — `POST /_ref/source-webhooks/:sourceId`. Landed: single `mountRefSourceWebhooks` adapter. Behaviour-preserving (same HMAC posture, same 200/202 status codes, same `SourceWebhookError` mapping). Covered by `test/ref-source-webhook-route.test.js` (3/3 pass) and `test/ref-source-webhook-ingest-operation.test.js` (7/7 pass). Section §7.3 acceptance for this sub-family also met.
- [ ] 5.4 `server/routes/remote-surface.ts` — any non-streaming neko/browser-surface routes still in `index.js`.

## 6. AS OAuth (owner-approval gated)

- [ ] 6.1 STOP-AND-REPORT before extracting. The auth-coupled surface is the highest-risk family; owner must approve the slice (one file vs split) before any move.
- [ ] 6.2 If approved: `server/routes/as-oauth.ts` — `oauth/register`, `oauth/par`, `oauth/authorize`, `oauth/token`, `oauth/device_authorization`, `device/approve`, `device/deny`, `introspect`, `consent`, `consent/approve`, `consent/deny`, `consent/exchange`, `grants/:grantId/revoke`, `agent-connect`.

## 7. Validation

- [ ] 7.1 Run `openspec validate split-reference-server-by-route-family --strict`.
- [ ] 7.2 Run `pnpm --dir reference-implementation run verify` after each family lands.
- [ ] 7.3 Run targeted `node --test` files that cover each moved family.
- [ ] 7.4 Spot-check `git log --stat` to confirm `server/index.js` shrinks and `server/routes/*.ts` grows; confirm no unrelated file changes per commit.
- [ ] 7.5 After all families land, run `pnpm --dir reference-implementation run test` (full suite). Note any baseline failures verified against unchanged `main`.

## Acceptance checks

- `openspec validate split-reference-server-by-route-family --strict` passes.
- Each extracted family is a TypeScript module under `reference-implementation/server/routes/<family>.ts` covered by the existing Biome `includes` (`server/**/*.ts`) and the existing `tsconfig.json` `include` glob.
- `reference-implementation/server/index.js` is strictly smaller after each landed tranche; the composition root retains `buildAsApp`, `buildRsApp`, the `app.use(...)` blocks, capability wiring, and the calls into each family's mount function.
- No protocol-observable behaviour change: same middleware order, same auth posture, same headers (Request-Id, Reference-Revision, PDPP-Version, CSP/X-Frame-Options on AS), same content negotiation on `/`, same response envelope shapes, same status codes, same spine event emission.
- Targeted route tests for each moved family pass; new route-regression tests added where existing coverage is thin.
