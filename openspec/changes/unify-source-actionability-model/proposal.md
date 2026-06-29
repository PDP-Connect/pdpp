## Why

The owner console still mixes urgent owner work, optional refresh/retry actions, maintainer/system issues, and passive checking in one "Anything wrong" list while the hero count names only the urgent subset. That makes the dashboard look inconsistent and forces owners to learn internal action categories.

## What Changes

- Add a shared owner-console source actionability projection derived from `rendered_verdict`.
- Group source work by owner-facing actionability rather than internal verdict taxonomy.
- Make Overview counts and headings match the visible rows in each scope.
- Prevent one connection from appearing twice in the same actionability panel.
- Keep Sources and detail routes anchored to exact connection identities.

## Capabilities

Modified:
- `reference-connection-health`

## Impact

- Owner-console Overview and source-health view models.
- Focused tests for live-shaped source rows, counts, grouping, and copy.
- No PDPP Core protocol change and no data mutation.
