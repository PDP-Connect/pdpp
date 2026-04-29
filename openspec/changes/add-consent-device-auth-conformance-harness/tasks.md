## 1. Inventory

- [x] 1.1 Inventory current pending-consent functions, SQL queries, and route tests.
- [x] 1.2 Inventory current owner-device-authorization functions, SQL queries, and route tests.
- [x] 1.3 Identify which lifecycle/security obligations are already route-covered and which need conformance scenarios.
- [x] 1.4 Decide and document any scenario deferrals where behavior is only safe to test end-to-end today.

Deferrals (kept at route layer, not pinned by this harness):

- `_ref/approvals` and `_ref/traces/*` projection scrubbing (no live `device_code` / `user_code` echoed on operator read surfaces). The reference's `getPendingConsentRowByApprovalId` / `getOwnerDeviceAuthRowByApprovalId` exports return the raw row by design — the scrubbing is a route-layer responsibility. Already covered exhaustively by `security-device-code-exposure.test.js`.
- HTML consent-approve handoff (no live bearer in the HTML branch; opaque `cex_…` exchange code; one-shot redemption). Already covered by `security-consent-token-handoff.test.js`.
- Owner CSRF posture on the device-approve form. Already covered by `owner-csrf.test.js`.
- AI-training affirmative-consent gate. Already covered by route-level pdpp/security suites; not part of the storage-conformance contract.

## 2. Harness

- [x] 2.1 Add a test-only conformance harness under `reference-implementation/test/helpers/**`.
  - `test/helpers/consent-device-auth-conformance.js` — semantic scenarios.
  - Twelve scenarios covering both flows; see `design.md` "Required Semantics To Inventory".
- [x] 2.2 Keep the harness API semantic and narrow; do not expose raw SQL, table names, or a generic repository.
  - Driver methods are `startPendingConsent`, `lookupPendingConsentByRequestUri`, `lookupPendingConsentByApprovalId`, `approvePendingConsent`, `denyPendingConsent`, `forceExpirePendingConsent`, `startOwnerDeviceAuth`, `lookupOwnerDeviceAuthByUserCode`, `lookupOwnerDeviceAuthByApprovalId`, `approveOwnerDeviceAuth`, `denyOwnerDeviceAuth`, `exchangeOwnerDeviceCode`, `forceExpireOwnerDeviceAuth`, `rewindOwnerDevicePollTimer`. No table/SQL surface.
  - The two `force*Expire*` and one `rewind*PollTimer` methods are explicitly declared as test-only seams; drivers that cannot simulate them throw `not_supported` and the harness skips those scenarios. The SQLite driver implements them via direct UPDATEs against the underlying handle inside the driver — never through a production query.
- [x] 2.3 Add pending-consent lifecycle scenarios for pending lookup, approval/denial terminality, expiry or unavailable state where feasible, and approval-id indirection.
  - 5 scenarios: start+lookup, terminal approve (re-approval rejected), terminal deny (approve-after-deny rejected, redeny no-op), approval-id indirection (status flips, grant_id surfaces), expired→unavailable.
- [x] 2.4 Add owner-device authorization scenarios for start, lookup, poll-before-approval, approve/exchange, deny/expired rejection, and polling interval semantics where feasible.
  - 9 scenarios: start envelope shape; positive lookup-by-user_code returning the pending view (client_id / interval / created_at / expires_at, stable across repeated calls); poll-before-approval → `authorization_pending`; rapid second poll → `slow_down`; approve+exchange round-trip with token reuse; approval-is-terminal (re-approval throws `not_found`, original token still exchanges); deny terminal (lookup→null, approve→`not_found`, exchange→`access_denied`); expired→`expired_token`; approval-id indirection.
- [x] 2.5 Add secret-leakage/redaction scenarios only if they can be expressed at the storage/helper seam; otherwise explicitly rely on existing route-level tests.
  - The harness pins approval-id indirection at the storage level (approval_id is a separate, distinct identifier from request_uri / device_code / user_code). Public projection scrubbing on `_ref/approvals` and `_ref/traces` remains a route-level concern and stays in `security-device-code-exposure.test.js`. Documented in the harness docstring and in §1 deferrals above.

## 3. Drivers And Falsifiability

- [x] 3.1 Add a SQLite-backed driver that exercises the current reference auth implementation without production code changes.
  - `test/helpers/sqlite-consent-device-auth-driver.js` calls only exported auth functions: `initiateGrant`, `approveGrant`, `denyGrant`, `getPendingConsent`, `getPendingConsentRowByApprovalId`, `parsePendingConsentRequestUri`, `initiateOwnerDeviceAuthorization`, `approveOwnerDeviceAuthorization`, `denyOwnerDeviceAuthorization`, `exchangeOwnerDeviceCode`, `getOwnerDeviceAuthorizationByUserCode`, `getOwnerDeviceAuthRowByApprovalId`, `registerConnector`, `seedPreRegisteredClients`. No production source change.
  - All 12 conformance scenarios pass under `test/consent-device-auth-conformance.test.js`.
- [x] 3.2 Add a deliberately broken driver or negative proof proving the harness fails on at least one real lifecycle/security invariant.
  - `test/helpers/broken-consent-device-auth-driver.js` is an in-memory driver with three deliberate breaks: pending-consent re-approval slips through (terminal-state violation), owner-device denial does not transition status (poller never observes `access_denied`), polling-rate enforcement is missing (rapid poll returns `authorization_pending` instead of `slow_down`).
  - `test/consent-device-auth-conformance-falsifiability.test.js` asserts that the harness catches all three: the terminal-approval, denial-terminal, and polling-rate scenarios MUST fail under the broken driver.
- [x] 3.3 Keep all existing auth/security route tests; do not delete route-level evidence.
  - No deletions. `owner-auth.test.js`, `owner-csrf.test.js`, `security-device-code-exposure.test.js`, `security-consent-token-handoff.test.js` are unchanged.

## 4. Validation

- [x] 4.1 Run the consent/device-auth conformance tests.
  - `node --test test/consent-device-auth-conformance.test.js test/consent-device-auth-conformance-falsifiability.test.js` — 15 tests pass (14 conformance + 1 falsifiability).
- [x] 4.2 Run nearby existing auth/security tests such as `owner-auth.test.js`, `owner-csrf.test.js`, `security-device-code-exposure.test.js`, and `security-consent-token-handoff.test.js` as appropriate.
  - All pass alongside the new conformance suites (67/67 in the combined run).
- [x] 4.3 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [x] 4.4 Run `pnpm --filter pdpp-reference-implementation check`.
- [x] 4.5 Run `openspec validate add-consent-device-auth-conformance-harness --strict`.
- [x] 4.6 Run `openspec validate --all --strict`.
- [x] 4.7 Run `pnpm workstreams:status -- --no-fail` before owner review/merge.
