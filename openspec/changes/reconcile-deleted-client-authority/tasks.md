## 1. Reconciliation authority

- [x] Add the transactional SQLite/PostgreSQL status-only reconciler.
- [x] Preserve existing rows and non-null revocation timestamps.
- [x] Invoke it from client deletion after event-producing revocation paths.

## 2. Bounded maintenance

- [x] Add the fenced `auth_client_access` cursor name and backend migrations.
- [x] Add exact `client.deleted` keyset evidence selection and look-ahead
      cursor progress.
- [x] Wire one bounded startup round and one periodic phase into the existing
      maintenance timer/chassis.

## 3. Verification and handoff

- [x] Add route regression and SQLite store/cursor tests; add gated PostgreSQL
      parity coverage.
- [x] Run typecheck, targeted lint, and focused route/store/maintenance tests.
- [x] Write the exact read-only live cleanup and verification plan in the
      requested report path.
