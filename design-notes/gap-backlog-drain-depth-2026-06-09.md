# Gap Backlog Drain Depth

Status: captured
Owner: reference implementation owner
Created: 2026-06-09
Related: openspec/changes/surface-source-pressure-detail-gap-backlog (design.md §Deferred items 1–3), reference-implementation/server/stores/connector-detail-gap-store.js, reference-implementation/runtime/connection-health.ts, design-notes/bulk-import-bootstrap-2026-06-04.md

## Question

When the source-pressure `detail_gap_backlog.pending` count is a floor (pending backlog exceeds the probe bound), what additional per-gap or drain-curve evidence would materially help the owner manage a large backlog — and what mechanisms (per-gap ledger, bulk-import passthrough, automatic background catch-up) should the system eventually offer?

## Context

`surface-source-pressure-detail-gap-backlog` landed a connection-level rollup (`pending`, `pending_is_floor`, `pending_other`, `recovered`) on `GET /_ref/connectors` via `connection_health.detail_gap_backlog`. For the ChatGPT `messages` stream the live deployment shows:

- `pending: 100`, `pending_is_floor: true` — the bounded read returned 100 rows; SQL ground truth is 107 source-pressure pending gaps
- `pending_other: 0` — the 100 oldest pending gaps are all source-pressure (`upstream_pressure` + `rate_limited`), consistent with `ORDER BY created_at LIMIT 100`
- `recovered: 354` — exact count of source-pressure recovered gaps; matches SQL directly

The single rollup count delivers the core owner value (backlog exists, is draining, here is its size), but the design deferred three richer capabilities:

1. **Per-gap retry ledger / drain curve.** Per-gap backoff history: first-seen timestamp, last-attempt timestamp, attempt count, terminal-vs-retryable transition log, recovered-at timestamp. The current store records `attempt_count` and `last_attempt_at` per gap but does not surface them in the rollup. A drain curve (pending count over time, or rate of recovery per run) would let the owner estimate when a large backlog clears.

2. **Bulk-import / passthrough drain.** The current incremental path fetches one detail per gap per run, subject to throttling and source-pressure cooldown. A large backlog (hundreds to thousands of gaps) drains slowly under these constraints. An official export or passthrough path (connector provides a bulk read; the collector ingests it directly) could drain the backlog in a single operation. This is a new ingestion mechanism orthogonal to making the current incremental drain visible; see `design-notes/bulk-import-bootstrap-2026-06-04.md` for the earlier related design question.

3. **Automatic background catch-up for background-safe sources.** The source-pressure cooldown governor already supports automatic dispatch for `proven` + `automatic` + `background_safe` connectors. Which connector exercises it first (ChatGPT is `assisted`, not automatic) is a separate deployment decision. The governor-and-schedule machinery is the engine; no new protocol primitive is needed.

## Current Leaning

**Per-gap ledger:** Add `oldest_pending_at` (ISO-8601, earliest `created_at` among source-pressure pending gaps) to `detail_gap_backlog` as an optional field. This is the single most useful addition: the owner can estimate drain rate from "oldest gap is N days old" without a full per-gap audit. No drain-curve time series is warranted until the scalar proves insufficient. Requires a small store change (`MIN(created_at)` in the bounded pending read or a separate aggregate).

**Bulk-import:** Hold; see the existing bulk-import design note. Depends on connector-capability declaration and a new ingestion path, both larger than a backlog-visibility slice.

**Automatic catch-up:** Hold; depends on ChatGPT (or another connector) reaching `proven` + `automatic` + `background_safe` status. Not a backlog-surface change.

## Promotion Trigger

Promote `oldest_pending_at` into OpenSpec before the next `connection_health` contract extension. Promote bulk-import into OpenSpec when a connector ships an export capability (ChatGPT batch export is the most likely first candidate). Do not promote automatic catch-up independently — it follows from connector manifest status updates.

## Decision Log

- 2026-06-09: Captured as deferred items 1–3 from `surface-source-pressure-detail-gap-backlog`. Live verification confirmed the rollup matches SQL ground truth (107 source-pressure pending, 354 recovered for ChatGPT; route reports floor-annotated 100 + 354). No owner decision outstanding.
