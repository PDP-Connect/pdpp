## 1. Owner Setup

- [x] 1.1 Create the OpenSpec change for Postgres storage adapter slice 1.
- [x] 1.2 Validate the change skeleton with `pnpm exec openspec validate add-postgres-storage-adapters --strict`.
- [x] 1.3 Confirm the workstream checkpoint has no blockers before implementation.

## 2. Connector State And Scheduler Proof

- [ ] 2.1 Review the existing Postgres connector-state/scheduler proof driver and test.
- [ ] 2.2 Update comments/docs from "spike" wording to this `add-postgres-storage-adapters` proof slice where appropriate.
- [ ] 2.3 Run the connector-state/scheduler SQLite, broken-driver, and Postgres-gated tests.

## 3. Consent And Owner Device Auth Proof

- [ ] 3.1 Add a Postgres-backed consent/device-auth conformance driver with isolated per-run schema setup and teardown.
- [ ] 3.2 Add an env-gated `consent-device-auth-conformance-postgres.test.js` that skips when `PDPP_TEST_POSTGRES_URL` is unset.
- [ ] 3.3 Preserve the existing SQLite, memory, production-store, and broken-driver conformance tests.
- [ ] 3.4 Verify terminal-state precedence, approval-id indirection, expiry, slow-down, and token secrecy through the shared harness.

## 4. Runtime Boundary

- [ ] 4.1 Confirm `pg` remains dev/test scoped and is not imported from production server paths.
- [ ] 4.2 Confirm SQLite remains the default runtime storage backend.
- [ ] 4.3 Confirm records/search/blob/disclosure-spine storage remains untouched by this slice.

## 5. Validation And Closeout

- [ ] 5.1 Run focused conformance tests for connector-state/scheduler and consent/device-auth.
- [ ] 5.2 Run Postgres-gated tests against the profile-gated Compose service when available.
- [ ] 5.3 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [ ] 5.4 Run `pnpm --filter pdpp-reference-implementation check`.
- [ ] 5.5 Run `pnpm exec openspec validate add-postgres-storage-adapters --strict`.
- [ ] 5.6 Run `pnpm exec openspec validate --all --strict`.
