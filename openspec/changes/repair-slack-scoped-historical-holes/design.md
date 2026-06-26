## Context

The Slack connector maintains per-channel message cursors so normal runs emit only messages newer than each channel's retained high-water mark. A channel-scoped repair run uses `messages.resources` to build a scoped slackdump archive for selected channels.

Post-run verification of `run_1782432784665` found a successful committed run with zero known gaps, but an exact `(channel_id, ts)` comparison still found 30 scoped-archive message keys absent from retained records. Those keys were older than the saved channel cursor, so the scoped repair skipped them.

## Design

For unscoped Slack runs, keep the existing per-channel cursor filter. That preserves normal incremental behavior.

For `messages.resources` scoped runs, treat the scoped archive as the repair boundary and do not apply saved message cursors to the archive read. The connector will emit every deduped message row present in that scoped archive, while the runtime's retained-record ingest remains responsible for no-oping unchanged existing keys. This repairs historical holes below the prior cursor without widening unscoped scheduled collection.

## Alternatives

- Compare source archive keys against retained storage inside the connector: rejected because Collection Profile connectors should not depend on direct retained-store reads.
- Reset all Slack cursors globally: rejected because it widens a targeted repair into a full workspace replay.
- Keep cursor filtering and rely on future runs: rejected because future high-water runs cannot discover historical holes below the cursor.

## Acceptance Checks

- A normal unscoped run still filters messages by per-channel cursor.
- A `messages.resources` scoped run emits scoped archive rows older than `channel_last_ts`.
- The post-repair live verification compares scoped archive `(channel_id, ts)` keys against retained records and reports zero missing keys.
