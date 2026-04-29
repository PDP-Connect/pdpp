## 1. Owner Setup

- [x] 1.1 Inventory remaining inline route families in `server/index.js`.
- [x] 1.2 Create final umbrella OpenSpec change.
- [ ] 1.3 Launch disjoint worker branches/worktrees with route-family ownership.

## 2. RS Search, Discovery, And State

- [ ] 2.1 Mount `GET /v1/search` through `rs.search.lexical` without behavior changes.
- [ ] 2.2 Mount `GET /v1/search/semantic` through `rs.search.semantic` without behavior changes.
- [ ] 2.3 Mount `GET /v1/search/hybrid` through `rs.search.hybrid` without behavior changes.
- [ ] 2.4 Move RS root and protected-resource discovery response shaping behind canonical operations or explicit operation-owned helpers.
- [ ] 2.5 Move `GET/PUT /v1/state/:connectorId` semantics behind canonical operations.
- [ ] 2.6 Add/update boundary, operation, and route behavior tests.

## 3. RS Blobs And Record Mutations

- [ ] 3.1 Move `POST /v1/blobs` upload semantics behind a canonical operation.
- [ ] 3.2 Move `GET /v1/blobs/:blob_id` visibility/read semantics behind a canonical operation or explicit blob capability boundary.
- [ ] 3.3 Move record bulk delete, single delete, and ingest semantics behind canonical operations.
- [ ] 3.4 Preserve mutation atomicity, blob visibility, response envelopes, and audit events.
- [ ] 3.5 Add/update boundary, operation, conformance, and route behavior tests.

## 4. AS OAuth, Device, Consent, And Grants

- [x] 4.1 Move DCR register/delete semantics behind canonical operations.
- [x] 4.2 Move device authorization, token, device approval/deny, and introspection semantics behind canonical operations.
- [x] 4.3 Move PAR, consent approve/deny/exchange, and grant revoke semantics behind canonical operations.
- [x] 4.4 Preserve auth gates, CSRF/session behavior, error envelopes, token/device-code secrecy, and spine events.
- [x] 4.5 Add/update boundary, operation, security, and route behavior tests.

## 5. `_ref` Diagnostics

- [ ] 5.1 Move `GET /_ref/records/timeline` semantics behind a canonical operation.
- [ ] 5.2 Move `GET /_ref/deployment` semantics behind a canonical operation or explicit diagnostic capability boundary.
- [ ] 5.3 Move `GET /_ref/clients` semantics behind a canonical operation.
- [ ] 5.4 Preserve owner auth, response envelopes, redaction posture, and diagnostic behavior.
- [ ] 5.5 Add/update boundary, operation, and route behavior tests.

## 6. Integration And Closeout

- [ ] 6.1 Confirm every operation module passes the shared boundary gate.
- [ ] 6.2 Confirm `server/index.js` is limited to HTTP/auth/request-id/response/instrumentation/capability wiring for covered routes.
- [ ] 6.3 Run focused route-family tests plus relevant existing security/protocol/conformance tests.
- [ ] 6.4 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [ ] 6.5 Run `pnpm --filter pdpp-reference-implementation check`.
- [ ] 6.6 Run `pnpm exec openspec validate complete-reference-operation-refactor --strict`.
- [ ] 6.7 Run `pnpm exec openspec validate --all --strict`.
