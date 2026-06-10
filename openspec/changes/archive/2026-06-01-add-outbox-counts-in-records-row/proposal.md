## Why

`add-outbox-counts-in-connection-summary` promoted the device-reported outbox diagnostics into `LocalDeviceProgress.outbox_counts` and surfaced a count-backed scale on the connector **detail** remediation panel. It deliberately left the records-**list** row out of scope ("Numeric counts on the records-list row pill … list-row count chips are a later slice") to avoid noisy healthy-row badges.

Today the records-list row already tells a stalled local-device connection to "Check the collector host" and links that guidance to the detail/remediation panel — but it states the stall qualitatively, with no scale. An owner scanning the list cannot tell a one-record hiccup from a thousand-record dead-letter pileup without opening each connection. The precise counts are already carried, owner-only, on the connection summary.

This change surfaces a compact, count-backed cue on the records-list row's existing stalled-outbox guidance, gated so it appears only where it improves remediation and never on a quiet, healthy, idle, active, unknown, scheduler-managed, or no-count row.

## What Changes

- Extend the records-list row's stalled-outbox next-step guidance to carry an optional count-backed scale (`pending`, `retrying`, `stale leases`, `dead-letter`, `backlog`), built from the connection summary's `local_device_progress.outbox_counts`.
- Gate the cue to the single stalled-outbox guidance branch, reusing the same count-formatting rule as the detail panel: only positive stuck-work categories are shown, and the cue is suppressed entirely when no positive stuck-work count is present.
- Keep the cue inside the existing detail-linked guidance row so the owner is pointed at the detail/remediation panel for the host command — the row invents no new remote fix.
- Surface no count chips or numeric outbox badges on healthy, idle, active, unknown, scheduler-managed, or no-count rows.

## Capabilities

### New Capabilities

### Modified Capabilities

- `reference-connection-health`: Surface the count-backed outbox scale on the records-list row's stalled-outbox guidance, scoped to stuck work and linked to the detail remediation surface.

### Removed Capabilities

## Impact

- Affected UI: `apps/console/src/app/dashboard/lib/connection-evidence.ts` (`deriveConnectionNextStep` gains an optional `localDeviceProgress` input and a `scale` field on `NextStepGuidance`, reusing the existing `formatOutboxCountScale`), `apps/console/src/app/dashboard/records/connector-row.tsx` (threads `local_device_progress` into the helper; renders the cue inside the existing `NextStepGuidanceRow`), companion helper + structural tests.
- No change to the reference projection, device telemetry, heartbeat ingest contract, storage, or grant-scoped read APIs. The counts were already promoted into `LocalDeviceProgress.outbox_counts` by `add-outbox-counts-in-connection-summary`; this change only renders them on a second already-gated owner surface. Counts remain owner-only diagnostics.
