## Why

Owner-cancelled connector runs are intentional operator actions. The runtime records them as terminal audit events, but source health currently maps `cancelled` to `failed`, which can make an intentionally stopped run look like a connector code defect.

## What Changes

- Treat owner-cancelled terminal runs as neutral for source-health failure classification.
- Keep cancellation visible in run history and timelines.
- Preserve real connector failures, terminal coverage gaps, and retryable detail gaps as health evidence.

## Capabilities

### Modified Capabilities

- `reference-connection-health`: cancelled run terminals no longer satisfy connector-failure conditions or maintainer-code-fix verdicts solely because they were cancelled by the owner.

## Impact

- Affected code: source-health projection, connector-summary tests.
- No protocol change.
- No change to runtime cancellation or run timeline storage.
