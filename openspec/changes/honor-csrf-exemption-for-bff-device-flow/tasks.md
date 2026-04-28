# Tasks

## 1. Reference AS

- [x] Confirm the existing `application/json` CSRF exemption on `/device/approve` and `/device/deny` is the intended contract (no AS code changes).
- [x] Remove the prematurely-added `POST /_ref/owner/mint-self-export-token` route from `reference-implementation/server/index.js`.

## 2. Dashboard BFF

- [x] Rewrite `apps/web/src/app/dashboard/lib/owner-token.ts mintOwnerToken` to drive the canonical RFC 8628 device flow with `Content-Type: application/json` for all three POSTs.
- [x] Forward the owner session cookie on `/device/approve` so `requireOwnerSession` sees the operator's signed-in subject.

## 3. Operator-facing Tokens page

- [x] Switch `apps/web/src/app/dashboard/lib/operator-bootstrap.ts approveOwnerBootstrapFlow` and `denyOwnerBootstrapFlow` to JSON content-type.
- [x] Add operator-supplied `name` field to `OwnerBootstrapFlow` and propagate through `startOwnerBootstrapFlow` + the composite `issueOwnerTokenAction`.
- [x] Replace the editable `client_id` input on `/dashboard/deployment/tokens` with a Name input; surface the canonical bootstrap `client_id` as a fixed protocol detail in the inspector.

## 4. Tests

- [x] Delete `reference-implementation/test/dashboard-bff-mint.test.js` (endpoint reverted).
- [x] Replace its coverage in `reference-implementation/test/owner-csrf.test.js` with three pins for the real `/device/approve` route: JSON success, form-encoded 403, no-cookie 401.

## 5. Validation

- [x] `openspec validate honor-csrf-exemption-for-bff-device-flow --strict` passes.
- [x] `openspec validate --all --strict` passes.
- [ ] Manual verification: `/dashboard/deployment/tokens` end-to-end against `PDPP_OWNER_PASSWORD`-enabled AS issues a bearer that introspects active.
