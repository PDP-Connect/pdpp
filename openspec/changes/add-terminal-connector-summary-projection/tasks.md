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

## 2. Maintenance publication

- [x] 2.1 Publish the complete owner-list item from the existing bounded
  maintenance observation unit. Reuse the existing `ref-control` synthesizer
  and page-scoped dependency path once, capture the canonical evidence
  revision, and publish only through the existing CAS writer fenced by the
  durable maintenance lease. Publication failure leaves the page cursor
  unchanged for retry; no new queue or connector-specific branch is added.
- [x] 2.2 Add SQLite fail-before/pass-after coverage for invalidation,
  restart-safe cursor progress, complete-payload publication, and eventual
  automatic healing. Existing current/stale, late-snapshot CAS, and read-only
  tests cover concurrent changes and no partial publish.
- [ ] 2.3 Route owner LIST GET through terminal projection only after the
  publisher can prove complete payload parity without runtime/history reads.
