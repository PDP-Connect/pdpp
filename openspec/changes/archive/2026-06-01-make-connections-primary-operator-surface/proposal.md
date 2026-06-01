## Why

The operator console currently hides Connections under Explore and suppresses the run action for existing browser-bound connections such as ChatGPT. That makes the owner control path hard to find and blocks the already-supported manual run flow that can surface browser interaction through the run timeline.

## What Changes

- Promote Connections to a primary dashboard navigation item instead of an Explore subitem.
- Keep Explore scoped to record-content search and recency browsing; keep Jump scoped to artifact-id lookup.
- Render `Sync now` for existing owner-runnable connections, including browser-bound connections that start managed-browser/manual-interaction runs.
- Keep non-clickable guidance for push-mode local-device connections, where the dashboard cannot start a remote pull.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-surface-topology`: operator dashboard navigation and owner-run affordances for existing connections.

## Impact

- Affected code: `apps/console/src/app/dashboard/components/shell.tsx`, records list/detail connection controls, and related tests.
- Affected behavior: `/dashboard/records` remains the Connections page but becomes top-level in the dashboard IA; ChatGPT can be triggered from the console when it has an existing connection and no active run.
- No API, schema, storage, or dependency changes.
