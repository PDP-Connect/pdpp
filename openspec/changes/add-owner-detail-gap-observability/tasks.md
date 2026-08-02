## 1. Contract and implementation

- [x] 1.1 Add the exact-connection owner diagnostics route and owner-control
  catalog action.
- [x] 1.2 Add bounded keyset listing to the existing SQLite/Postgres detail-gap
  stores.
- [x] 1.3 Add the whitelisted owner projection, cursor binding, disposition,
  and redaction rules.
- [x] 1.4 Add the reference contract and regenerate checked-in artifacts.

## 2. Verification

- [x] 2.1 Prove owner-only authorization, exact connection scope, invalid
  limits/cursors, deterministic traversal, and safe field redaction.
- [x] 2.2 Add SQLite and gated PostgreSQL listing parity across statuses,
  cursor boundaries, and sibling connections.
- [x] 2.3 Run focused tests, type checks, generated-contract checks, and diff
  hygiene checks.
