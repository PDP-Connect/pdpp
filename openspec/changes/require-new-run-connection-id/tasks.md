## 1. Run persistence invariant

- [x] 1.1 Inventory persisted run writers and the SQLite/PostgreSQL storage contract.
- [x] 1.2 Enforce connector-instance identity at the shared spine write boundary.
- [x] 1.3 Supply identity from runtime, browser-surface, local-device, and recovery writers.

## 2. Verification

- [x] 2.1 Add an authority test that attacks every run writer without an identity.
- [x] 2.2 Add SQLite and PostgreSQL parity coverage and a historical-null read regression.
- [x] 2.3 Run focused tests, type checks, OpenSpec validation, and inspect the final diff.
