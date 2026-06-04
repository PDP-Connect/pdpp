# Split YNAB account balances into an append-keyed observation stream

## Why

The `ynab / accounts` stream mixes point-in-time balance metrics into an entity
record that carries stable account identity. Every balance movement produces a
new version of the same account record.

This is genuine point-in-time churn, not run-clock churn. YNAB uses
`server_knowledge` delta-sync: a call to `/budgets/{id}/accounts?last_knowledge_of_server=N`
returns only accounts that changed since knowledge `N`. A balance move IS a
real source change, so it advances `server_knowledge` and re-returns the
account. Fingerprinting the entity record without splitting would not suppress
it (balance differs → fingerprint differs → re-emit, correctly), and excluding
`balance` from the fingerprint would hide real value movement — both rejected by
the point-in-time-stream design accepted in
`split-point-in-time-observation-streams`.

The correct construction, mirroring `github/user_stats` and `slack/channel_stats`,
is to project the sampled balance metrics into a dedicated append-keyed
observation stream, keep the `accounts` entity stream for identity/settings
fields only, and fingerprint the entity stream so an account whose identity has
not moved does not re-emit when only its balance ticks.

## What Changes

- **ynab / `account_stats` stream (new)** — append-keyed observation records for
  `balance`, `cleared_balance`, `uncleared_balance`, keyed by
  `{account_id}:{YYYY-MM-DD}` (UTC). One record per account per calendar day;
  re-running on the same day with the same balances is idempotent.
- **ynab / `accounts` entity stream (modified)** — drops the three balance
  fields; retains identity and settings fields (`name`, `type`, `on_budget`,
  `closed`, `transfer_payee_id`, direct-import flags, `last_reconciled_at`,
  `note`, debt detail, `deleted`). Gated by a per-record fingerprint cursor so a
  balance-only delta does not version the entity record.
- **Delta-sync preserved** — `accounts` remains a `server_knowledge` partial
  scan. The entity fingerprint cursor carries forward un-returned accounts and
  MUST NOT prune (an account absent from a delta was not deleted, it just did
  not change). The `server_knowledge` cursor is unchanged.
- **Manifest updated** — `account_stats` stream declared with `semantics: "append"`;
  `accounts` entity schema/views/range_filters drop the balance fields.
- **Connector tests added** — `account_stats` builder + entity-split + delta-sync
  no-prune assertions.

No data compaction in this lane. No `--apply`. No change to the retention rule,
backup/apply safety, or any public read path beyond the new stream declaration
and the entity field removal.

## Capabilities

- Modified: reference-implementation-architecture (YNAB account-balance
  observation stream; extends the Family-2 observation-stream class already
  added by `split-point-in-time-observation-streams`).

## Impact

- `packages/polyfill-connectors/connectors/ynab/index.ts` — `accountRecord()`
  drops balance fields; new `accountStatsRecord()`; `collectAccounts()` splits
  emit and gates the entity stream on a fingerprint cursor (`openAccountCursor`).
- `packages/polyfill-connectors/connectors/ynab/schemas.ts` — `accountStatsSchema`;
  `accountsSchema` drops balance fields; `SCHEMAS` gains `account_stats`.
- `packages/polyfill-connectors/connectors/ynab/accounts.test.ts` — new file with
  builder, entity-split, fingerprint, and delta-sync no-prune assertions.
- `packages/polyfill-connectors/manifests/ynab.json` — `account_stats` stream
  added; `accounts` schema/views/range_filters drop balance fields.
