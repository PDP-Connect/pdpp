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
- Skip automatic scheduled runs when the current runtime deployment cannot
  satisfy connector prerequisites, recording a not-ready reason instead of
  starting a doomed run.
- Surface an `ineligibility_reason` on the schedule listing API so operators
  see that a persisted enabled row will not actually run under the
  connector's current manifest policy, without deleting operator intent.

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
- Affects scheduler automatic run execution and history for connectors with
  missing deployment prerequisites.
- Does not change connector manifests or manual `run now` behavior.
