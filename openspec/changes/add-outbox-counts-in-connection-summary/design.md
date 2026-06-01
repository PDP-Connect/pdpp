# Design

## Context

`reference-connection-health` keeps source coverage, local-device backlog, dead letters, and attention as decomplected condition families. For a local-device connection the reference already:

- accepts `outbox_diagnostics` on each device heartbeat and normalizes it via `normalizeOutboxDiagnostics` (rejects negatives / non-finite; keeps only `backlog_open`, `dead_letter`, `leased`, `pending`, `retrying`, `stale_leases`, `succeeded`, `total`, and a validated `oldest_pending_at`);
- persists it as `device_source_instances.outbox_diagnostics_json`;
- maps it back as `outboxDiagnostics` in `listSourceInstanceHeartbeatsByConnector`;
- exposes it per-source as `DeviceSourceInstance.outbox_diagnostics` and renders the full counts in `formatSourceOutboxState`;
- already has a typed `OutboxDiagnosticCounts` interface and `deriveOutboxStateFromDiagnostics` in `connection-health.ts`.

The single gap is the **connection-summary rollup**. `HeartbeatRow` in `ref-control.ts` does not carry `outboxDiagnostics`, so `projectLocalDeviceProgress` cannot see it; `LocalDeviceProgress` therefore exposes only a single rolled `records_pending`. The console comment in `summarizeOutboxForRow` documents this as deferred.

## Decision

Promote the counts into the existing local-device projection object — not a new top-level field, not new protocol semantics:

1. **Pure rollup helper** (`connection-health.ts`): `rollupOutboxDiagnosticCounts(items: readonly (OutboxDiagnosticCounts | null | undefined)[]): OutboxDiagnosticCounts | null`. Sums the numeric count fields across trusted source rows; takes the earliest `oldest_pending_at`; returns `null` when no row carries any count. Pure, no I/O, unit-tested directly.
2. **Thread evidence** (`ref-control.ts`): add `outboxDiagnostics: OutboxDiagnosticCounts | null` to `HeartbeatRow` (the store already returns it). `projectLocalDeviceProgress` rolls up the trusted rows' diagnostics into a new `outbox_counts` field on `LocalDeviceProgress`. `null` when no trusted row reports counts — preserving the existing "only trusted rows count" rule and never surfacing revoked-device data.
3. **Console copy** (`connection-evidence.ts`): `summarizeOutboxStallRemediation` gains an optional count-backed scale line built from `local_device_progress.outbox_counts`, surfaced only on the existing stalled-remediation panel. Healthy / idle / active / unknown rows keep returning `null` — no new badges, no count chips on quiet rows.

## Voice

Operator-console voice. The scale line states what is stuck on the local collector ("12 records pending, 2 dead-letter") as a factual count, not a hosted-service promise. It reinforces that the host holds the data and the dashboard cannot drain it remotely.

## Alternatives Considered

- **New top-level `ConnectorSummary.outbox_counts`.** Rejected: the counts are local-device push-mode evidence and already have a natural home in `local_device_progress`, which is `null` for scheduler-managed rows. A second top-level field would duplicate the scoping rule and invite use on non-local connections.
- **Expose counts on every row, including healthy ones.** Rejected: violates the "keep healthy/unknown quiet" constraint. The data is carried in the projection (owner-only), but the console only renders it where it improves a stalled-remediation decision.
- **Re-derive the outbox axis from counts in this slice.** Out of scope: `deriveOutboxAxisFromHeartbeat` already projects the axis from heartbeat status + pending depth. This slice only *surfaces scale*; it does not change axis derivation or the existing outbox axis taxonomy.

## Out Of Scope

- Changing the device heartbeat ingest contract or device-side telemetry.
- Re-deriving `axes.outbox` from the count breakdown.
- Numeric counts on the records-list row pill (the slice keeps counts on the detail remediation panel; list-row count chips are a later slice).
- Any live-device validation.

## Acceptance Checks

- `LocalDeviceProgress.outbox_counts` rolls up trusted source rows' `outbox_diagnostics`; `null` when no trusted row reports counts.
- Revoked / inactive source rows never contribute counts.
- The new field carries only non-negative integers and an optional ISO `oldest_pending_at` — no path, queue name, token, hostname, or payload.
- The console renders a count-backed scale line only on a stalled-outbox remediation; healthy / idle / active / unknown rows render no counts.
- `pnpm --dir reference-implementation run verify`, targeted reference and console tests, `pnpm --dir apps/console run types:check` and `run check`, and `openspec validate --all --strict` pass.
