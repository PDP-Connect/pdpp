# Design — Migrate USAA pre-split account balances into account_stats

## Context

The reference implementation stores current records in `records` and retained
history in `record_changes`. `split-usaa-account-balance-observation-streams`
(archived 2026-06-04) moved `balance_cents`/`available_balance_cents` off the
`usaa/accounts` entity record and into the append-keyed `usaa/account_stats`
observation stream, keyed `{account_id}:{observed_on}` (UTC day). Before that
split, every balance movement re-versioned the `accounts` entity. Those pre-split
versions still carry the real balances; the forward path only began writing
`account_stats` from the deploy forward.

The evidence lane `ri-version-rationality-evidence-v1` classified `usaa/accounts`
as the one watch row that is **legitimate retained history mixed with
contamination — must be migrated, NOT compacted**. This change is the migration
it recommended (its tranche 3), held deliberately out of
`canonicalize-retained-record-history`.

### Evidence baseline (live `pdpp_proof`, read-only, redacted to counts)

Instance `usaa` / `cin_bc1efca69a1c386d610f0924`, stream `accounts`:

| Fact | Value |
|---|---|
| History versions carrying a numeric `balance_cents` | 32 |
| Distinct `{account_id}:{observed_on}` daily keys those map to | 21 |
| Accounts contributing daily observations (distinct-per-day) | 5 (3 + 4 + 4 + 4 + 6 = 21) |
| Existing `account_stats` records (forward path) | 10 (5 on 2026-06-03, 5 on 2026-06-05) |
| Candidate daily keys already present in `account_stats` | 5 |
| Candidate daily keys net-new to backfill | 16 |
| Overlap keys where history balance ≠ forward-path balance | 0 of 5 |
| `{account_id, day}` keys with >1 distinct balance in history | 2 |
| History versions carrying a numeric `available_balance_cents` | 0 |

Two facts drive the design and refine the evidence report's "11 real balance
moves" framing:

