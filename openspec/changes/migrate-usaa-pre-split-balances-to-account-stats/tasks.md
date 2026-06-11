# Tasks — Migrate USAA pre-split account balances into account_stats

All implementation is dry-run-by-default and validated. Live `--apply` against
`pdpp_proof` completed 2026-06-11T05:00Z (owner-sanctioned direct live
execution; copied-DB path superseded by owner docket authorisation).

## 1. Migration script skeleton

- [x] 1.1 Add `reference-implementation/scripts/backfill-usaa-account-stats/`
  with a CLI entry: dry-run by default; flags `--apply`, `--rollback <runId>`,
  `--db <url|path>`, `--instance <connector_instance_id>` (default
  `cin_bc1efca69a1c386d610f0924`). Print only counts and run ids; never print
  balance values or account names.
- [x] 1.2 Resolve the storage backend (Postgres vs SQLite) from the target DB
  and route through the existing record-write path so version numbering,
  `primary_key_text`, and cursor columns are assigned by the same code the
  connector uses.

## 2. Candidate enumeration and key construction

- [x] 2.1 Read `usaa/accounts` history versions whose `balance_cents` is numeric;
  group to distinct `{account_id}:{observed_on}` keys where
  `account_id = record_json->>'id'` and `observed_on = left(emitted_at, 10)`.
- [x] 2.2 For each candidate key, build the `account_stats` record via the
  connector's `buildAccountStatsRecord` (imported, not reimplemented), passing
  the account and `observed_on`. Assert in code that the produced
  `id`/`record_key` equals `{account_id}:{observed_on}` and
  `available_balance_cents` is `null`.
- [x] 2.3 Resolve same-day conflicts: when a `{account_id, day}` key has more than
  one source version, select the highest `version`; record the dropped
  version(s) for the audit trail.

## 3. Anchoring, backup, and apply

- [x] 3.1 Subtract keys already present in `account_stats` (`records` table) from
  the candidate set; the remainder is the insert set. Never update or delete an
  existing `account_stats` row.
- [x] 3.2 Before writing, create per-run backup tables
  `backfill_usaa_account_stats_source_<runId>` (the source history read) and
  `backfill_usaa_account_stats_inserted_<runId>` (the keys to insert), writing
  the inserted-key table in the same transaction as the inserts.
- [x] 3.3 On `--apply`, insert the remainder into `records` and `record_changes`
  (version 1 per new key) through the storage write path; report inserted count,
  skipped count, and runId.

## 4. Rollback

- [x] 4.1 On `--rollback <runId>`, delete from `records` and `record_changes`
  exactly the `account_stats` keys listed in
  `backfill_usaa_account_stats_inserted_<runId>` and nothing else; report deleted
  count. Refuse to delete any key not in the recorded inserted set.

## 5. Live execution (owner-sanctioned direct apply)

- [x] 5.1 Dry-run against live `pdpp_proof`: candidates=21, net-new=16,
  skipped=5, same-day-resolved=6 (estimate was 2; actual live count confirmed).
  Evidence: `tmp/workstreams/usaa-backfill-live-evidence-2026-06-11.md`.
- [x] 5.2 `--apply` against live `pdpp_proof`: inserted=16, skipped=5,
  runId=1781139172522_494069. `account_stats` rows: 10 pre-existing +
  16 inserted = 26 total. `usaa/accounts` records (5) and record_changes (40)
  unchanged.
- [x] 5.3 Idempotence verified: second `--apply` inserted=0, all 21 skipped.
- [x] 5.4 Source backup `backfill_usaa_account_stats_source_1781139172522_494069`
  (40 rows) and inserted-key table
  `backfill_usaa_account_stats_inserted_1781139172522_494069` (16 rows)
  present in live DB for audit/rollback.
- [x] 5.5 Live `--apply` completed. Rollback available via
  `--rollback=1781139172522_494069` if needed.

## 6. Tests

- [x] 6.1 Builder-parity unit test: a backfill record built from a sample history
  version equals `buildAccountStatsRecord(account, observedOn)`.
- [x] 6.2 Anchoring test: candidate keys already present in `account_stats` are
  skipped, not rewritten.
- [x] 6.3 Same-day test: a `{account_id, day}` with two distinct balances resolves
  to the latest source version; the dropped version is in the source backup.
- [x] 6.4 Idempotence test: a second apply inserts 0 rows.
- [x] 6.5 Rollback test: rollback deletes exactly the recorded inserted set and
  leaves forward-path rows untouched.
- [x] 6.6 No-source-mutation test: apply and rollback leave `usaa/accounts`
  version count and `record_changes` rows unchanged.

All 13 tests pass (`node --test reference-implementation/test/backfill-usaa-account-stats.test.js`
with `PDPP_TEST_POSTGRES_URL`).

## 7. Sequencing handoff

- [x] 7.1 In `canonicalize-retained-record-history`, keep `usaa/accounts`
  audit-only and reference this change as the precondition for canonical
  eligibility. (Implemented in `compact-record-history.mjs`; the `usaa/accounts`
  stream is excluded from the canonical registry.)

## Acceptance checks

Live run evidence (redacted to counts):

```
# dry-run (live pdpp_proof, 2026-06-11T05:00Z)
backfill-usaa-account-stats: DRY-RUN — cin_bc1efca69a1c386d610f0924/accounts → account_stats
  scannedKeys:        5
  scannedVersions:    40
  candidates:         21
  skipped (present):  5
  sameDayResolved:    6
  net-new (insert):   16

# apply (live pdpp_proof)
backfill-usaa-account-stats: APPLY — cin_bc1efca69a1c386d610f0924/accounts → account_stats
  scannedKeys:        5
  scannedVersions:    40
  candidates:         21
  skipped (present):  5
  sameDayResolved:    6
  net-new (insert):   16
APPLIED backfill run 1781139172522_494069: inserted 16, skipped 5.
source backup "backfill_usaa_account_stats_source_1781139172522_494069";
inserted-key table "backfill_usaa_account_stats_inserted_1781139172522_494069".

# idempotence check (second apply)
  net-new (insert):   0
  skipped (present):  21
APPLIED backfill run 1781139184076_701190: inserted 0, skipped 21.

# source untouched
usaa/accounts records: 5 (unchanged)
usaa/accounts record_changes: 40 (unchanged)
account_stats rows: 26 (10 pre-existing + 16 inserted)
```

- `openspec validate migrate-usaa-pre-split-balances-to-account-stats --strict` — passes
- `git diff --check` — clean
