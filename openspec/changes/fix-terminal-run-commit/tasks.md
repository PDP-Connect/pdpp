## 1. Durable collector work

- [ ] 1.1 Add mandatory non-lossy v3 outbox migration and terminal run-commit payload with versioned canonical envelope/hash, stable id, supplied state delta, safe facts, scope, and old-binary refusal.
- [ ] 1.2 Replace the successful terminal run's separate checkpoint plus terminal POST with one predecessor-gated terminal run-commit drain item.
- [ ] 1.3 Preserve state-only checkpoint behavior and report unacknowledged terminal work accurately without a child-failure gap.

## 2. Atomic reference commit

- [ ] 2.1 Add an authorized endpoint/client that recomputes the canonical hash and binds receipt lookup to authenticated device, source, canonical connector, resolved connection, and run.
- [ ] 2.2 Implement SQLite state delta, terminal event, receipt, and run-history projection in one immediate transaction; exact replay and typed 409 conflict must be fail closed.
- [ ] 2.3 Implement the matching PostgreSQL operation with one transaction client and transaction-aware spine/run-history seam, without nested helper transactions.
- [ ] 2.4 Update route/OpenAPI, schema/backup/restore inventory, and old-path usage telemetry/retirement boundary.

## 3. Crash-boundary verification

- [ ] 3.1 Add a deterministic multi-stream/multi-batch oracle for a terminal request that never reaches the server.
- [ ] 3.2 Add a deterministic response-loss oracle that commits server-side then drops the response; assert exactly one terminal event after restart.
- [ ] 3.3 Add hash/body conflict, concurrent same/different payload, device/source/connection authorization, omitted/empty-state, rollback-after-each-write, legacy, and backup-restore replay oracles.
- [ ] 3.4 Exercise every oracle against SQLite and disposable Postgres with a real outbox restart and cursor-aware no-reemit connector.

## 4. Validation

- [ ] 4.1 Run focused collector/reference tests, typecheck, Biome, OpenSpec strict validation, schema/backup inventory checks, and inspect the final diff.
