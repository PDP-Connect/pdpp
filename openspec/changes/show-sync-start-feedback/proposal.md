## Why

Fast owner-triggered syncs can complete before the console refresh observes an
active run. In that case the owner can click `Sync now` and see no durable
feedback, even though the reference accepted and ran the request.

## What Changes

- Make source-detail sync controls render an explicit accepted-start result.
- Include a link to the started sync when the reference returns a run id.
- Stop using transient active-run observation as the only proof that a click
  worked.

## Capabilities

Modified:
- reference-connection-health

## Impact

- Owners get visible confirmation for short successful syncs.
- Failed starts still render local error feedback.
- The reference run contract is unchanged.
