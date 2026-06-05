# Tasks

## 1. Forward connector fixes (new connector-side no-op gates)

- [x] 1.1 usaa `transactions`: gate `emitCsvTransactions` and
  `processPdfStatementRow` through one stream-wide optional `FingerprintCursor`
  with `excludeFromFingerprint:["fetched_at"]`; thread it through
  `processAccountTransactions`/`runTransactionsStream` (CSV) and
  `emitPdfStatementTransactions`/`runStatementsStream` (PDF); do NOT prune
  (partial scan); persist `fingerprints` into the `transactions` STATE cursor as
  a reserved sibling of the per-account `last_date` watermarks via
  `withTransactionFingerprints`; have `runTransactionsStream` return the advanced
  watermark cursor and write one final authoritative `transactions` STATE in
  `collect` after both paths (skipped on mid-run session death); add
  `readPriorTransactionFingerprints`.
- [x] 1.2 usaa `inbox_messages`: gate `runInboxStream`'s emit through a
  `FingerprintCursor` with `excludeFromFingerprint:["fetched_at"]`; prune stale
  on the full inbox-page scan; persist `fingerprints` into the `inbox_messages`
  STATE cursor; add `readPriorInboxMessageFingerprints`; pass `state` into
  `runInboxStream`.
- [x] 1.3 chase `current_activity`: gate `emitCurrentActivityForAccount` through
  an optional `FingerprintCursor` with `excludeFromFingerprint:["fetched_at"]`;
  carry it on `EmitDeps.currentActivityFingerprintCursor`; do NOT prune (partial
  scan); persist `fingerprints` into the `current_activity` STATE cursor on every
  exit path (including the zero-row ambiguous-multi-account branch) via a shared
  `buildCursor`; add `readPriorCurrentActivityFingerprints`; open the cursor in
  `collect` when `current_activity` is requested.
- [x] 1.4 amazon `orders`: gate `emitOrderAndItems`' order emit through an
  optional `FingerprintCursor` with `excludeFromFingerprint:["fetched_at"]`;
  carry it on `EmitDeps.ordersFingerprintCursor`; do NOT prune (partial scan /
  year-freezing); persist `fingerprints` as a sibling of `years` in the `orders`
  STATE cursor; leave `order_items` ungated (no `fetched_at`); add
  `readPriorOrderFingerprints`; open the cursor in `collect` when `orders` is
  requested.

## 2. Register the compaction policies

- [x] 2.1 Add `usaa/transactions`, `usaa/inbox_messages`,
  `chase/current_activity`, and `amazon/orders` (each
  `excludeKeys: ["fetched_at"]`) to `COMPACTION_POLICIES` in
  `compact-record-history.mjs`, with short + registry-URL `connectorIds` and a
  `connectorSource` pointing at each new gate. Update the header docstring's
  Family-1 enumeration.

## 3. Test coverage

- [x] 3.1 Forward-gate tests:
  `connectors/usaa/transactions-fingerprint.test.ts`,
  `connectors/usaa/inbox-fingerprint.test.ts`,
  `connectors/chase/current-activity-fingerprint.test.ts`,
  `connectors/amazon/orders-fingerprint.test.ts` — each proves
  no-op-suppressed / real-field-move-emits / STATE round-trip / legacy
  tolerance / connector-vs-compaction fingerprint parity. The partial-scan
  tests pin the NO-prune invariant; the inbox test pins the full-scan prune.
- [x] 3.2 Add the four pairs (in array order) to the
  `COMPACTION_POLICIES exposes the registered policies` assertion in
  `compact-record-history.test.js`.
- [x] 3.3 Add the four parity fixtures to
  `compact-record-history-fingerprint-parity.test.js` and to the static-guard
  `fixturedPairs` set; assert real-field moves change the fingerprint.

## 4. Spec

- [x] 4.1 Extend the Family-1 enumeration in the
  reference-implementation-architecture capability spec to include the four new
  streams via this change's delta (post-merge superset; owner reconciles the
  overlapping in-flight deltas at archive time — see design.md).
- [x] 4.2 Add scenarios describing the run-clock collapse, the preserved real
  field boundaries, and the partial-scan no-prune / full-scan prune invariants.

## Acceptance checks

- [x] `node --test --import tsx connectors/usaa/transactions-fingerprint.test.ts
  connectors/usaa/inbox-fingerprint.test.ts
  connectors/chase/current-activity-fingerprint.test.ts
  connectors/amazon/orders-fingerprint.test.ts` — pass (30 tests).
- [x] full chase + usaa + amazon + ynab connector suites — pass (301 pass,
  6 baseline skips).
- [x] `node --test reference-implementation/test/compact-record-history.test.js`
  — pass (DB-gated tests skipped without `PDPP_TEST_POSTGRES_URL`).
- [x] `node --test --import tsx reference-implementation/test/compact-record-history-fingerprint-parity.test.js`
  — pass.
- [x] `pnpm --dir packages/polyfill-connectors typecheck` — pass.
- [x] `pnpm --dir reference-implementation typecheck` — pass.
- [x] `openspec validate extend-run-clock-churn-gates-remaining-streams --strict` — pass.
- [x] (Owner-only, deferred → Residual Risk at archive) Dry-run each scope
  against live data, confirm `removableVersions`, then `--apply` with the
  per-run backup table as the rollback handle. Not run in this lane (no live
  credentials; no production mutation permitted). Recorded as a residual risk in
  `design.md` per the AGENTS.md archive rule; the offline fingerprint-parity
  tests pin `removable == connector no-op`, so the live step is residue cleanup,
  not a correctness gate.
