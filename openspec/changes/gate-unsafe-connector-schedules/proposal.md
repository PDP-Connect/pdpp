## Why

Manual/background-unsafe connectors can currently receive enabled schedules.
That lets owner-present browser connectors such as Amazon enter the unattended
scheduler path despite their manifest posture.

## What Changes

- Treat connector refresh-policy safety as a server-side schedule eligibility
  gate.
- Reject enabling schedules for manual, paused, or explicitly background-unsafe
  connectors.
- Skip legacy enabled schedules that no longer pass the eligibility gate.

## Capabilities

Modified:
- `reference-implementation-architecture`

Added:
- None

Removed:
- None

## Impact

- Affects `_ref/connectors/:connectorId/schedule` create/update/resume behavior.
- Affects scheduler-manager refresh selection for persisted schedule rows.
- Does not change connector manifests or manual `run now` behavior.
