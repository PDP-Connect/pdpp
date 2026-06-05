# Design — extend run-clock churn gates to Chase statements + transactions

## Root cause (from connector code, not assumption)

Both streams carry a run-clock `fetched_at: deps.emittedAt` in the record body
and had **no** connector-side no-op gate, so every run appended a fresh version
differing only in `fetched_at`:

| Stream | Emit site | Run-clock (excluded) | Real fields (preserved → boundary) |
| --- | --- | --- | --- |
| chase / transactions | `emitTransactionsForAccount` | `fetched_at` | `date`, `amount`, `currency`, `type`, `name`, `memo`, `check_number`, `reference_number`, `source`, `account_name`, `account_id`, `fitid` |
| chase / statements | `processStatementRow` (hydrated) + `emitStatementIndexOnly` | `fetched_at` | `title`, `date_delivered`, `account_reference`, `account_id`, `document_url`, `pdf_path`, `pdf_sha256` |

`fetched_at` is the only run-clock field in either body (confirmed against the
emit code: every other field is immutable transaction/statement source data or a
content-addressed PDF reference whose path embeds its sha256). The runtime
byte-equivalence backstop (`records.js` suppresses a current-record upsert whose
`record_json` is byte-identical) cannot help here precisely because `fetched_at`
makes the body differ on every run — which is exactly why a fingerprint cursor
that *excludes* `fetched_at` is the right gate.

## Why excluding only `fetched_at` is lossless

This is the same construction the owner already accepted for `usaa/statements`,
`chase/accounts`, `usaa/accounts`, and `usaa/credit_card_billing`. Excluding the
run-clock field, never a real field:

- A run where any real field moved — a corrected `amount` on an existing
  `fitid`, a statement that newly hydrates (`pdf_path`/`sha` appear), a
  genuinely-new transaction id — produces a different fingerprint, so the record
  re-emits. The real change is preserved as a version boundary.
- A run where the body modulo `fetched_at` is byte-identical to the prior
  version (a transaction re-downloaded in the incremental overlap window, an
  unchanged statement re-listed) is the only thing suppressed.

## The one non-obvious cut: transactions is a PARTIAL scan → never prune

`chase/accounts` and `chase/statements` are **full scans** (the dashboard lists
all accounts; the documents index lists all statements), so their cursors
`pruneStale()` — an entity no longer listed drops its fingerprint so a
re-appearance re-emits.

`chase/transactions` is a **partial incremental scan**: each run downloads a
per-account QFX window starting at `max_seen_date − overlap`, so a run only sees
recent transactions, not the full history. Pruning here would drop the
fingerprints of every older transaction the run did not look at; the next run's
overlap window would then re-download those transactions, find no prior
fingerprint, and re-emit them — re-introducing the churn under a different name.
The transactions cursor is therefore **never pruned**. Its fingerprint map is
carried forward in the transactions STATE cursor alongside the existing
`per_account` watermark. A transaction id is globally unique
(`account_id|fitid`), so a single stream-wide cursor is correct across accounts.

This no-prune invariant is pinned by a dedicated test (run a wide window, then a
narrow window omitting an older tx, then a wide window again → the older tx stays
suppressed because its fingerprint was never pruned).

## Semantic-safety (retention selector parity)

The forward connector gate uses the same `recordFingerprint` helper with the
same `["fetched_at"]` exclude set the compaction policy declares, so a connector
"no-op emit" and a compaction "removable version" are the same classification.
This is locked by `compact-record-history-fingerprint-parity.test.js`, which
also asserts a real `amount`/`name` move on a transaction and a body change on a
statement each yield a DISTINCT fingerprint that is never collapsed.

## Why forward-fix-first, not churn-hiding

Per the version-churn construction principle, the first step is a forward gate at
the source. Both streams had no connector-side no-op gate; the forward gate
removes the run-clock floor at the source, and the historical compaction policy
mirrors it one-for-one to collapse the pre-gate residue. Neither hides ongoing
real change, and the numeric ratio thresholds are untouched — an undeclared
high-churn stream is still caught.

## Sequencing note for the owner

This change MODIFIES the same compaction-tool requirement as the still-pending
`register-current-churn-compaction-policies` and
`extend-usaa-real-field-churn-incidental-gates`. Its spec delta restates the
Family-1 enumeration as the full intended end-state (the prior changes' streams
plus these two) so the archived base is consistent regardless of archive order.
Archive the earlier churn changes first; if this one is archived first, reconcile
the enumeration by hand.

## Owner-gated live apply (deferred)

This lane does NOT run live `--apply`. Per-stream dry-run-first procedure for the
owner:

```
node reference-implementation/scripts/compact-record-history.mjs \
  --connector-instance-id=<cin> --stream=statements     # chase
  --connector-instance-id=<cin> --stream=transactions   # chase
```

Confirm a non-zero `removableVersions`, then re-run with `--apply`. The tool
creates `compact_record_history_backup_<runId>` in the same transaction as the
DELETE, asserts insert/delete row-count parity, and marks the retained-size
projection dirty for rebuild.

## Acceptance checks

- `node --test --import tsx connectors/chase/statements-fingerprint.test.ts
  connectors/chase/transactions-fingerprint.test.ts` (+ full Chase suite)
- `node --test reference-implementation/test/compact-record-history.test.js`
- `node --test --import tsx reference-implementation/test/compact-record-history-fingerprint-parity.test.js`
- `pnpm --dir packages/polyfill-connectors typecheck`
- `openspec validate extend-chase-run-clock-churn-gates --strict`

## Out of scope

- Live `--apply` (owner-gated).
- The remaining real-field churn streams (ynab/accounts balances,
  chatgpt/custom_instructions, chatgpt/shared_conversations) — those churn on
  real or semantic fields with no safe run-clock field to exclude; they need a
  point-in-time stream split or fixture evidence, documented in the lane report.
- The already-shipped github/user_stats + slack/channel_stats split (separate
  pushed change, pending deploy).

## Residual Risks

- **Owner-only live dry-run → `--apply` (deferred).** Carried into archive per
  the AGENTS.md archive rule. The procedure is documented above under
  "Owner-gated live apply (deferred)": the owner dry-runs the `chase/statements`
  and `chase/transactions` scopes, confirms `removableVersions`, then runs
  `--apply` with the per-run `compact_record_history_backup_<runId>` table as the
  rollback handle. This is residue cleanup of historical run-clock churn, not a
  correctness gate — the forward connector no-op gate and the offline
  fingerprint-parity tests already pin `removable == connector no-op`.
- **Cross-change reconciliation (resolved at this archive).** The "Sequencing
  note for the owner" above anticipated that this delta MODIFIES the same
  compaction-tool requirement as the other churn-family changes. That
  reconciliation was performed once at archive time: the canonical
  `reference-implementation-architecture` requirement was hand-folded to the
  union of all five deltas (three policy families, full Family-1 enumeration, the
  partial-scan and inventory paragraphs, and all scenario sets) before archiving
  the cluster. No residual reconciliation remains.
