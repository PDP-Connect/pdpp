## 1. Root and discovery family

- [x] 1.1 Create `reference-implementation/server/routes/root-and-discovery.ts` exporting `mountAsRootAndDiscovery(app, ctx)` and `mountRsRootAndDiscovery(app, ctx)`. (Landed as five per-route mount fns: `mountAsRoot`, `mountAsAuthorizationServerMetadata`, `mountRsRoot`, `mountRsProtectedResourceMetadata`, `mountRsMcpProtectedResourceMetadata`.)
- [x] 1.2 Move the AS `GET /` content-negotiated handler from `server/index.js` into `mountAsRoot`, preserving the `servedRootLandingIfBrowser` branch and the `executeAsDiscoveryIndex` envelope.
- [x] 1.3 Move the AS `GET /.well-known/oauth-authorization-server` handler into `mountAsAuthorizationServerMetadata`.
- [x] 1.4 Move the RS `GET /` content-negotiated handler from `server/index.js` into `mountRsRoot`, preserving the browser-landing branch and `executeRsDiscoveryIndex` envelope.
- [x] 1.5 Move the RS `GET /.well-known/oauth-protected-resource` and `GET /.well-known/oauth-protected-resource/mcp` handlers into `mountRsProtectedResourceMetadata`/`mountRsMcpProtectedResourceMetadata`, preserving the trusted-metadata-host guard and the `getProtectedResourceMetadata`/`getMcpProtectedResourceMetadata` operation contracts.
- [x] 1.6 Update `buildAsApp` and `buildRsApp` in `server/index.js` to call the new mount functions at the same point in route registration; delete the moved blocks.
- [x] 1.7 Acceptance: targeted tests under `reference-implementation/test/` that exercise the moved routes pass; typecheck passes (full `verify` blocked on pre-existing unrelated biome errors on `.ts` files outside this tranche).

## 2. `_ref` operations family

- [ ] 2.1 Create `reference-implementation/server/routes/ref-operations.ts` exporting `mountRefOperations(app, ctx)`.
- [ ] 2.2 Move `_ref` traces / grants / runs / timelines routes (`GET /_ref/traces`, `GET /_ref/traces/:traceId`, `GET /_ref/grants`, `GET /_ref/grants/:grantId/timeline`, `GET /_ref/runs`, `GET /_ref/runs/:runId/timeline`).
- [ ] 2.3 Move `_ref` dataset routes (`GET /_ref/dataset/summary`, `…/summary/streams`, `POST …/summary/rebuild`, `…/summary/reconcile`, `GET /_ref/dataset/size`, `…/top`, `POST …/size/rebuild`, `…/size/reconcile`, `GET /_ref/records/version-stats`).
- [ ] 2.4 Move `_ref` connectors / connections / connector-instances routes (list/get/run/schedule pause/resume/delete and `PATCH /_ref/connections/:connectorInstanceId`).
- [ ] 2.5 Move `_ref` approvals, records-timeline, schedules, deployment, clients, search routes.
- [ ] 2.6 Move `_ref` device-exporters routes (enrollment-codes/enroll, list, source-instances, diagnostics, revoke, heartbeat, ingest-batches, source-instance state/local-collector-gaps).
- [ ] 2.7 Update `buildAsApp` in `server/index.js` to call `mountRefOperations` at the same point in route registration; delete the moved blocks.
- [ ] 2.8 Acceptance: targeted tests under `reference-implementation/test/` (ref-control, dataset summary, device exporter, web push, schedules) pass; `pnpm --dir reference-implementation run verify` passes.

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

- [ ] 5.1 `server/routes/run-interaction.ts` — `POST /_ref/runs/:runId/interaction` plus dev playground.
- [ ] 5.2 `server/routes/web-push.ts` — `_ref/web-push/*` (5 routes).
- [ ] 5.3 `server/routes/source-webhooks.ts` — `POST /_ref/source-webhooks/:sourceId`.
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
