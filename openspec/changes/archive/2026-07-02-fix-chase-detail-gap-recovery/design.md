# Design: Fix Chase detail-gap recovery

## Root cause

The runtime already implements the full detail-gap lifecycle:

- At `START` it serves pending `connector_detail_gaps` rows to the connector via
  `ctx.detailGaps`, marking each served row `in_progress`
  (`reference-implementation/runtime/index.js` `createDetailGapPageReader`).
- When a connector emits `DETAIL_GAP_RECOVERED { gap_id }`, the runtime marks the
  row `recovered`, sets `recovered_run_id`, and removes the id from the run's
  served-gap lease set (`case 'DETAIL_GAP_RECOVERED'`).
- After the connector exits, cleanup calls `resetServedInProgressGaps` on every
  still-leased served id, moving un-recovered served gaps back to `pending`
  (`cleanupChildHandles`).

Amazon and ChatGPT participate in this loop: they read `ctx.detailGaps`,
re-hydrate each served gap, and emit `DETAIL_GAP_RECOVERED` on success. **Chase
never reads `ctx.detailGaps` and never emits `DETAIL_GAP_RECOVERED`.** It only
ever writes new `DETAIL_GAP`s. So a served Chase gap is always reset to pending,
regardless of whether the account was successfully collected on retry.

## Key difference from Amazon/ChatGPT

Amazon runs a *dedicated recovery pass* keyed off `ctx.detailGaps` (order-item
detail is only fetched on demand). Chase is simpler: every run **re-enumerates
and re-downloads all in-scope accounts** in `runTransactionsAndBalances`. The
account behind a served gap is therefore *already being hydrated* by the normal
pass — no separate recovery fetch is needed. The only missing step is
recognizing "the account I just reached matches a served pending gap" and
emitting `DETAIL_GAP_RECOVERED` for it.

## Chosen construction

Thread the served gaps into the per-run `EmitDeps` bag as a
`Map<accountId, gapId>` built once from `ctx.detailGaps`, filtered to Chase
account transaction gaps (`stream === "transactions"`,
`detail_locator.kind === "chase.account"`, non-empty `account_id`). In
`runTransactionsAndBalances`, after each account's outcome:

- outcome `hydrated` or `no_activity` (the account was reached — real coverage):
  if a served gap exists for that `account_id`, emit `DETAIL_GAP_RECOVERED`
  with the served `gap_id` and consume it from the map.
- outcome `gap`: emit the `DETAIL_GAP` exactly as today. Do **not** recover.

The recovery `gap_id` is always sourced from `ctx.detailGaps`, so the connector
can only ever recover a gap the runtime actually served this run — it cannot mark
an unrelated gap recovered. This mirrors the safety property of Amazon's
`readRecoverableAmazonOrderDetailGap` (gap_id comes from the served gap, never
synthesized).

### Why recover on `no_activity` too

`no_activity` means Chase was reached and reported no activity for the window —
source-limited completeness, already counted as `hydrated_keys` in
`DETAIL_COVERAGE`. If a prior run gapped an account and the retry reaches it and
finds no activity, the account is covered; leaving the gap pending would be
false-negative. Consistent with the existing `DETAIL_COVERAGE` treatment of
`no_activity` as coverage.

### 0-transaction hydration

A `hydrated` outcome includes the 0-transaction QFX parse — the account's ledger
was reached and is empty for the window. That is exactly the live case
(`run_1783019414147`): emitting `DETAIL_GAP_RECOVERED` for it is correct.

## Alternatives considered

**Runtime marks served gaps recovered from `DETAIL_COVERAGE.hydrated_keys`.**
Rejected. `DETAIL_COVERAGE` keys are record keys, not `gap_id`s; the runtime
would have to *infer* which served gap a coverage key corresponds to. That
inference is exactly the "silently mark unrelated gaps recovered" failure the
task warns against, and it changes the runtime contract for every connector. The
connector already holds the precise `account_id → gap_id` mapping; keep the
recovery decision where the knowledge is.

**A dedicated Chase recovery pass mirroring Amazon.** Rejected as incidental
complexity: Chase already re-downloads every account every run, so a separate
pass would duplicate work. The gap is not a missing pass; it is a missing
acknowledgement.

## Scope

In scope: Chase connector emitting `DETAIL_GAP_RECOVERED` for served account
gaps it hydrates; focused Chase tests.

Out of scope: any runtime, store, schema, or message-shape change; other
connectors (already conformant); the paged `requestDetailGapPage` drain (Chase
serves all accounts in one enumeration, so a single START page suffices for the
account-level gap model).

## Acceptance checks

1. A Chase run served a pending gap for account A, where account A is reached
   and parsed with 0 transactions, emits `DETAIL_GAP_RECOVERED { gap_id }` for
   A's served gap and no other. (unit/integration test)
2. A Chase run served a pending gap for account A, where account A still fails
   (`gap` outcome), emits a `DETAIL_GAP` for A and does **not** emit
   `DETAIL_GAP_RECOVERED`. (test)
3. A served gap whose `account_id` is not among the enumerated accounts this run
   is never recovered (no `DETAIL_GAP_RECOVERED` emitted for it). (test)
4. `pnpm --filter @pdpp/polyfill-connectors test` green for the Chase suite.
