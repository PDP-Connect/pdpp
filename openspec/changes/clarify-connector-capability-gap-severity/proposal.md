## Why

Connector health currently treats any known gap on a successful run as degraded. That makes Slack appear yellow when it only reports expected streams that slackdump archive mode cannot collect, conflating configured capability limits with actionable data loss.

## What Changes

- Separate connector stream capability, owner/run selection, and run outcome in reference status semantics.
- Add manifest stream availability semantics for supported, unsupported-in-mode, experimental, and deprecated streams.
- Add known-gap reason/severity classes so informational limitations do not mark a connector degraded.
- Update connector health and dashboard partial-coverage hints to use gap severity instead of `known_gaps.length > 0`.
- Apply the model to Slack so expected slackdump-mode limitations are honest detail-view information, not a yellow connector state.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: Add connector capability, selection, gap severity, and status honesty requirements.

## Impact

- Affects connector manifests, manifest validation/reconciliation, connector runtime `SKIP_RESULT` handling, scheduler/run known-gap storage, connector-health projection, dashboard connector rows, and Slack connector status.
- Does not change the public record/query API.
