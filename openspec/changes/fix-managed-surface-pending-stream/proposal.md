## Why

Browser-session repair runs can use a managed browser surface and still emit a pending `manual_action` interaction. The stream mint route currently treats every pending interaction as a legacy connector-registered CDP target, so the dashboard can mint a stream token that immediately fails because no target is registered.

## What Changes

- Teach pending browser interactions to attach to the active managed browser-surface lease when one is ready for the run.
- Preserve the legacy connector-registered target path when no managed surface is available.
- Add a regression test for a pending `manual_action` backed by a managed surface.

## Capabilities

Modified:
- `reference-run-assistance`

## Impact

- Fixes owner-facing browser-session repair streams for managed-surface connectors such as ChatGPT.
- No protocol surface changes.
- No connector manifest changes.
