# Fix Chase detail-gap recovery

## Why

The Chase connector emits per-account `DETAIL_GAP`s when a QFX download or parse
fails, but it never consumes the pending gaps the runtime serves it at `START`
and never emits `DETAIL_GAP_RECOVERED`. A retry that successfully hydrates the
formerly-failed account therefore leaves the durable `connector_detail_gaps` row
untouched. Runtime cleanup then resets the served-but-unrecovered gap from
`in_progress` back to `pending`, so the gap survives forever and the connection
stays permanently degraded even though the account is fully collected.

Live evidence (2026-07-02): retry run `run_1783019414147` for a Chase account
hydrated the account (0 transactions — valid coverage) and completed succeeded,
yet gap `gap_09e85901492bcd0fd24f3bfba3883ce8` (stream `transactions`,
`detail_locator {kind: chase.account, account_id: ...}`) remained `pending` with
`attempt_count 4` and `recovered_run_id null`.

This is a connector conformance bug against the existing detail-gap-recovery
contract (`polyfill-runtime`: "a later run SHALL recover the deferred records"),
not a change to any durable message, store, or runtime contract.

## What Changes

- The Chase connector reads the served pending detail gaps from `START`
  (`ctx.detailGaps`), and when the account behind such a gap is reached in the
  same run's normal QFX pass (outcome `hydrated` or `no_activity`), it emits
  `DETAIL_GAP_RECOVERED` carrying the served `gap_id`.
- A served gap whose account is not reached (still fails, or is no longer
  enumerated) is left untouched: the connector re-emits its `DETAIL_GAP` on
  failure exactly as today, and unmatched served gaps fall through to the
  runtime's existing reset-to-pending. Lose-no-data semantics are preserved.

## Capabilities

Modified: polyfill-runtime (adds a Chase-specific conformance scenario to the
existing detail-gap recovery requirement; no message, store, or runtime
contract changes).

## Impact

- `packages/polyfill-connectors/connectors/chase/index.ts` — recover served
  account gaps.
- Chase connector tests — prove a 0-transaction successful retry clears the
  matching pending gap and leaves unmatched gaps pending.
- No runtime, storage, schema, or message-shape changes.
