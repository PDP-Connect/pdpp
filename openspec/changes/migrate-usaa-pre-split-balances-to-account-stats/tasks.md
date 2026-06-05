# Tasks — Migrate USAA pre-split account balances into account_stats

All implementation is dry-run-by-default and copied-database-validated. No
`--apply` against live `pdpp_proof` until the owner accepts the copied-DB
evidence (§5).

## 1. Migration script skeleton

- [ ] 1.1 Add `reference-implementation/scripts/backfill-usaa-account-stats/`
  with a CLI entry: dry-run by default; flags `--apply`, `--rollback <runId>`,
  `--db <url|path>`, `--instance <connector_instance_id>` (default
  `cin_bc1efca69a1c386d610f0924`). Print only counts and run ids; never print
  balance values or account names.
- [ ] 1.2 Resolve the storage backend (Postgres vs SQLite) from the target DB
  and route through the existing record-write path so version numbering,
  `primary_key_text`, and cursor columns are assigned by the same code the
  connector uses.

## 2. Candidate enumeration and key construction

- [ ] 2.1 Read `usaa/accounts` history versions whose `balance_cents` is numeric;
  group to distinct `{account_id}:{observed_on}` keys where
  `account_id = record_json->>'id'` and `observed_on = left(emitted_at, 10)`.
- [ ] 2.2 For each candidate key, build the `account_stats` record via the
  connector's `buildAccountStatsRecord` (imported, not reimplemented), passing
  the account and `observed_on`. Assert in code that the produced
  `id`/`record_key` equals `{account_id}:{observed_on}` and
  `available_balance_cents` is `null`.
- [ ] 2.3 Resolve same-day conflicts: when a `{account_id, day}` key has more than
  one source version, select the highest `version`; record the dropped
  version(s) for the audit trail.

## 3. Anchoring, backup, and apply

- [ ] 3.1 Subtract keys already present in `account_stats` (`records` table) from
  the candidate set; the remainder is the insert set. Never update or delete an
  existing `account_stats` row.
- [ ] 3.2 Before writing, create per-run backup tables
  `backfill_usaa_account_stats_source_<runId>` (the source history read) and
  `backfill_usaa_account_stats_inserted_<runId>` (the keys to insert), writing
  the inserted-key table in the same transaction as the inserts.
- [ ] 3.3 On `--apply`, insert the remainder into `records` and `record_changes`
  (version 1 per new key) through the storage write path; report inserted count,
  skipped count, and runId.

## 4. Rollback

- [ ] 4.1 On `--rollback <runId>`, delete from `records` and `record_changes`
  exactly the `account_stats` keys listed in
  `backfill_usaa_account_stats_inserted_<runId>` and nothing else; report deleted
  count. Refuse to delete any key not in the recorded inserted set.

## 5. Copied-database validation (no live apply)

- [ ] 5.1 Snapshot live `pdpp_proof` to a copied database. Run dry-run; capture
  candidate=21 / net-new=16 / skipped=5 / same-day-resolved=2 to
  `tmp/workstreams/`.
- [ ] 5.2 `--apply` on the copy; assert `account_stats` gains exactly 16 rows, the
  10 forward-path rows are byte-identical, each account's daily series is
  contiguous, and `usaa/accounts` history is unchanged.
- [ ] 5.3 Second `--apply` on the copy; assert 0 inserts (idempotence).
- [ ] 5.4 `--rollback <runId>` on the copy; assert `account_stats` equals the
  pre-migration row set and forward-path rows are untouched.
- [ ] 5.5 (Owner-gated) Live `--apply` against `pdpp_proof` only after the
  copied-DB evidence is reviewed and accepted. Record as a residual risk if it
  remains the sole open step.

## 6. Tests

- [ ] 6.1 Builder-parity unit test: a backfill record built from a sample history
  version equals `buildAccountStatsRecord(account, observedOn)`.
- [ ] 6.2 Anchoring test: candidate keys already present in `account_stats` are
  skipped, not rewritten.
- [ ] 6.3 Same-day test: a `{account_id, day}` with two distinct balances resolves
  to the latest source version; the dropped version is in the source backup.
- [ ] 6.4 Idempotence test: a second apply inserts 0 rows.
- [ ] 6.5 Rollback test: rollback deletes exactly the recorded inserted set and
  leaves forward-path rows untouched.
- [ ] 6.6 No-source-mutation test: apply and rollback leave `usaa/accounts`
  version count and `record_changes` rows unchanged.

## 7. Sequencing handoff

- [ ] 7.1 In `canonicalize-retained-record-history`, keep `usaa/accounts`
  audit-only and reference this change as the precondition for canonical
  eligibility.

## Acceptance checks

Run on a copied database; redact values, report counts only.

```sh
# dry-run: enumerate candidates and net-new
node reference-implementation/scripts/backfill-usaa-account-stats --db <copy>
#   -> candidates=21 across 5 accounts (3/4/4/4/6), net-new=16, skipped=5,
#      same-day-resolved=2

# apply on the copy
node reference-implementation/scripts/backfill-usaa-account-stats --db <copy> --apply
#   -> inserted=16, skipped=5, runId=<id>; 10 forward rows byte-identical

# idempotence
node reference-implementation/scripts/backfill-usaa-account-stats --db <copy> --apply
#   -> inserted=0

# rollback
node reference-implementation/scripts/backfill-usaa-account-stats --db <copy> --rollback <id>
#   -> deleted=16; account_stats == pre-migration row set

# source untouched (before and after)
#   record_changes count for usaa/accounts unchanged by apply and by rollback
```

- `openspec validate migrate-usaa-pre-split-balances-to-account-stats --strict`
- `git diff --check`
- No `backfill_usaa_account_stats_*` table created against live `pdpp_proof`; no
  `--apply` invoked outside a copied database in this lane.
