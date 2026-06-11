# Migrate USAA pre-split account balances into account_stats

## Why

`usaa/accounts` retained history holds real balance observations that exist
nowhere else. Before `split-usaa-account-balance-observation-streams` moved
`balance_cents` onto the append-keyed `account_stats` stream, every balance
movement re-versioned the `accounts` entity record. The evidence lane
`ri-version-rationality-evidence-v1` confirmed those pre-split versions carry
genuine numeric balance values that the forward path never re-emitted into
`account_stats`, because the split deployed mid-history.

This makes `usaa/accounts` the one watch row that **must not** be collapsed by
`canonicalize-retained-record-history`. The entity history co-mingles two
populations: real pre-split balance observations (which a fingerprint collapse
would permanently destroy) and pure name/url/shape scrape contamination (which a
fingerprint collapse is *for*). A single canonical fingerprint cannot keep one
while dropping the other. The correct sequence is a data migration that lifts the
real observations into `account_stats` first, after which the entity history is
pure contamination and becomes a legitimate canonical-collapse candidate.

This change designs that migration. It does not run it. It is deliberately
separate from `canonicalize-retained-record-history`: that change compacts
duplicate history in place; this change relocates surviving data into a different
stream before any such compaction may touch `usaa/accounts`.

## What Changes

- Add an explicit, operator-run, dry-run-by-default, idempotent maintenance
  script that backfills the pre-split numeric `balance_cents` observations from
  `usaa/accounts` retained history into the `usaa/account_stats` stream.
- Construct each backfilled record exactly as the live connector would: key
  `{account_id}:{observed_on}`, `observed_on` derived from the source version's
  `emitted_at` UTC date, `balance_cents` from the source version, and
  `available_balance_cents` `null` (the forward path hardcodes `null`; no
  pre-split version carried a numeric available balance).
- Anchor on the post-split forward path as authoritative: keys already present in
  `account_stats` are skipped, never overwritten. The backfill only inserts daily
  observations the forward path never wrote.
- Resolve same-day conflicts deterministically: when one account has multiple
  distinct balances on the same UTC day in history, the latest source version for
  that day wins, matching the connector's same-day "current pull wins" behavior.
- Make the migration auditable and reversible: copy the source `usaa/accounts`
  history it reads and record the exact set of inserted `account_stats` keys into
  per-run backup tables, so a rollback deletes precisely what was inserted and
  nothing else.
- Require copied-database validation before any live apply, mirroring the safety
  boundary `canonicalize-retained-record-history` established.
- Establish a durable reference-architecture requirement that real point-in-time
  observations trapped in pre-split entity history MUST be migrated into their
  observation stream before that entity history is eligible for canonical
  collapse.

No canonical compaction in this lane. No `--apply` against live data. No change
to the USAA connector, the entity stream shape, the `account_stats` forward path,
the retention rule, or any public read path beyond the rows this backfill inserts
into `account_stats`.

## Capabilities

### Modified

- `reference-implementation-architecture` — adds the pre-split observation
  backfill boundary: real point-in-time observations in entity history are
  migrated into the observation stream before the entity history is canonical-
  collapse eligible; specifies the backfill's key construction, current-row
  anchoring, idempotence, backup, copied-DB validation, and rollback evidence.

## Impact

- `reference-implementation/scripts/backfill-usaa-account-stats/` — new
  maintenance script (Postgres and SQLite), dry-run by default, `--apply` to
  write, idempotent, with per-run source-history and inserted-key backup tables
  and a rollback path keyed on the recorded inserted set.
- New focused tests proving: key/`observed_on` construction matches
  `buildAccountStatsRecord`; existing forward-path keys are skipped; same-day
  conflicts resolve to the latest source version; re-running inserts nothing on
  the second pass; rollback deletes exactly the recorded inserted set and leaves
  forward-path rows untouched.
- Operator evidence artifacts under `tmp/workstreams/` for copied-database
  validation (counts before/after, idempotence second-pass delta, rollback
  delta).
- Sequencing note in `canonicalize-retained-record-history`: `usaa/accounts`
  stays audit-only until this backfill is applied and verified.
