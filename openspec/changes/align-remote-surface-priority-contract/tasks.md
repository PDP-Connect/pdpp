## 1. Contract and migration

- [x] 1.1 Create the OpenSpec proposal, design, and architecture delta for the one-way priority migration.
- [x] 1.2 Replace PDPP resource-priority types, defaults, callers, and ordering with `interactive`/`background` while retaining trigger kinds.
- [x] 1.3 Add catalog-gated SQLite and Postgres startup migration for recognized legacy/mixed lease values and new-only constraints, preserving SQLite dependent objects, failing closed on unsupported shapes, and serializing Postgres legacy discovery/mutation with a transaction-scoped advisory lock.

## 2. Verification and delivery gate

- [x] 2.1 Add and run SQLite/Postgres migration, lease/store, scheduler, and trigger-kind tests, including real isolated PG16 proof of both mappings, compound-check preservation, repeat-boot priority-constraint identity, simultaneous public legacy boots, and simultaneous empty-database public bootstraps with no residual advisory locks.
- [x] 2.2 Run the installed-package retained-surface reap boundary test against published `1.5.1`; retained surfaces are excluded from both idle-TTL and capacity-pressure reaping.
- [x] 2.3 Align both package importers and lockfile, run strict OpenSpec validation, typecheck, lint delta, and commit with DCO signoff.
