## Completed implementation

- [x] Durable connector-summary evidence exists on SQLite and PostgreSQL.
- [x] Owner mutations, record mutations, schedules, and run lifecycle evidence
  have durable dirty/checkpoint repair paths.
- [x] Startup and periodic maintenance perform repair and reconciliation.
- [x] Ordinary connector-summary GET requests are bounded, read-only, and do
  not retire enrollment shells, expire attention, or reconcile evidence.
- [x] Scoped diagnostics retain exact deep evidence semantics.
- [x] SQLite and real PostgreSQL cover dirty-mark parity, zero-write reads,
  large-record independence, lifecycle/schedule repair, and fold isolation.
- [x] PostgreSQL per-file database names use the generator's actual grammar.
- [x] Full PostgreSQL green is mandatory and achieved; shared-database tests
  scope single-connection folds while fleet maintenance remains unscoped.
