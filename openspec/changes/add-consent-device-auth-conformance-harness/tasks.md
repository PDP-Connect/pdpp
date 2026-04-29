## 1. Inventory

- [ ] 1.1 Inventory current pending-consent functions, SQL queries, and route tests.
- [ ] 1.2 Inventory current owner-device-authorization functions, SQL queries, and route tests.
- [ ] 1.3 Identify which lifecycle/security obligations are already route-covered and which need conformance scenarios.
- [ ] 1.4 Decide and document any scenario deferrals where behavior is only safe to test end-to-end today.

## 2. Harness

- [ ] 2.1 Add a test-only conformance harness under `reference-implementation/test/helpers/**`.
- [ ] 2.2 Keep the harness API semantic and narrow; do not expose raw SQL, table names, or a generic repository.
- [ ] 2.3 Add pending-consent lifecycle scenarios for pending lookup, approval/denial terminality, expiry or unavailable state where feasible, and approval-id indirection.
- [ ] 2.4 Add owner-device authorization scenarios for start, lookup, poll-before-approval, approve/exchange, deny/expired rejection, and polling interval semantics where feasible.
- [ ] 2.5 Add secret-leakage/redaction scenarios only if they can be expressed at the storage/helper seam; otherwise explicitly rely on existing route-level tests.

## 3. Drivers And Falsifiability

- [ ] 3.1 Add a SQLite-backed driver that exercises the current reference auth implementation without production code changes.
- [ ] 3.2 Add a deliberately broken driver or negative proof proving the harness fails on at least one real lifecycle/security invariant.
- [ ] 3.3 Keep all existing auth/security route tests; do not delete route-level evidence.

## 4. Validation

- [ ] 4.1 Run the consent/device-auth conformance tests.
- [ ] 4.2 Run nearby existing auth/security tests such as `owner-auth.test.js`, `owner-csrf.test.js`, `security-device-code-exposure.test.js`, and `security-consent-token-handoff.test.js` as appropriate.
- [ ] 4.3 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [ ] 4.4 Run `pnpm --filter pdpp-reference-implementation check`.
- [ ] 4.5 Run `openspec validate add-consent-device-auth-conformance-harness --strict`.
- [ ] 4.6 Run `openspec validate --all --strict`.
- [ ] 4.7 Run `pnpm workstreams:status -- --no-fail` before owner review/merge.
