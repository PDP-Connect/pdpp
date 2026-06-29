## Why

Slack targeted channel repair can fetch a scoped source archive that contains messages older than the saved per-channel cursor. Those historical holes must be emitted during the repair; otherwise the run can succeed while retained records still miss source archive keys.

## What Changes

- Treat `messages.resources` scoped Slack runs as repair passes over the scoped archive.
- Ignore saved message cursors for the scoped archive while preserving normal cursor filtering for unscoped incremental runs.
- Add a regression test for a scoped archive row older than `channel_last_ts`.

## Capabilities

- Modified: reference-implementation-architecture

## Impact

- Touches the Slack reference connector and Slack runtime tests.
- Does not change PDPP Core, grant semantics, or non-Slack connectors.
