## Why

Slack retained historical records for an engineering channel while current connector runs no longer enumerated that channel from the slackdump archive. The run still completed successfully with no known gaps, so downstream clients could mistake stale partial coverage for current absence.

The same connector also used one workspace-global `messages.last_ts`. That is unsafe for partitioned append-only sources: a channel that reappears or backfills messages older than the workspace-global maximum can be skipped.

## What Changes

- Detect when a previously observed Slack channel is absent from the current archive inventory.
- Emit explicit coverage diagnostics for missing previously observed channels instead of reporting a clean run.
- Persist per-channel message high-water state and use it when reading message rows.
- Preserve the legacy global cursor as a compatibility fallback only.

## Capabilities

Modified:
- `polyfill-runtime`

## Impact

- Slack connector code and tests.
- No protocol-core change.
- No destructive recrawl or credential mutation in this tranche.
