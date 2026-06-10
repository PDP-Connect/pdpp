# Design: surface-source-pressure-detail-gap-backlog

## Context

The connection-health projection (`reference-implementation/runtime/connection-health.ts`,
governed by `reference-connection-health`) already classifies a
succeeded-with-pending-pressure connection honestly: `axes.coverage =
retryable_gap`, `forward_disposition = resumable`, `reason_code` mapping to a
`source_pressure` class, and `next_action = null` (nothing owed by the owner). It
keeps source coverage, local-device backlog, dead letters, retryable detail gaps,
and owner attention as separate condition families ("Coverage, Work, And
Attention SHALL Remain Decomplected").

What it does not carry is *scale*. The categorical axes say "there is a retryable
gap"; they never say "1,054 messages pending, 393 recovered, pressure has not yet
forced a retry." The console copy already instructs the owner to "see how much is
left to catch up," but for a scheduler-managed (non-local-device) connection no
surface can answer that — only `local_device` connections expose an outbox count
rollup today (the `outbox_counts` requirements in the same spec).

The numbers already exist in the runtime. The scheduler's cross-run cooldown
(`add-schedule-source-pressure-cooldown`) injects a `getSourcePressureGaps` probe
(`reference-implementation/server/index.js`) that:

- reads pending rows from the durable `connector_detail_gaps` store
  (`listPendingGapsForConnector`, bounded `limit`),
- keeps only `SOURCE_PRESSURE_GAP_REASONS` (`upstream_pressure`, `rate_limited`),
- scopes to the connection's `connector_instance_id`,
- returns `{ reason, attemptCount, nextAttemptAfter }` per gap — never a record
  body, locator, or secret,
- fails open (a read failure becomes an empty list / no pressure).

`computeSourcePressureCooldown` already folds those rows into
`pendingPressureGapCount`, `maxAttemptCount`, and `nextRunAt`. The
`connector_detail_gaps` schema carries four statuses (`pending`, `in_progress`,
`recovered`, `terminal`), so a `recovered` count is a single bounded
reason-scoped aggregate, but no count-by-status query exists today.

The whole problem is therefore a *projection* gap, not a storage, protocol, or
ledger gap. This change names the additive, nullable contract for surfacing that
existing evidence on the connection-health snapshot and rendering it where it
helps.

## Goals

- Make the source-pressure catch-up backlog **visible and numeric** for every
  connector — manual or automatic — without inventing a new ledger or wire
  protocol.
- Keep the rollup **strictly additive and nullable** so existing connectors are
  not forced into false precision.
- Keep retained-data / source-pressure backlog **decomplected** from live run
  progress, coverage, freshness, and forward disposition.
- Keep all owner-facing framing **connector-agnostic** (keyed on the
  `source_pressure` reason class, never a connector name) and **non-secret**.

## Non-goals

- Not a per-gap retry ledger, drain curve, first-seen/last-attempt history, or
  terminal-vs-retryable transition log. (Deferred — see "Deferred" below.)
- Not a change to the scheduler dispatch policy. The cooldown decides *when* an
  automatic run fires; this change only makes the backlog it reasons about
  *visible*.
- Not a change to the per-run Collection Report. That contract
  (`define-connector-progress-evidence-contract`) is per-run, per-stream, and
  qualitative; this rollup is cross-run and quantitative.
- Not a bulk-import / passthrough drain path. (Deferred.)
- Not a promotion of `DETAIL_GAP` / `DETAIL_COVERAGE` to a portable wire message;
  the reference-only constraint on detail-gap state is preserved.

## Decisions

### D1. Where the rollup lives: the connection-health snapshot

The rollup is added to `ConnectionHealthSnapshot` (the projection all owner
surfaces share, per "Owner Surfaces SHALL Share One Projection Contract"), as a
nullable object alongside the existing `axes`, `forward_disposition`, and
`next_attempt_at`. This reuses the one projection contract dashboard, CLI, and
the owner-control-plane API already consume, so no surface re-reads the gap store.

Rejected alternative: a separate `/_ref` backlog endpoint. That would split the
health contract across two reads and let a surface render a count without the
matching health state, exactly the drift the shared-projection requirement
forbids.

### D2. Shape: counts only, nullable, honest about absence

```
detail_gap_backlog: {
  pending: number,              // pending source-pressure gaps (load-bearing)
  pending_is_floor: boolean,    // true when pending hit the bounded read
  pending_other: number,        // pending non-source-pressure gaps, diagnostic
  pending_other_is_floor: boolean,
  recovered: number | null,     // optional; null when not cheaply available
  max_attempt_count: number,    // recovery-attempt persistence
  next_attempt_at: string | null // cooldown / Retry-After floor, ISO-8601
} | null
```

- The whole object is `null` when the durable gap evidence cannot be read — the
  same fail-open stance the cooldown probe already takes. A real `0` (drained)
  is distinct from `null` (unmeasured); the contract makes this distinction
  normative so a UI never renders a fabricated zero.
- `pending` is the load-bearing field and is exactly the cooldown's
  `pendingPressureGapCount`. It SHALL NOT be inferred from collected record
  counts or list/detail deltas — only the durable rows count.
- `pending_other` is not part of the source-pressure backlog and does not affect
  cooldown. It counts pending detail gaps outside the source-pressure reason set
  so a bounded source-pressure-drained projection cannot imply "caught up" while
  run-cap, retry-budget, or other non-pressure pending gaps remain.
- `pending_is_floor` and `pending_other_is_floor` mark bounded-read floors. A
  floor may be rendered as "at least N"; it SHALL NOT be presented as an exact
  count.
- `recovered` is **optional** because no count-by-status query exists today; it
  is `null` when not cheaply available, and a value when a bounded reason-scoped
  aggregate is run. Making it a `MAY` keeps the first implementation tranche to
  the already-computed figures.
- `max_attempt_count` and `next_attempt_at` are exactly the cooldown's
  `maxAttemptCount` and `nextRunAt`. `next_attempt_at` here is the *backlog's*
  retry floor (Retry-After / cooldown), which for a manual connector can be set
  even though the connection-level `next_attempt_at` (the scheduler's next
  automatic dispatch) is `null`.

Rejected alternative: reuse the local-device `outbox_counts` shape. That rollup
is device-heartbeat-sourced and is explicitly scoped to local-device connections
("SHALL NOT appear on scheduler-managed connection summaries"). Source-pressure
backlog is the scheduler-managed analogue and needs its own field so the two
populations never bleed.

### D3. Reason scope: source pressure remains load-bearing

The rollup counts only gaps whose reason is account/source pressure
(`upstream_pressure`, `rate_limited`) — the same reason set the cooldown gates
on. A connector with only non-pressure gaps, or no gaps, reports a `null` or
drained-`0` rollup. This keeps the field from becoming a generic "any gap"
counter that would conflate, e.g., a one-off `temporary_unavailable` detail miss
with sustained source throttling.

The one exception is the diagnostic `pending_other` count. It is present only to
keep owner copy honest about remaining non-source-pressure pending detail gaps;
it SHALL NOT contribute to `pending`, `max_attempt_count`, cooldown, headline
state, or source-pressure catch-up semantics.

### D4. Decomplected from headline, coverage, freshness, and disposition

The rollup is pure additive evidence. It does not change the headline
`ConnectionHealthState`, the `coverage` axis, the `freshness` axis, the
`forward_disposition`, or `next_action`. A connection with a non-null backlog and
otherwise-green axes is still whatever its existing projection says it is; the
rollup only annotates *scale*. This preserves the decomplection requirement and
keeps live run progress (a run's terminal facts) cleanly separate from
retained-data / source-pressure state (the cross-run backlog).

### D5. Console rendering: catch-up cue only where it aids the owner

Mirroring the existing "surface stalled-outbox scale only where it improves
remediation" requirement, the console renders the backlog as a compact catch-up
cue (e.g. "Catching up: N pending" and, when present, "K recovered") only on a
connection whose projection already shows a source-pressure / retryable-gap
state, keyed on the `source_pressure` reason class — never on a connector name.
Drained (`0`), healthy, idle, and unmeasured (`null`) connections render no
source-pressure catch-up cue. If `pending` is `0` but `pending_other` is positive
on a projection path that is already discussing detail-gap backlog scale, the
console SHALL NOT say "caught up"; it SHALL render that other detail items remain
pending. This fulfills the existing "see how much is left to catch up" promise
without hiding resumable non-pressure gaps. Tests already assert the raw
`source_pressure` token never leaks into a tooltip; the cue preserves that.

### D6. Owner-only, grant-isolated, non-secret

The rollup is an owner-only diagnostic, consistent with "owner-only diagnostics
such as credential rejection details SHALL NOT be exposed" and the local-device
count rollup's grant isolation. It carries only non-negative integer counts and
an optional ISO-8601 timestamp — no stream body, locator, record payload,
source/host name, base URL, or token.

## Risks and tradeoffs

- **Bounded probe vs. true count.** `listPendingGapsForConnector` is bounded by a
  `limit` (200 in the cooldown probe). For a connection whose pending backlog
  exceeds the bound, `pending` would be a floor, not an exact total. The
  implementation SHALL either count with a dedicated bounded aggregate or
  document the bound; the contract requires the count be honest (a floor is
  acceptable if labeled, a silently-truncated exact claim is not). This is called
  out as an acceptance check and a residual decision.
- **Recovered count cost.** A `recovered` aggregate is an extra read. Keeping it
  optional (`null` when not run) means the first tranche can ship pending-only
  and add recovered later without a contract change.
- **Manual-connector next_attempt_at semantics.** The backlog's `next_attempt_at`
  (a Retry-After / cooldown floor on the gaps) differs from the connection-level
  `next_attempt_at` (the scheduler's next automatic dispatch). The spec names the
  backlog field on its own object so the two are not conflated; for a manual
  connector the backlog floor MAY be set while the connection-level field stays
  `null`.

## Deferred (out of scope for this change)

Captured for a future design note, explicitly not required here:

1. **Per-gap retry ledger / drain curve.** Per-gap backoff history, first-seen
   vs. last-attempt, terminal-vs-retryable transitions, recovered-at timestamps —
   a richer surface than a single count. The single count delivers most of the
   owner value; promote only if it proves insufficient.
2. **Bulk-import / passthrough drain.** Draining a large backlog via an official
   export instead of N throttled detail runs. A new ingestion mechanism,
   orthogonal to making the current incremental drain visible.
3. **Automatic background catch-up for background-safe sources.** The cooldown
   governor is the engine; which `proven` + `automatic` + `background_safe`
   connector exercises it first is a separate decision.

## Acceptance checks

- The connection-health snapshot carries an additive, nullable
  source-pressure detail-gap backlog rollup distinct from the local-device
  `outbox_counts` rollup.
- The rollup is `null` when the durable gap evidence cannot be read and a real
  `0` when drained; the two are distinguishable.
- `pending` is reason-scoped to source pressure and is never inferred from
  collected record counts.
- `recovered` is optional and `null` when not cheaply available.
- The rollup does not change the headline state, coverage axis, freshness axis,
  forward disposition, or `next_action`.
- The rollup is available for a manual-refresh connector that never reaches the
  scheduler `cooling_off` state.
- The rollup leaks no stream body, locator, record payload, source name, base
  URL, or token, and is not exposed to grant-scoped clients.
- The owner console renders a catch-up cue only on a source-pressure /
  retryable-gap connection, keyed on the `source_pressure` reason class with no
  connector name, and renders no cue on drained/healthy/idle/`null` connections.
- The pending count is honest about the probe bound (an exact total or a labeled
  floor, never a silently truncated exact claim).
- A drained source-pressure backlog does not render as "caught up" when the same
  bounded evidence shows pending non-source-pressure detail gaps.

## Live Verification (2026-06-09)

Route: `GET /_ref/connectors` (owner-session, localhost:7662), ChatGPT connection (`cin_11deac1e728b244aaeb56765`, connector `chatgpt`)

`connection_health.detail_gap_backlog`:

```json
{
  "pending": 100,
  "pending_is_floor": true,
  "pending_other": 0,
  "pending_other_is_floor": false,
  "max_attempt_count": 8,
  "next_attempt_at": null,
  "recovered": 354
}
```

SQL ground truth (`connector_detail_gaps`, Postgres `pdpp`):

| Reason | Status | SQL count | Route interpretation | Match |
|--------|--------|-----------|----------------------|-------|
| `upstream_pressure` | `pending` | 106 | included in `pending` floor | consistent |
| `rate_limited` | `pending` | 1 | included in `pending` floor | consistent |
| **source-pressure total** | **pending** | **107** | `pending: 100`, `pending_is_floor: true` | floor correct |
| `retry_exhausted` | `pending` | 1501 | `pending_other: 0` (not in first 100 by `created_at`) | consistent |
| `upstream_pressure` | `recovered` | 351 | included in `recovered: 354` | consistent |
| `rate_limited` | `recovered` | 3 | included in `recovered: 354` | consistent |
| **source-pressure total** | **recovered** | **354** | `recovered: 354` | exact match |

**Floor explained:** `listPendingGapsForConnector` reads `status='pending' ORDER BY created_at LIMIT 100`. The 100 oldest pending gaps are all source-pressure gaps (created 2026-06-03 early), yielding `pending=100, pending_other=0`. The actual source-pressure pending total is 107, so `pending_is_floor: true` is correct. The 1,501 `retry_exhausted` pending gaps (created later) fall outside the bounded read; `pending_other_is_floor: false` because no `pending_other` rows were found in this page.

`recovered: 354` is an exact count-by-status aggregate (`countGapsByStatusForConnector`) scoped to source-pressure reasons; it matches SQL exactly.

Verdict: **verified** — rollup matches live store counts within the documented bounded-read semantics.
