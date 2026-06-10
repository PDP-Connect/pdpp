# Extend the run-clock churn gates to Chase statements and transactions

## Why

The 2026-06-03 churn ground-truth shows two Chase streams still appending a new
version of every record on every run, both for the same run-clock reason the
already-shipped `chase/accounts`, `usaa/statements`, `usaa/accounts`, and
`usaa/credit_card_billing` gates fixed:

- **chase / transactions** — `versions/current ≈ 308` (the single worst churn
  ratio in the dashboard). The connector re-downloads an overlapping incremental
  QFX window every run and re-emits each already-seen transaction. A posted
  transaction's identity (`id = account_id|fitid`) and its fields (`date`,
  `amount`, `name`, `memo`, `type`, …) are immutable; the only field that moved
  between runs was the run-clock `fetched_at: deps.emittedAt`.
- **chase / statements** — `versions/current ≈ 11`. A statement's identity
  (`id = shortHash(account_reference|date_delivered|title)`) is immutable and its
  hydrated fields (`document_url`/`pdf_path`/`pdf_sha256`) are content-addressed
  (the path embeds the sha256), so the only field that moved between runs was
  `fetched_at`. This is byte-for-byte the shape of the already-registered
  `usaa/statements` policy.

Excluding **only** the run-clock `fetched_at` from the fingerprint is provably
lossless, exactly as established for the USAA real-field streams:

- A run where any real field moved (a corrected amount, a re-hydrated statement,
  a newly-appearing transaction id) produces a different fingerprint, so the
  record re-emits — the real change is preserved.
- A run where the entire body modulo `fetched_at` is byte-identical to the prior
  version (a re-downloaded transaction in the overlap window, an unchanged
  statement) is the only thing suppressed.

`chase/transactions` is a **partial** incremental scan (per-account windows), so
its fingerprint cursor is never `pruneStale()`d — pruning ids the run did not
look at would drop their fingerprints and re-churn them when the overlap
re-downloads them. `chase/statements` is a full scan of the documents index, so
it prunes like `usaa/statements`.

## What Changes

- Forward fix: add per-record fingerprint cursors to the Chase connector for
  `statements` (gate `processStatementRow`'s hydrated emit and
  `emitStatementIndexOnly`) and `transactions` (gate `emitTransactionsForAccount`),
  each with `excludeFromFingerprint: ["fetched_at"]`, mirroring the existing
  `usaa/statements` / `chase/accounts` pattern. `statements` prunes on the full
  documents-index scan; `transactions` does NOT prune (partial incremental
  scan). Both persist a `fingerprints` map into their stream STATE cursor (for
  `transactions`, alongside the existing `per_account` cursor). Add
  `readPriorStatementFingerprints` and `readPriorTransactionFingerprints`.
- Register two Family-1 ("connector fingerprint mirror") compaction policies,
  each `excludeKeys: ["fetched_at"]`:
  - `chase/statements`
  - `chase/transactions`
- Extend the canonical Family-1 stream enumeration in the
  reference-implementation-architecture capability spec to include the two new
  streams, and add a scenario pinning that a real transaction/statement field
  move stays a fingerprint boundary and that the partial-scan transactions
  cursor is never pruned.
- Add forward-gate tests and compaction registry + fingerprint-parity coverage,
  including explicit "real field move is a distinct fingerprint" and "no-prune
  partial-scan" assertions.

No new HTTP route, schedule, or automatic job. No real transaction or statement
field is excluded from any fingerprint. No change to the retention rule,
backup/apply safety, dry-run default, or any public read path. Live owner
`--apply` is deferred and owner-gated.

## Capabilities

- Modified: reference-implementation-architecture

## Impact

- `packages/polyfill-connectors/connectors/chase/index.ts` — `statements` +
  `transactions` fingerprint gates + `readPriorStatementFingerprints` +
  `readPriorTransactionFingerprints` + `transactionsFingerprintCursor` on
  `EmitDeps`.
- `packages/polyfill-connectors/connectors/chase/statements-fingerprint.test.ts`,
  `packages/polyfill-connectors/connectors/chase/transactions-fingerprint.test.ts`
  — new forward-gate tests.
- `reference-implementation/scripts/compact-record-history.mjs` — two registry
  entries + header docstring.
- `reference-implementation/test/compact-record-history.test.js` — registry
  shape assertion.
- `reference-implementation/test/compact-record-history-fingerprint-parity.test.js`
  — two parity fixtures (with real-field-boundary assertions) + static-guard
  set.
- `openspec/specs/reference-implementation-architecture/spec.md` — Family-1
  enumeration (via this change's delta).
