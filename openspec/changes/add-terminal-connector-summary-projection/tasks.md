## 1. Terminal projection evidence

- [x] 1.1 Add SQLite and PostgreSQL columns to the existing evidence row.
- [x] 1.2 Publish only against current canonical component evidence.
- [x] 1.3 Invalidate terminal payloads on canonical rebuild and dirty signals.
- [x] 1.4 Add SQLite and PostgreSQL current/stale, payload-parity, and
  read-without-write proofs.
- [x] 1.5 Fence publication on the canonical revision captured with its
  bounded evidence read; prove late A-after-B rebuild/dirty publication is
  rejected on SQLite and gated PostgreSQL.

## 1a. Bounded batch read

- [x] 1.6 Add `getConnectorListSummaryTerminalProjectionBatch`: one bounded
  `IN (...)`/`= ANY` evidence read over requested connection ids (capped at
  `MAX_TERMINAL_PROJECTION_BATCH_IDS` = 100, matching
  `CONNECTOR_SUMMARY_PAGE_LIMIT_MAX`), returning exact
  current/stale/unobserved/failed envelopes per id — never one query per id,
  never a write. Proven for N=0/1/25/100 and an over-bound rejection in
  `test/connector-summary-read-model.test.ts`.

## 2. Deferred scoped-runtime integration

- [ ] 2.1 Authorize and implement the bounded scoped-runtime publisher.
  BLOCKED (2026-07-30): investigated building this on the accepted scoped
  browser-surface observation seam (`allocator-observation.ts`,
  `browser-surface-lease-store.ts`, `health-summary-adapter.ts`, all landed
  by cherry-pick from 333aaefdf). Confirmed by reading
  `projectConnectorHealthSummaryRuntime`/`readConnectorRuntimeReceiptEvidence`
  in `runtime/browser-surface/health-summary-adapter.ts`: for a
  `management.managed` connection, the runtime projection's
  `last_successful_runtime_receipt` requires `lastSuccessfulRun.run_id`,
  which is resolved through unscoped, unbounded run-history synthesis (the
  same `ConnectorRunSummary` machinery `ref-control.ts`'s legacy per-instance
  projection uses) — there is no accepted bounded/scoped "last successful run
  per connection id" primitive yet. A publisher cannot populate this field
  without either (a) reintroducing the unbounded run-history read this
  projection exists to avoid, or (b) omitting/nulling the field, which this
  design explicitly forbids ("never... manufacture a healthy runtime when
  that seam has not published evidence" — nulling a field the payload
  contract declares present is the same false-green risk in the other
  direction: a reader cannot distinguish "genuinely no receipt" from
  "publisher skipped this field"). Non-managed connections (most static
  secret/API-key connectors) do NOT need this join, but a publisher that
  populates the payload only for a subset of connections, silently, is its
  own correctness hazard for a payload whose whole contract is "current
  means every axis was verified." Not attempted. Unblocks when a bounded,
  accepted "last successful run" batch primitive lands as its own reviewed
  change.
- [ ] 2.2 Route owner LIST GET through terminal projection only after the
  publisher can prove complete payload parity without runtime/history reads.
