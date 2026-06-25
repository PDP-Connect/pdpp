## Context

The observed failure is a coverage-honesty bug, not an MCP client bug and not grant filtering. The owner-token view can see historical Slack records for a channel whose current slackdump archive no longer includes the channel inventory or messages. Recent runs succeeded with no known gaps.

That creates two bad outcomes:

- An agent can query PDPP, see no current records for a channel, and conclude the discussion did not happen.
- A later archive repair can still miss messages if their timestamps are older than the workspace-global `messages.last_ts`.

## Decision

The first fix is fail-loud and non-destructive:

- Slack records the current archive channel inventory on the `messages` state cursor.
- On the next run, Slack compares that prior inventory against the current archive inventory.
- If a previously observed channel is missing, Slack emits a bounded `SKIP_RESULT` diagnostic for the `messages` stream and does not present the run as clean.
- Slack persists `channel_last_ts` and reads messages with a per-channel threshold. A legacy `last_ts` remains a fallback for channels with no per-channel entry.

This does not force a full recrawl or rewrite retained records. It makes partial coverage visible and stops the connector from skipping reappearing partitions behind a single global high-water.

The already-running owner instance needs one additional non-destructive repair because its existing Slack `messages` state predates the new fields. A dry-run-by-default Postgres repair script seeds `observed_channel_ids` and `channel_last_ts` from retained current Slack message records, preserving the existing `archive_dir`, `fetched_at`, and `last_ts`. After that seed, the next connector run can compare retained-known partitions against the current archive inventory and surface missing channels immediately.

Backfill itself is not automatic when the source archive is missing a channel. A targeted backfill must collect that channel into an isolated scoped archive rather than resuming the incomplete workspace archive. The collector runner therefore carries stream resources into `START.scope`, and the Slack connector treats `messages.resources` as channel IDs for prefetch and scoped message emission. Scoped runs disable the legacy global `last_ts` fallback; they use a channel cursor if one exists, otherwise they perform a full targeted channel pass.

Owner-triggered reference runs also accept the same per-stream resource map. The ref and owner-agent run routes validate that `resources` is an object of string arrays, pass it to `controller.runNow`, and the controller converts it into runtime `scope.streams[].resources`. This keeps the repair path on the normal audited run surface instead of requiring a bespoke one-off ingest script.

## Alternatives Considered

### Force a full Slack recrawl now

Rejected for this tranche. It changes source load and credential/runtime behavior before the reason for the missing archive channel is proven. It is a repair operation and should be owner-gated.

### Emit `DETAIL_GAP` for each missing channel

Rejected for now. Missing channel inventory is not per-record detail hydration; `SKIP_RESULT` is the safer existing runtime signal for connector-level partial coverage. A later health-surface change can add a first-class partition coverage event if needed.

### Keep the global cursor and only add diagnostics

Rejected. Diagnostics would prevent false confidence, but reappearing channels could still be skipped if their messages are older than another channel's global maximum timestamp.

## Acceptance Checks

- A run whose prior state contains a channel that is absent from the current archive emits a `SKIP_RESULT` for `messages` with reason `source_partition_missing`.
- A clean run with all prior channels still present emits no missing-channel skip.
- Per-channel message cursors persist one timestamp per observed channel.
- A channel without a per-channel cursor can use the legacy global cursor fallback.
- The state-seed repair can compute retained Slack channel cursors without printing record payloads and writes only when `--apply` is passed.
- A targeted Slack run for `messages.resources=[channel_id]` reads an isolated scoped archive, does not resume the main workspace archive, and does not let the legacy global cursor suppress that channel's older messages.
- The collector runner can express stream resources in the `START` envelope so targeted backfills use the normal ingest path.
- The owner/ref run surfaces can express stream resources and reject malformed resource bodies before starting a connector.
- `openspec validate fix-slack-channel-coverage-highwater --strict` passes.
