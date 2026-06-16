## Why

The reference console Sources journey still leaves too much room for owners to
confuse configured connections, record reading, and AI-app read access. A row can
look like the place to read records, while "Connect" can read like connection setup.

## What Changes

- Clarify the route as the configured-connections surface: add, repair,
  reauthorize, sync, revoke, and inspect per-connection state.
- Point record reading to Explore and scoped sharing to Connect AI apps from the
  first screen.
- Keep Add connections as setup/catalog work, not grants or MCP client onboarding.

## Capabilities

Modified:

- `reference-surface-topology`

## Impact

- Affects operator console copy and connection-journey invariants.
- Does not change PDPP Core, Collection Profile, grant semantics, connector
  manifests, or server APIs.
