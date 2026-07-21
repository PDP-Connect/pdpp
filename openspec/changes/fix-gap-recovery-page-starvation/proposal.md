## Why

Live Gmail attachment recovery is starved: `connector_detail_gaps` holds 10,012
`pending`/`temporary_unavailable` rows at `attempt_count = 0` (never claimed)
alongside exactly 256 rows stuck at `attempt_count = 104`, repeatedly
re-attempted on every successful 15-minute run for days, while the other
10,012 never advance.

Two independent, compounding root causes:

1. **Connector-neutral store starvation.** `listPendingGaps` (the recovery-page
   selection query in `connector-detail-gap-store.js`, both SQLite and
   Postgres backends) ordered candidates `ORDER BY created_at LIMIT
   candidateLimit`, where `candidateLimit` is bounded by the page byte budget
   (`detail-gap-paging.js`, default 256KB / ~1536 bytes/row ⇒ exactly 256
   rows). Being served for recovery (marked `in_progress`, then reset to
   `pending` by end-of-run cleanup when the connector does not recover or
   re-defer it) does not change a row's `created_at`, so the identical oldest
   256 rows sorted first on every subsequent call. Rows past the byte-bounded
   page were never read from the store at all. This is a connector-neutral
   defect: any connector whose recovery rate for a stream is below 100% per
   page, with a pending backlog larger than one page, starves every row after
   the page boundary indefinitely.

2. **Gmail never consumes served attachment gaps.** The Gmail connector emits
   `DETAIL_GAP` for a failed attachment hydration but never reads
   `START.detail_gaps` (the runtime's per-run recovery page) back — it has no
   code path that re-attempts a previously-failed attachment outside its
   normal forward per-message walk. Gmail's forward walk only visits new UIDs
   (`priorUidnext:*`); an attachment gap on an already-scanned message is
   never revisited by the ordinary pass, so even with fair store-level
   selection Gmail would still never actually recover a served gap — it would
   just cycle it back to pending every run with no progress. This is separate
   from cause 1 and would recur for any connector with the same
   ignore-served-gaps shape.

This is unrelated to the `recovered_run_id` stickiness semantics already
fixed in the deployed source (§10-A) — no gap here is stuck `recovered`; all
10,268 are `pending`, and ancestry/upsert stickiness is not implicated.

Recovered from a prior, unmerged branch (commits `bc30b04fc`, `2020c5782`,
`a496fb223`) that independently diagnosed and
fixed both causes but never landed on `main`. That branch's fix and tests are
adopted here (cherry-picked and reconciled against current `main`), plus
additional multi-run drain regression tests proving the full liveness property
across a realistic 15-minute-cadence backlog larger than one page.

## What Changes

- Change the connector-neutral recovery-page selection order in both the
  SQLite and Postgres `listPendingGaps` implementations from strict
  `created_at` FIFO to an aging-bucket order: `attempt_count` minus an age
  bonus (one bucket per 15-minute rotation window the row has waited since its
  last attempt, capped at 8 buckets / 2 hours), tie-broken by
  `last_attempt_at`/`created_at` then `gap_id`. A row served for recovery
  sorts behind never-attempted rows on the next selection once its effective
  rank exceeds theirs, AND an old row that keeps losing to a stream of
  zero-attempt fresh arrivals ages into priority over time — closing both the
  simple head-of-queue starvation and the subtler "fresh work keeps
  outranking old work forever" edge case.
- Wire the Gmail connector's attachment hydration path to consume
  `START.detail_gaps`: when a served pending `attachments` gap's attachment id
  (and, if present, message id / part index) matches an attachment that is
  successfully hydrated and emitted this run, the connector now emits
  `DETAIL_GAP_RECOVERED` with the served `gap_id` — closing the loop the store
  fix alone cannot close for Gmail. Also: a pending attachment detail backlog
  now activates the historical attachment-backfill pass (in addition to the
  existing explicit `streamsToBackfill` flag), so durable attachment gaps on
  already-scanned messages are reachable again instead of only ever being
  revisited by luck of the incremental UID window. The served-gap probe lane
  is streaming, not batch-probed: it walks START order, reuses same-message
  `X-GM-MSGID` lookups, hydrates as it goes, and caps Gmail metadata lookups at
  32 unique messages per run so provider work cannot explode ahead of byte
  admission. To keep the run visibly alive during a slow hydration, it emits a
  bounded `phase=hydrating` progress tick immediately after admission and then
  the settled progress once the record lands.
- No change to admission (`resolveRecoveryAdmission`), backoff
  (`next_attempt_after`), terminal classification, or byte/candidate-limit
  math — the WHERE clause, byte budget, and lease semantics are untouched.

### Revision (independent gate review, 2026-07-15)

An independent judge pass on the initial commit (`d66f38302`) found one
blocker: the Gmail recovery guard checked only that the attachment *record
emitted*, not that hydration *succeeded* — a `failed` (or `too_large`)
attachment still emits a record, so a served gap whose attachment failed
hydration again was wrongly acknowledged `DETAIL_GAP_RECOVERED`. Because the
store's same-run stickiness keeps a `recovered` row recovered when the
re-upserted `DETAIL_GAP` shares the same run id, and the commit-gate credits a
required key against a `pending` OR `recovered` durable gap, this would have
silently and permanently abandoned exactly the population the fix targets: a
served gap that fails again. This revision:

- Gates the `DETAIL_GAP_RECOVERED` emit on `hydration_status === "hydrated"`
  only. `too_large` is deliberately excluded even though the commit-gate
  already treats it as covered via `optional_skip_keys`: a `too_large`
  outcome is never the subject of a durable `DETAIL_GAP` in the first place
  (gaps are only ever created for `failed`), so there is nothing to recover —
  any pre-existing pending row from an earlier `failed` attempt is already
  harmless and left to age or terminalize on its own.
- Adds the missing spec-required regression: a served gap whose attachment
  fails hydration again must never emit `DETAIL_GAP_RECOVERED` and must land
  on the ordinary `DETAIL_GAP` requeue path (proven mutation-resistant against
  the pre-fix guard).
- Makes the SQLite recovery-page ordering's `last_attempt_at` fallback
  symmetric with Postgres via `NULLIF(last_attempt_at, '')` (a latent,
  currently-unreachable engine divergence the gate flagged as a nit).

## Capabilities

Modified:

- `reference-implementation-runtime`
- `polyfill-runtime`
