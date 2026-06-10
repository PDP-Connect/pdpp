# Tasks

## 1. Forward connector fixes (new connector-side no-op gates)

- [x] 1.1 chase `statements`: gate the hydrated emit in `processStatementRow`
  and the index-only emit in `emitStatementIndexOnly` through an optional
  `FingerprintCursor` with `excludeFromFingerprint:["fetched_at"]`; prune stale
  on the full documents-index scan; persist `fingerprints` into the `statements`
  STATE cursor; add `readPriorStatementFingerprints`; open the cursor in
  `collect` when `statements` is requested.
- [x] 1.2 chase `transactions`: gate `emitTransactionsForAccount` through an
  optional `FingerprintCursor` with `excludeFromFingerprint:["fetched_at"]`;
  carry the cursor on `EmitDeps.transactionsFingerprintCursor` (one stream-wide
  cursor across accounts; ids are globally unique `account_id|fitid`); do NOT
  prune (partial incremental scan); persist `fingerprints` into the
  `transactions` STATE cursor alongside `per_account`; add
  `readPriorTransactionFingerprints`; open the cursor in `collect` when
  `transactions` is requested.

## 2. Register the compaction policies

- [x] 2.1 Add `chase/statements` (`excludeKeys: ["fetched_at"]`) and
  `chase/transactions` (`excludeKeys: ["fetched_at"]`) to `COMPACTION_POLICIES`
  in `compact-record-history.mjs`, each with short + registry-URL `connectorIds`
  and a `connectorSource` pointing at the new connector gate. Update the header
  docstring's Family-1 enumeration.

## 3. Test coverage

- [x] 3.1 Forward-gate tests:
  `connectors/chase/statements-fingerprint.test.ts` and
  `connectors/chase/transactions-fingerprint.test.ts` — each proves
  no-op-suppressed / real-field-move-emits / STATE round-trip / legacy
  tolerance / connector-vs-compaction fingerprint parity. The transactions test
  additionally pins the partial-scan NO-prune invariant and the new-id boundary.
- [x] 3.2 Add the two pairs (in array order) to the
  `COMPACTION_POLICIES exposes the registered policies` assertion in
  `compact-record-history.test.js`.
- [x] 3.3 Add `chase/statements` and `chase/transactions` parity fixtures to
  `compact-record-history-fingerprint-parity.test.js` and to the static-guard
  `fixturedPairs` set; assert real-field moves change the fingerprint.

## 4. Spec

- [x] 4.1 Extend the Family-1 enumeration in the
  reference-implementation-architecture capability spec to include
  `chase/statements` and `chase/transactions` via this change's delta.
- [x] 4.2 Add a scenario describing the run-clock collapse, the preserved real
  transaction/statement state boundary, and the no-prune partial-scan invariant
  for `chase/transactions`.

## Acceptance checks

- [x] `node --test --import tsx connectors/chase/statements-fingerprint.test.ts
  connectors/chase/transactions-fingerprint.test.ts` — pass.
- [x] full Chase connector suite — pass.
- [x] `node --test reference-implementation/test/compact-record-history.test.js`
  — pass (DB-gated tests skipped without `PDPP_TEST_POSTGRES_URL`).
- [x] `node --test --import tsx reference-implementation/test/compact-record-history-fingerprint-parity.test.js`
  — pass.
- [x] `pnpm --dir packages/polyfill-connectors typecheck` — pass.
- [x] `openspec validate extend-chase-run-clock-churn-gates --strict` — pass.
- [x] (Owner-only, deferred → Residual Risk at archive) Dry-run each scope
  against live data, confirm `removableVersions`, then `--apply` with the
  per-run backup table as the rollback handle. Not run in this lane (no live
  credentials; no production mutation permitted). Recorded as a residual risk in
  `design.md` per the AGENTS.md archive rule; the offline fingerprint-parity
  tests pin `removable == connector no-op`, so the live step is residue cleanup,
  not a correctness gate.
