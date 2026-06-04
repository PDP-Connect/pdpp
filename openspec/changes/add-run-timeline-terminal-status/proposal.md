## Why

The reference run timeline endpoint `GET /_ref/runs/{run_id}/timeline` returns a paginated, oldest-first window of spine events with no run-level terminal-status field (`TimelineEnvelope`: `object`, `event_count`, `data`, `truncated`, `next_cursor`, `trace_id`). Terminal events (`run.completed | run.failed | run.cancelled | run.abandoned`) are emitted last, so any consumer that infers "is this run still active?" from a single page sees only non-terminal events when the run is longer than the page and concludes the run is perpetually active.

This is a live, reproduced defect. The operator console run detail page derives `active = getTerminalRunStatus(events) == null` from the first page of events. For a real ChatGPT run with ~3,848 `run.detail_gap_recorded` events (a 429/detail-gap loop) whose terminal `run.cancelled` is on a later page, the page never sees the terminal event: the status badge stays "active", the live poller never disables, and a newly-added Cancel-run control wrongly renders on an already-terminal run. The timeline endpoint is oldest-first and forward-cursor only, so a consumer cannot cheaply read the tail.

The reference already has the exact primitive to fix this without scanning the full event list: `queries/spine/get-run-terminal-event.sql` (`ORDER BY event_seq DESC LIMIT 1` over the terminal event types), today used by ref-control's run-summary helper.

## What Changes

- Add a `terminal_status` field to the run-timeline envelope returned by `GET /_ref/runs/{run_id}/timeline`: one of `completed | failed | cancelled | abandoned` when the run has a terminal spine event, else `null`. It SHALL be computed from the spine's most-recent terminal event (the existing terminal-event query), independent of the paginated event window — its value SHALL NOT depend on `limit` or `cursor`.
- The terminal status SHALL be derived authoritatively from the terminal event type. (Existing `run.failed` reason→status nuances that the console derives, e.g. owner-cancelled vs. crash, remain a console concern; the envelope reports the raw terminal class.)
- Trace and grant timelines are unaffected (terminal_status applies to the run kind; for non-run kinds the field is omitted or null).
- The console run detail page SHALL consume `envelope.terminal_status` as the authoritative active/terminal signal for the status badge, the live poller `enabled` gate, and the Cancel-run control's render gate, rather than scanning a single page of events.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: the reference run-timeline envelope SHALL expose a window-independent `terminal_status` derived from the run's most-recent terminal spine event, so consumers can determine run liveness without paging to the tail.

## Impact

- Affected code: `reference-implementation/operations/ref-spine-events-page/index.ts` (envelope shape — add `terminal_status` for the run kind), `reference-implementation/server/routes/ref-spine-timelines.ts` and/or the host spine-read wiring that supplies the terminal lookup (using `queries/spine/get-run-terminal-event.sql`), the console `TimelineEnvelope` type and `getRunTimeline` normalization (`apps/console/src/app/dashboard/lib/ref-client.ts`), and the run detail page consumption (`apps/console/src/app/dashboard/runs/[runId]/page.tsx`).
- No public/grant-scoped surface change; `/mcp` and `/v1` semantics unchanged. Reference-control envelope only.
- One additional indexed `LIMIT 1` query per run-timeline request; no full-scan.
- Fixes the wrong status badge, the never-disabled live poller, and the wrongly-rendered Cancel control for all long runs — not only the cancel case.
