## Why

Live dashboard metadata can contain owner-runnable advisory source actions, such as retrying an Amazon detail gap or refreshing Reddit, while the home Overview remains in a calm state because it only treats `channel: "attention"` as owner-relevant.

That creates a false all-clear at the top of the owner console. The source list also hides which degraded rows have owner-runnable actions until the row is selected.

## What Changes

- Add an owner-dashboard summary category for owner-runnable advisory actions.
- Keep advisory copy non-alarming while preventing calm/all-clear home copy when owner action is available.
- Surface owner-runnable advisory actions on source-list rows without turning list rows into mutation buttons.
- Replace stale dashboard summary tests with tests for the active Standing Overview path.
- Preserve the existing owner-safe projection copy; raw retained-size reasons remain out of primary UI copy.

## Capabilities

Modified:

- `reference-connection-health`

## Impact

- Affects owner-console dashboard summary and Sources list presentation.
- Adds tests for advisory owner actions and stale/failure copy invariants.
- Does not change connector verdict synthesis, connection health payloads, grants, MCP behavior, or retained-size projection storage.
