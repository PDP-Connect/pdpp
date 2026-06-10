# RI Operator Console Evidence Inventory

Date: 2026-05-19
Status: decided for current implementation tranche
Related change: `complete-ri-operator-console-reliability`

## Summary

This inventory separates durable evidence we can trust now from shape gaps that
must not be hidden behind a green dashboard state.

- Runs/spine events, scheduler history, scheduler last-run times, active-run
  rows, connector detail gaps, connector state, browser-surface leases, and
  record aggregates are durable reference evidence.
- `connection_health` initially projected several axes, but scheduler backoff,
  attention lifecycle, outbox/backlog, stream-level coverage, and projection
  reliability were not fully wired.
- Scheduler backoff is the highest-confidence immediate integration because the
  durable evidence already exists in `scheduler_run_history` and
  `scheduler_last_run_times`.
- Attention lifecycle still needs a durable store. The current pure
  `runtime/attention.ts` model is not restart-reconstructable by itself.
- Local device outbox evidence exists in the local collector package and is
  now projected into reference-server connection health through
  device-exporter heartbeat/outbox diagnostics.

## Evidence Sources

| Evidence | Current durable source | Projection status |
| --- | --- | --- |
| Run outcome and terminal gaps | Spine events via `lib/spine.ts` and terminal event lookup | Wired coarsely into run status, last success, and last-run known gaps |
| Scheduler config | `connector_schedules` via `SchedulerStore` | Wired into idle/paused and schedule metadata |
| Scheduler history/backoff | `scheduler_run_history` and `scheduler_last_run_times` via `SchedulerStore` | Now wired into `scheduler_backoff` and connection `cooling_off` / `blocked` |
| Active runs | `scheduler_active_runs` via `SchedulerStore` plus in-memory controller state | Wired into syncing/activity badge |
| Connector detail gaps | `connector_detail_gaps` in SQLite/Postgres and `connector-detail-gap-store.js` | Pending gaps now degrade connection health; stream/scope coverage detail remains pending |
| Local collector outbox | `packages/polyfill-connectors/src/local-device-outbox.ts` plus device-exporter diagnostics | Wired into the outbox axis; stale/expired work degrades or marks projection unreliable |
| Browser-surface leases | `browser-surface-lease-store.ts` and remote-surface lease helpers | Wired into the remote-surface axis/detail; capacity/surface failures degrade, routine waiting/leased/idle remain non-headline diagnostics |
| Attention lifecycle | Pure `runtime/attention.ts` helpers | Not durable yet; current schedule boolean loses lifecycle/action target |
| Projection freshness | Derived by `server/freshness.ts` | Wired as freshness axis; projection reliability sources still need explicit failure/stale evidence |
| Connector state | Connector state stores | Durable but potentially sensitive; must not be surfaced without redaction |

## Current Decisions

- Treat the current `_ref` `connection_health` shape as reference-only operator
  projection, not PDPP Core.
- Use existing scheduler history to project backoff rather than adding new
  schema.
- Keep `connector_instance_id` as the interim connection key where a true
  connection namespace has not landed.
- Do not surface connector state JSON in operator views without a redaction
  gate.

## Remaining Shape Gaps

- Durable attention store: missing persistence for attention id, dedupe key,
  lifecycle, action target, expiry, sensitivity, and auto-detection.
- Outbox/backlog integration is wired through device-exporter heartbeat and
  source-instance diagnostics; deeper local outbox push telemetry remains a
  separate local collector enhancement.
- Stream/scope coverage: pending durable detail gaps now prevent false green,
  but the dashboard still uses a coarse last-run coverage rollup and does not
  expose per-stream/scope coverage detail.
- Projection reliability: `unreliableSources` is still not populated from
  failed/stale read models.
- Secret redaction: scheduler raw-error fallback is now code-sanitized before
  `_ref` / scheduler-doctor exposure. Future sensitive evidence sources still
  need checks before they are added to operator projections.

## Next Tranches

1. Integrate scheduler backoff from durable history into schedule summaries and
   `connection_health`.
2. Add per-source secret-redaction checks before adding any sensitive attention
   or state evidence to `_ref` surfaces.
3. Roll durable detail gaps into connection/stream coverage.
4. Add durable attention storage and feed open attention into connection health.
5. Continue local collector durability hardening: drain-before-scan ordering,
   bounded child buffering, cancellation propagation, lease renewal, and
   host-native unit templates.
