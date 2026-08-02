## 1. Contract and runtime

- [x] 1.1 Define the terminal `DETAIL_GAP` wire shape for `too_large` with required served identity and bounded evidence.
- [x] 1.2 Add runtime validation and lease-owned terminal CAS settlement with fail-closed stale-lease handling.
- [x] 1.3 Preserve planned `run_cap_deferred` accounting and transient retry behavior.

## 2. Gmail and durable store

- [x] 2.1 Emit the accepted-record terminal policy outcome while preserving `optional_skip_keys` and suppressing attempted/recovered events.
- [x] 2.2 Add SQLite/Postgres parity for exact pending repair selection, idempotent terminalization, and served terminal settlement.
- [x] 2.3 Preserve terminal evidence and status across later same-identity upserts.

## 3. Owner repair and verification

- [x] 3.1 Add the dry-run-by-default, bounded, exact-scope Gmail repair command and JSON receipt.
- [x] 3.2 Add mutation-sensitive tests for the four-row starvation shape, lease CAS, transient rows, later upserts, and repair fail-closed behavior.
- [x] 3.3 Run focused tests, package checks, typechecks, and strict OpenSpec validation.
