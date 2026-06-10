# Proposal: surface-source-pressure-detail-gap-backlog

## Why

A connector run can terminate `succeeded` while deferring required detail as
resumable detail gaps under source pressure (a private endpoint returning bare
429s, a rate limit, an upstream throttle). The connection is honestly not green —
the connection-health projection already reports `axes.coverage = retryable_gap`,
`forward_disposition = resumable`, and a `source_pressure` reason class — but the
owner cannot see *how much* work is outstanding, *how persistent* the pressure
is, or *how much has already recovered*. The dashboard can only say "catching up"
without a number.

The numbers already exist. The reference scheduler's cross-run cooldown probe
reads the durable `connector_detail_gaps` store, filters to the source-pressure
reasons (`upstream_pressure`, `rate_limited`), and summarizes a pending count, a
maximum recovery-attempt count, and an optional next-attempt floor
(`add-schedule-source-pressure-cooldown`). But that summary is consumed only by
the scheduler dispatch gate. It is never projected onto the connection-health
snapshot, so no owner surface — dashboard row, connection detail page, CLI, or
owner-control-plane API — can render it. Console copy already promises the owner
they can "see how much is left to catch up", and that promise is currently
unfulfillable for a scheduler-managed connection.

This is a retained-data / source-pressure fact, distinct from live run progress.
A run's per-stream collection facts and forward disposition are the subject of
`define-connector-progress-evidence-contract`; the cross-run scheduler deferral
is the subject of `add-schedule-source-pressure-cooldown`. Neither projects a
numeric backlog onto the connection-health snapshot, and the cooldown's
`cooling_off` state is reachable only by *automatic* connectors (a manual-refresh
connector never arms a cooldown). The missing piece is a small, additive,
nullable backlog-evidence rollup on the snapshot that is visible for **every**
connector, manual or automatic, derived from evidence the reference already
holds.

## What Changes

- Add a `reference-connection-health` requirement defining an additive, nullable
  **source-pressure detail-gap backlog** rollup on the connection-health
  snapshot: a pending count, an optional recovered count, a maximum
  recovery-attempt count, and an optional next-attempt floor — projected from the
  durable `connector_detail_gaps` evidence the scheduler cooldown probe already
  reads, reason-scoped to source pressure.
- Require the rollup to be **honest about absence**: `null` when the durable gap
  evidence cannot be read (the same fail-open stance the cooldown probe already
  takes) and a real `0` when the backlog is drained. The pending count SHALL be
  the load-bearing field and SHALL NOT be inferred from collected record counts;
  the recovered count is optional and `null` when not cheaply available.
- Require the rollup to be **decomplected from live run progress and from
  freshness**: it carries only retained source-pressure backlog facts, it does
  not change the headline state, the coverage axis, the freshness axis, or the
  forward disposition, and it is available for manual-refresh connectors that
  never reach the scheduler's `cooling_off` state.
- Require the rollup to be **connector-agnostic and non-secret**: it carries only
  non-negative integer counts and an optional ISO-8601 timestamp, never a stream
  body, locator, record payload, source name, or per-connector branch. It is an
  owner-only diagnostic and SHALL NOT be exposed to grant-scoped clients.
- Add a `reference-connection-health` requirement that the owner console renders
  the backlog rollup as a catch-up cue **only where it aids the owner** — on a
  connection whose projection already shows a source-pressure / retryable-gap
  state — keyed on the existing `source_pressure` reason class, never on a
  connector name. Drained, healthy, idle, and unmeasured (`null`) connections
  SHALL NOT render a backlog count.

## Capabilities

Modified:
- `reference-connection-health`

Added:
- None

Removed:
- None

## Impact

- Reference implementation and operator/owner surfaces only. Does not change the
  public record/query/search/schema/blob `/v1` API.
- Reads the existing durable `connector_detail_gaps` store through the existing
  source-pressure probe; no new table, column, or migration. The pending /
  max-attempt / next-attempt figures are already computed by the scheduler
  cooldown; an optional recovered count is a single bounded reason-scoped
  count-by-status aggregate.
- Does not change Collection Profile JSONL messages, connector manifests, run
  terminal statuses, the scheduler dispatch policy, or the per-run collection
  report. It composes with `add-schedule-source-pressure-cooldown` (the cooldown
  governs *dispatch*; this change makes the same backlog *visible*) and with
  `define-connector-progress-evidence-contract` (that contract governs *per-run*
  per-stream facts; this rollup is the *cross-run* retained backlog).
- The contract is additive and nullable, so existing connectors are not forced
  into false precision: a connector with no source-pressure gaps reports a `null`
  or drained-`0` rollup and renders no catch-up cue.
