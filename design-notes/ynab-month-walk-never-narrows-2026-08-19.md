# YNAB re-walks a year of months every hour to find five records

**Status:** measured on the live instance 2026-08-19. Not fixed — filed because
it is real, bounded, and not urgent.

## What it costs

Every YNAB run takes **20 minutes** and emits **163 spine events**, with a
variance of roughly zero across every run today:

```
10:47 → 11:06   19 min   163 events
09:15 → 09:35   20 min   163 events
07:54 → 08:14   20 min   163 events
06:33 → 06:53   20 min   163 events
05:12 → 05:32   20 min   163 events
```

The 10:47 run ingested **25 batches** and added **5 records**.

Identical work every hour. A healthy incremental sync varies with how much
changed; this does not vary at all, which is the tell.

## Why

Most YNAB streams sync properly. `accounts`, `categories`, `payees`,
`transactions`, `scheduled_transactions` and `months` all persist YNAB's
`server_knowledge` per budget and ask only for deltas. That works — the stored
state is present and correct.

`month_categories` cannot. YNAB's API exposes no delta endpoint for it, so the
connector walks months one request each and tracks a `last_fetched_month`
cursor per budget instead.

The cursor filter is:

```ts
fullScanForDetails || lastFetchedMonth === undefined || m.month >= lastFetchedMonth
```

`>=` is inclusive and forward-looking: it re-fetches from the cursor **to
today**, not from the cursor onward. So the cursor pins to the oldest month
that still has activity, and every subsequent run re-walks that whole window.

Live cursors, four budgets:

```
871e1050   2025-08-01      12 months re-walked, every run
28dde0e8   2026-05-01       4 months
f49bc188   2026-08-01       1 month
fb19c420   2026-08-01       1 month
```

Roughly 18 month-fetches an hour, indefinitely, for a handful of changed rows.
`month_categories` is also the largest stream at 12,002 records against
transactions' 8,610.

## Why it matters beyond the waste

A 20-minute run on a 60-minute schedule means YNAB holds a run slot a third of
the time. Deploys wait on it — the safe-deploy guard blocked repeatedly on YNAB
tonight, and one earlier deploy killed a YNAB run mid-flight because the guard
did not yet exist. It also occupies the global writer admission gate, which is
the same gate behind `ingest-503-never-retried-2026-08-19.md`.

So an inefficiency in one connector is buying contention for every other one.

## What a fix would need

The cursor should mean "months at or after this point still need checking",
which is not the same as "the oldest month I have ever fetched". Options, none
verified:

- Advance the cursor to the newest fully-settled month rather than pinning to
  the oldest touched one. YNAB months close: a month sufficiently in the past
  cannot change, so it never needs re-walking.
- Keep a per-month fingerprint and skip a month whose content hash is
  unchanged, paying one cheap request instead of a full ingest.
- Bound the re-walk window explicitly (last N months) and declare the older
  tail settled, which is honest only if coverage evidence says so.

The first is probably right and is the smallest, but it needs a real answer to
"when is a YNAB month provably settled" before it can be claimed as coverage.

## Not a defect

Runs succeed, data is correct, and the cursor state persists as designed. This
is cost, not incorrectness. Worth fixing for the contention it creates rather
than for the records it misses, because it misses none.
