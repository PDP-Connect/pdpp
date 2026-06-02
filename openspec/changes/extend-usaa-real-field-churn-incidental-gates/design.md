# Design — extend run-clock churn gates to USAA accounts + credit_card_billing

## Challenge to the prior report-only classification

`register-current-churn-compaction-policies/design.md` deferred these two
streams with:

> usaa/accounts, usaa/credit_card_billing — churn on real balance fields
> (balance_cents, current_balance_cents, …) in addition to fetched_at.
> Excluding only fetched_at would still leave balance churn (a real change),
> and excluding balances would hide real changes. Report-only.

The decision bar in that sentence is wrong. The question is not "does excluding
`fetched_at` zero the churn?" — it is "does excluding the incidental field hide
any real value?" It does not. Two separate options were conflated:

| Option | Hides real value? | Removes run-clock floor? |
| --- | --- | --- |
| exclude `fetched_at` only | **no** | yes |
| exclude balances | yes — unacceptable | yes |

Only the second is unsafe. The first is exactly the `usaa/statements` /
`chase/accounts` construction applied to a body whose non-excluded fields
happen to be real and volatile. That volatility is a feature: it makes a real
change re-emit. "Still leaves balance churn" = "a balance change is still a
version boundary" = correct.

## Record bodies (what is excluded vs preserved)

| Stream | Run-clock (excluded) | Real fields (preserved → boundary) |
| --- | --- | --- |
| usaa / accounts | `fetched_at` | `balance_cents`, `available_balance_cents`, `name`, `type`, `last_four`, `status` |
| usaa / credit_card_billing | `fetched_at` | `current_balance_cents`, `available_credit_cents`, `credit_limit_cents`, `cash_rewards_cents`, `annual_percent_rate`, `cash_advance_apr`, `billing_status`, `minimum_payment_met`, `account_nickname`, `card_holders` |

`fetched_at` is the only run-clock field in either body (confirmed against the
Zod schemas: every other field is real source data or a hardcoded `null`).

## Semantic-safety proof (retention selector)

Verified against `selectRemovableVersions` (the actual compaction logic), with
`excludeKeys: ["fetched_at"]`:

- Balance series `1000, 1000, 1200, 1200, 1200, 900` (fetched_at differs on
  every row) → removable `[v2, v4]`; retained balances `1000, 1200, 1200, 900`.
  All three distinct balance values (`1000, 1200, 900`) survive as boundaries.
  **Zero balance values lost.**
- Balance moves every run (`1000, 1100, 1200, 1300`) → removable `[]`. Nothing
  collapses; each balance is its own fingerprint boundary.
- credit_card_billing with a rewards move and an APR move interleaved with
  no-op runs → only the no-op runs collapse; every distinct
  (balance, rewards, APR) combination is retained.

The forward connector gate uses the same `recordFingerprint` helper with the
same exclude set, so a connector "no-op emit" and a compaction "removable
version" are the same classification (locked by the parity test).

## Why this is the forward-fix-first construction, not churn-hiding

Per the version-churn construction principle, the first step is a forward gate
at the source. Both streams had **no** connector-side no-op gate — every run
appended a fresh version differing only in `fetched_at`. The forward gate
removes that run-clock floor at the source; the historical compaction policy
mirrors it one-for-one to collapse the pre-gate residue. Neither hides ongoing
real change.

## What remains: point-in-time stream splitting (out of scope)

This change does **not** address the genuinely-volatile-balance churn that
remains after the run-clock floor is removed. When a balance legitimately moves
every run, each move is a real version — correct, but high-volume. The honest
way to reduce *that* is a point-in-time stream split (project balances into a
dedicated time-series stream the way chase already separates `balances` from
`accounts`), which is a connector data-model decision with manifest/schema and
read-path implications. That is a separate design, not a fingerprint exclusion,
and is explicitly left for a future change.

## Owner-gated live apply (deferred)

This lane does NOT run live `--apply`. Per-stream dry-run-first procedure for
the owner:

```
node reference-implementation/scripts/compact-record-history.mjs \
  --connector-instance-id=<cin> --stream=accounts             # usaa
  --connector-instance-id=<cin> --stream=credit_card_billing  # usaa
```

Confirm a non-zero `removableVersions`, then re-run with `--apply`. The tool
creates `compact_record_history_backup_<runId>` in the same transaction as the
DELETE, asserts insert/delete row-count parity, and marks the retained-size
projection dirty for rebuild.

## Sequencing note for the owner

This change MODIFIES the same compaction-tool requirement as the still-pending
`register-current-churn-compaction-policies`. Its spec delta restates the
Family-1 enumeration as the full intended end-state (the prior change's three
run-clock/stored-body streams plus these two) so the archived base is
consistent regardless of archive order. Archive the prior change first; if this
one is archived first, reconcile the enumeration by hand.

## Acceptance checks

- `node --test --import tsx connectors/usaa/accounts-fingerprint.test.ts
  connectors/usaa/credit-card-billing-fingerprint.test.ts` (+ full USAA suite)
- `node --test reference-implementation/test/compact-record-history.test.js`
- `node --test --import tsx reference-implementation/test/compact-record-history-fingerprint-parity.test.js`
- `pnpm --dir packages/polyfill-connectors typecheck`
- `openspec validate extend-usaa-real-field-churn-incidental-gates --strict`

## Out of scope

- Live `--apply` (owner-gated).
- Point-in-time balance stream splitting (separate connector data-model design).
- The other report-only streams from the prior change (github/user,
  slack/channels) — those churn on real fields with no run-clock component to
  safely exclude.
