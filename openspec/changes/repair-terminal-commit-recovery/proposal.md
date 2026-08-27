# Repair terminal commit recovery

## Why

A permanently rejected `terminal_run_commit` can be requeued forever by the
current recovery command. The retry sends the same invalid bytes and leaves the
connection in `dead_letter`, even though a newly completed collector pass can
generate a valid terminal commit after the canonicalizer fix.

## What Changes

- Treat dead-letter terminal commits as rebuild-required evidence, not blind
  retryable uploads.
- Let a completed pass generate and deliver a replacement terminal commit while
  retaining the rejected row.
- Record a durable supersession only after the replacement is acknowledged.
- Keep ordinary retryable dead-letter recovery unchanged.

## Capabilities

### Modified

- `local-collector-durable-work`

### Added

- None.

### Removed

- None.

## Impact

The local outbox schema gains a small supersession ledger. Queue inspection,
scan gating, recovery, and lifecycle summaries ignore only terminal rows with a
completed ledger entry; the original row and its payload remain available for
forensics. Server validation is unchanged.
