## 1. Lock the defect and wire contract

- [x] 1.1 Commit the real SQLite regression oracle that proves a balanced `2xx` permanent rejection cannot advance state without a durable receipt, using the current invalid-record-identity case.
- [ ] 1.2 Add pure response-contract tests for non-empty-line indexing, balanced counts, complete unique in-range rejection indexes, duplicate receipt ids at distinct duplicate-input indexes, non-enumerable receipt shape, and fail-closed malformed envelopes.
- [ ] 1.3 Add mixed-version contract tests proving a new server is loss-safe with the prior runtime and a new runtime rejects a prior server's count-only response.

## 2. Add the durable quarantine store

- [ ] 2.1 Add additive SQLite and PostgreSQL migrations for owner/connection-bound pending rejection metadata, exact bounded payload bytes, replay key, quota accounting, and indexes.
- [ ] 2.2 Implement the narrow backend-parity store for fenced insert-or-replay, lookup, bounded cursor-paginated listing, concurrency-safe byte-quota admission, and connection-delete cleanup.
- [ ] 2.3 Prove exact replay, byte accounting, quota refusal, concurrent duplicate admission, restart persistence, cross-owner isolation, and deletion on real SQLite.
- [ ] 2.4 Run the same store contract against real PostgreSQL when configured and record an explicit skip when it is unavailable.
- [ ] 2.5 Add migration-upgrade and retained-table rollback oracles; verify no existing owner records require or receive fabricated backfill receipts.

## 3. Persist hosted ingest rejections before acknowledgement

- [ ] 3.1 Preserve `{inputIndex, rawLine, parsedRecord?}` through `executeRecordsIngest` and its batch capability so every terminal outcome maps to the zero-based non-empty NDJSON line sequence without reconstructing bytes from objects.
- [ ] 3.2 Add the narrow host `insertOrReplayRejection` dependency after owner/connection admission; route `malformed_ndjson` and only the existing typed storage permanent-error allowlist through it, refuse hosted-rejection mode for device reservations, and keep unknown/systemic failures non-2xx.
- [ ] 3.3 Return `records_attempted` and the complete metadata-only rejection vector on successful hosted ingest without repeating payloads or error messages.
- [ ] 3.4 Re-check connection writable state and the exact run/connection fence inside each quarantine transaction; add fault oracles for cancellation/revoke/delete races, before commit, after commit before response, quota exhaustion, and a later systemic sibling failure after durable prefix effects.
- [ ] 3.5 Prove on real SQLite and PostgreSQL that accepted sibling records and rejection receipts survive safely, exact request replay is idempotent, and no response claims an uncommitted receipt.

## 4. Gate runtime progress on complete destination evidence

- [x] 4.1 Extend the hosted ingest response reader to validate attempted counts and the full rejection vector before the batch can clear.
- [ ] 4.2 Replace submitted-as-`totalFlushed` accounting with emitted, attempted, confirmed accepted, permanently rejected, and unresolved retryable counters in progress, spine events, terminal results, and run history; any retained legacy `records_flushed` fields count confirmed accepted records only.
- [ ] 4.3 Gate per-stream `STATE` staging and final checkpoint commit on complete accepted-or-receipted outcomes while preserving the existing transient-manifest-drift behavior.
- [ ] 4.4 Add runtime oracles for all-rejected, mixed accepted/rejected, missing/duplicate/out-of-range receipts, response loss after server commit, cancellation, and multi-stream isolation.
- [ ] 4.5 Re-run the confirmed invalid-identity system journey and prove the run may commit only when the quarantine payload survives a fresh server process and is queryable by its owner.

## 5. Add bounded owner inspection and lifecycle cleanup

- [ ] 5.1 Add owner-session-only, connection-first read-only list and detail routes with a maximum page size, stable opaque cursor pagination, metadata-only lists, explicit bounded payload retrieval, and non-disclosing cross-owner rejection.
- [ ] 5.2 Add fixed-field quarantine audit evidence and prove payload bytes plus parser/storage exception text stay out of list, timeline, mutation, audit, health, and log surfaces.
- [ ] 5.3 Integrate rejection cleanup into the existing SQLite and PostgreSQL connection-deletion transaction or prove active foreign-key cascade parity.
- [ ] 5.4 Prove list/detail authorization, paging bounds, payload non-disclosure, fresh-process retrieval, and connection-deletion cleanup on both backends.
- [ ] 5.5 Record atomic retry, discard, payload replacement, status resolution, and device-exporter adoption as explicit follow-up scope; add no mutation route or generic unit-of-work seam in this tranche.

## 6. Verify, document, and stage rollout

- [ ] 6.1 Run focused tests, typecheck, formatter/linter, deterministic mass and diff checks, and strict OpenSpec validation; record unrelated failures separately.
- [ ] 6.2 Run a fresh-process hosted journey on SQLite and PostgreSQL when configured: reject, commit cursor only with a complete receipt, restart the server, and retrieve the exact pending payload through the owning connection.
- [ ] 6.3 Document the additive reference-hosted response, read-only owner inspection routes, non-empty-line indexing, quota configuration, privacy/retention behavior, server-first deployment, and server-rollback run-disable requirement.
- [ ] 6.4 Have a different agent review the implementation and evidence against the confirmed reproduction, backend parity, transaction boundaries, payload privacy, and heterogeneous-host constraints before landing.
