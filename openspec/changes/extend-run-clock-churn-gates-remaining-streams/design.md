# Design

## Scope

Four connector-side run-clock no-op gates, mirroring the shipped
`chase/accounts`, `chase/statements`, `chase/transactions`, `usaa/statements`,
`usaa/accounts`, and `usaa/credit_card_billing` pattern exactly:

| Stream | id shape | Mutable real field(s) | Scan | Prune? |
| --- | --- | --- | --- | --- |
| `usaa/transactions` | `hashId(accountId\|date\|amount\|original\|#ord)` | `balance_after_cents` (corrected amount → new id) | partial (overlap window + PDF subset) | **no** |
| `usaa/inbox_messages` | `hashId(date_short\|preview[:120])` | read/unread `status` | full (inbox page) | yes |
| `chase/current_activity` | `account_id\|ui_transaction_id` (or fallback hash) | pending → posted (`status`/`posted_date`/`amount`) | partial (dashboard recent rows) | **no** |
| `amazon/orders` | order id | `delivery_status`/`status_detail` (in transit) | partial (year-freezing) | **no** |

Every gate excludes **only** `fetched_at`. The lossless argument is identical
to the prior streams: any real-field move yields a distinct fingerprint and
re-emits; only a body byte-identical modulo `fetched_at` collapses.

## Why these are no-op/run-clock, not point-in-time

Distinguished from the `github/user` / `slack/channels` / `usaa/accounts`
real-field *point-in-time* split (design-notes/real-field-version-churn-point-in-time-streams-2026-06-02.md):

- A point-in-time stream re-versions ONE key with a continuously-moving sampled
  metric (a balance, a follower count) — the version growth IS the data, and the
  fix is an append-keyed observation stream (OpenSpec-gated, not in this lane).
- These four re-version a key whose body is **byte-identical modulo
  `fetched_at`** on a no-op refresh. The churn is the run clock, not a moving
  metric. The transitions that DO occur (read→unread, pending→posted,
  shipping→delivered) are low-rate semantic-state moves that the
  `fetched_at`-only exclusion **retains** as version boundaries. So a plain
  run-clock fingerprint gate is both sufficient and lossless — no new stream,
  no manifest change, no threshold change.

`ynab/accounts` was audited and intentionally NOT gated here: it has no
run-clock field in its body and uses `server_knowledge` delta-sync, so its
residual churn is a genuine `balance` point-in-time observation — the same class
as `usaa/accounts`' real-field half, which the design note routes to an
append-keyed split (OpenSpec-gated).

## USAA transactions: two emit paths, one cursor

`usaa/transactions` is emitted from two places that hash the same logical
transaction to the same id: the CSV-export path (`emitCsvTransactions`) and the
PDF-statement parse (`processPdfStatementRow`, via `buildStatementRecords`,
which deliberately mirrors the CSV id shape). One stream-wide cursor is shared
across both. The cursor dedupes **across runs** (a transaction whose fingerprint
was carried forward in the prior STATE is suppressed regardless of which path
re-surfaces it this run); within a single run it does not dedupe, so the rare
CSV∩PDF overlap remains a pre-existing bounded ≤2-version case the storage
byte-equivalence backstop covers — not the unbounded run-clock churn this gate
removes.

The transactions STATE cursor is a flat `accountKey -> { last_date }` map; the
`fingerprints` map is a reserved sibling key written via `withTransactionFingerprints`
without disturbing the per-account watermarks. Because the CSV path writes the
transactions STATE per-account (before the PDF path runs) and the PDF path runs
inside the statements orchestration (which writes only a `statements` STATE),
`collect()` performs one final authoritative `transactions` STATE write after
both paths complete — on top of the advanced per-account watermarks returned by
`runTransactionsStream` — so the merged CSV+PDF fingerprint map and the
incremental `last_date` progress are both persisted. This final write is skipped
when the session died mid-run, so a partial run never narrows a map it could not
fully rebuild.

## Compaction policy reconciliation (owner note)

This change MODIFIES the same `record-changes compaction tool` requirement that
three other in-flight changes also touch: `register-current-churn-compaction-policies`,
`extend-usaa-real-field-churn-incidental-gates`, and
`extend-chase-run-clock-churn-gates`. Each restates the Family-1 enumeration
with its own additions. This delta's enumeration is the **post-merge
superset** (all currently-gated pairs + the four new ones), matching the
restatement style the chase change already uses. The deltas are not in
conflict — they monotonically grow one list — but they cannot all archive
against the same baseline independently. The owner reconciles them at archive
time (fold the union into the canonical spec once, then archive the set). This
lane does not archive.

## Out of scope

- The real-field point-in-time append-keyed split (`github/user_stats`,
  `slack/channel_stats`, `usaa/account_balances`, …) — OpenSpec-gated, separate
  lane.
- Live owner `--apply` of any compaction policy against production data.
- ChatGPT throughput / churn (owned by a separate lane).

## Acceptance checks

See tasks.md. All forward-gate, parity, registry-shape, typecheck, and
`--strict` validation checks pass in this lane; live `--apply` is owner-deferred.
