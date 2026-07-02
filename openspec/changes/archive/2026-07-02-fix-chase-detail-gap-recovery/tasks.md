# Tasks: Fix Chase detail-gap recovery

## 1. Connector

- [x] 1.1 Build a served-gap lookup (`Map<account_id, gap_id>`) from
  `ctx.detailGaps`, filtered to Chase account transaction gaps
  (`stream === "transactions"`, `detail_locator.kind === "chase.account"`,
  non-empty `account_id`, `status === "pending"`).
- [x] 1.2 Thread the lookup into `EmitDeps`.
- [x] 1.3 In `runTransactionsAndBalances`, after each account outcome, emit
  `DETAIL_GAP_RECOVERED` with the served `gap_id` when the outcome is `hydrated`
  or `no_activity` and a served gap exists for that `account_id`; consume it so
  it is emitted at most once.
- [x] 1.4 Leave `gap`-outcome accounts on the existing `DETAIL_GAP` path; never
  recover them. Leave served gaps with no reached account untouched.

## 2. Tests

- [x] 2.1 Served gap for account A + A parsed with 0 transactions →
  `DETAIL_GAP_RECOVERED` for A's `gap_id`, and no other recovery.
- [x] 2.2 Served gap for account A + A `gap` outcome → `DETAIL_GAP` re-emitted,
  no `DETAIL_GAP_RECOVERED`.
- [x] 2.3 Served gap for account not enumerated this run → no
  `DETAIL_GAP_RECOVERED`.

## Acceptance checks

- [x] `pnpm --filter @pdpp/polyfill-connectors test` green for the Chase suite.
- [x] `openspec validate fix-chase-detail-gap-recovery --strict` passes.