1. The migration unit is the **distinct daily observation** (21 keys), not the
   transition-where-the-value-changed (the report's 11). A daily time series
   records one point per account per day regardless of whether it differs from
   the prior day; the forward path does exactly this.
2. The forward path already covers **5** of those daily keys (2026-06-03), and
   its value agrees with history on **all 5** (zero conflicts). So the forward
   path is authoritative for the days it has already written, the backfill is
   strictly additive for the **16** earlier days, and re-running is provably
   safe.

## Goals / Non-Goals

**Goals:**

- Preserve every real pre-split balance observation by lifting it into
  `account_stats` with the exact key, shape, and `observed_on` derivation the
  live connector uses, so backfilled rows are indistinguishable from
  forward-path rows.
- Anchor on the current/forward-path rows: never overwrite an existing
  `account_stats` key; insert only daily observations the forward path never
  wrote.
- Make the migration idempotent: a second `--apply` inserts nothing.
- Make the migration auditable and reversible: a rollback deletes exactly the
  rows this run inserted, by recorded key, and leaves forward-path rows
  untouched.
- Validate on a copied database before any live apply.
- Establish the durable boundary: real observations in pre-split entity history
  are migrated before that entity history is canonical-collapse eligible.

**Non-Goals:**

- No canonical compaction of `usaa/accounts` history in this lane. That remains
  `canonicalize-retained-record-history`'s job, gated behind this migration.
- No protocol-level PDPP Core change.
- No change to the USAA connector, the `accounts` entity shape, the
  `account_stats` forward path, the retention rule, or any read path other than
  the rows inserted into `account_stats`.
- No deletion or mutation of `usaa/accounts` history. This change only *reads*
  that history; collapsing it is the follow-on canonical change.
- No backfill of `available_balance_cents` values (none exist in history); the
  field is set `null`, matching `buildAccountStatsRecord`.
- No generalization to other connectors/streams in this slice. The durable
  requirement is general; the script and eligibility are USAA-accounts-only.

## Decisions

### Migrate into account_stats rather than canonical-collapse the entity history

The 21 daily balance observations exist only in `record_changes` for
`usaa/accounts`. Collapsing that history to "current only" — what canonical mode
does — would permanently destroy the pre-split balance time series, the same
data-loss the `POINT_IN_TIME_REAL_FIELD_STREAMS` guard prevents for
`ynab/accounts`. The forward split already routes new balances to
`account_stats`; the migration makes history consistent with that target so the
entity history is left holding only name/url/shape contamination.

Alternative considered: fold a "preserve real fields" carve-out into canonical
compaction. Rejected — it conflates two different operations (relocate-then-keep
vs. collapse-duplicates) and would let one tool both move data and delete
history, defeating the old-bad/new-good convergence proof
`canonicalize-retained-record-history` is built on.

### Key construction mirrors the connector exactly

Each backfilled record is built as `buildAccountStatsRecord` builds it:

- `id` / `record_key` = `{account_id}:{observed_on}`.
- `account_id` = the source version's `record_json->>'id'` (the USAA account id,
  or the connector's text-hash fallback — whatever the entity record carried).
- `observed_on` = the source version's `emitted_at` UTC date, i.e.
  `left(emitted_at, 10)`. This matches the live derivation
  `observedOn = emittedAt.slice(0, 10)` in `emitAccountsStream`.
- `balance_cents` = the source version's numeric `balance_cents`.
- `available_balance_cents` = `null` (hardcoded by the builder; no history
  version carried a numeric value).

Constructing the record through the same function the connector uses (not a
hand-rolled shape) keeps backfilled rows byte-equivalent to what the connector
would have emitted on that day, and means a future builder change is caught by
shared tests rather than drifting silently.

Alternative considered: derive `observed_on` from a balance-change timestamp or
a synthetic monotonic clock. Rejected — it would not match the forward path, so
backfilled and forward rows would key differently and the series would split.

### Current/forward rows are authoritative; the backfill is additive only

The forward path owns the days it has already written. The backfill computes its
candidate key set, **subtracts** keys already present in `account_stats`
(`records` table), and inserts only the remainder. It never updates or deletes an
existing `account_stats` row. The evidence (5/5 overlap keys agree, 0 conflicts)
confirms this anchoring is consistent, not a workaround for disagreement.

This also makes the operation safe to interleave with the running connector: a
forward write for "today" that lands between the backfill's read and write is
simply a key the backfill skips.

### Same-day conflicts resolve to the latest source version

Two `{account_id, day}` keys have more than one distinct balance in history
(intra-day balance moves observed by separate runs on the same UTC day). A daily
series holds one point per day, so the backfill must pick one. It picks the
**latest source version for that day** (highest `record_changes.version`),
matching the connector's same-day behavior where a later pull's balance is the
one `account_stats` ends the day on. The choice is deterministic and recorded, so
the picked-vs-dropped versions are auditable.

Alternative considered: keep all intra-day balances by widening the key to
include a timestamp. Rejected — it diverges from the connector's daily key, would
not idempotently re-converge with the forward path, and over-preserves
acquisition cadence as if it were semantic.

### Idempotence is structural, not advisory

Because the only insert target is "candidate keys minus existing
`account_stats` keys," a second `--apply` run computes an empty remainder and
inserts nothing. Idempotence does not depend on a run marker; it falls out of
anchoring on the current rows. A test asserts the second pass is a no-op.

### Backup and rollback are keyed on the recorded inserted set

The migration is additive, so it cannot corrupt source history — but an operator
must be able to undo it cleanly. Per run, before writing, the script:

1. Copies the `usaa/accounts` source history it read into a per-run backup table
   `backfill_usaa_account_stats_source_<runId>` (audit trail of the exact input).
2. Records every `account_stats` key it inserts into
   `backfill_usaa_account_stats_inserted_<runId>` (the precise undo set), written
   in the same transaction as the inserts so the record and the effect cannot
   diverge.

Rollback (`--rollback <runId>`) deletes from `records` and `record_changes`
exactly the `account_stats` keys listed in the inserted table for that run, and
nothing else. Forward-path rows (never in the inserted set) are untouched. This
mirrors `canonicalize-retained-record-history`'s per-run backup-table convention
while inverting the safety direction: that change backs up what it deletes; this
change records what it inserts so it can delete it back out.

### Copied-database validation before any live apply

No `--apply` runs against live retained history until a copied/narrow database
proves: candidate count = 21, net-new inserts = 16, forward-path rows unchanged,
second-pass insert = 0, and rollback restores the exact pre-migration
`account_stats` row set. This is the same gate
`canonicalize-retained-record-history` §6 requires for destructive history
changes; an additive migration earns the same bar because it writes
grant-visible records.

### Write into both records and record_changes, consistent with append streams

`account_stats` is an append-keyed observation stream. A backfilled daily
observation is a new key, so it gets a `records` row (current state for that key)
and a `record_changes` version-1 row (its sole history entry), exactly as a
forward emit of a never-before-seen key would produce. The script reuses the
storage layer's record-write path rather than issuing raw inserts, so version
numbering, `primary_key_text`, and cursor columns are assigned by the same code
the connector relies on.

Alternative considered: insert only into `record_changes`. Rejected — it would
leave `account_stats` current reads missing the backfilled days and split the
series between the two tables.

## Risks / Trade-offs

- **Overwriting forward-path data** → The backfill subtracts existing
  `account_stats` keys and only inserts the remainder; it never updates. Tested.
- **Series split between backfilled and forward rows** → Identical key
  construction and `observed_on` derivation (shared builder) guarantee the same
  key space; the 0-conflict overlap proves alignment on real data.
- **Same-day ambiguity** → Deterministic latest-version-wins rule, recorded per
  run; dropped intra-day versions are auditable in the source backup table.
- **Irreversibility** → Per-run inserted-key table enables exact rollback;
  copied-DB validation asserts rollback restores the pre-migration row set.
- **Account-id drift** → The key uses whatever `id` the entity version carried
  (real id or text-hash fallback). If an account's id representation changed
  across history, its days key under each representation; this is the connector's
  own identity model, not introduced here, and surfaces in the per-account
  evidence counts.
- **Running concurrently with the connector** → Additive, skip-existing design
  tolerates a forward write landing mid-run; the worst case is the backfill skips
  a key the connector just wrote.
- **Premature canonical collapse** → Until this backfill is applied and verified,
  `usaa/accounts` stays audit-only in `canonicalize-retained-record-history`. The
  durable requirement makes that ordering normative, not a comment.

## Migration Plan

1. Land the maintenance script (dry-run default) and tests. No live writes.
2. Run dry-run against a copied `pdpp_proof`: confirm 21 candidates / 16 net-new
   / 5 skipped / 2 same-day resolutions, capture evidence under
   `tmp/workstreams/`.
3. `--apply` on the copied DB; assert forward-path rows unchanged, `account_stats`
   gains exactly 16 rows, series is contiguous per account.
4. Second `--apply` on the copied DB; assert 0 inserts (idempotence).
5. `--rollback <runId>` on the copied DB; assert `account_stats` returns to the
   exact pre-migration row set.
6. Owner-gated live `--apply` only after the copied-DB evidence is reviewed.
7. Only then may `canonicalize-retained-record-history` move `usaa/accounts` from
   audit-only to canonical-eligible, in its own change.

## Acceptance checks

Reproducible; redact balance values and account names, report counts only.

- **Builder parity:** a unit test constructs a backfill record from a sample
  history version and asserts it equals `buildAccountStatsRecord(account,
  observedOn)` for the same inputs (key, `observed_on`, `balance_cents`,
  `available_balance_cents: null`).
- **Candidate enumeration:** dry-run on copied DB reports 21 candidate daily keys
  across 5 accounts (3/4/4/4/6) and 16 net-new after subtracting existing
  `account_stats` keys.
- **Anchoring:** apply leaves all 10 pre-existing `account_stats` rows
  byte-identical; the 5 overlap keys are skipped, not rewritten.
- **Same-day rule:** the 2 multi-balance days each resolve to their latest source
  version; the source backup table shows the dropped version(s).
- **Idempotence:** a second apply inserts 0 rows.
- **Rollback:** `--rollback <runId>` deletes exactly the 16 inserted keys; the
  `account_stats` row set equals the pre-migration set; forward-path rows
  untouched.
- **No source mutation:** `usaa/accounts` version count and `record_changes` rows
  are unchanged by apply and by rollback.
- **No live apply in this lane:** `git diff --check` clean; no
  `backfill_usaa_account_stats_*` tables created against live `pdpp_proof`; no
  `--apply` invoked outside a copied DB.
