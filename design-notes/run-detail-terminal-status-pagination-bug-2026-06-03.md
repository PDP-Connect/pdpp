# Run Detail Terminal-Status Pagination Bug

Status: found-and-fixing
Owner: design/ui-elevation-and-action-parity lane
Created: 2026-06-03
Related: add-console-run-cancel-control, add-run-timeline-terminal-status, reference-surface-topology

## Symptom (caught by live Playwright verification, not by unit tests)

After wiring the console "Cancel run" control (gated on `active = getTerminalRunStatus(events) == null`), live verification opened the **cancelled** run `run_1780457850397` and the **Cancel run button rendered anyway** — violating the spec scenario "Terminal run shows no cancel control." The status badge also did not show "cancelled."

## Root cause (pre-existing, not introduced by the cancel control)

The run detail page (`apps/console/src/app/dashboard/runs/[runId]/page.tsx`) determines terminal status from a **single page** of the timeline:

- `getRunTimeline(runId, { cursor })` returns `TimelineEnvelope { event_count, events, next_cursor, truncated, ... }` — **no run/terminal status field**.
- The page sets `events = envelope.events` (the first ≤500 events, oldest-first) and computes `getTerminalRunStatus(events)` by scanning that page.
- The `/_ref/runs/:runId/timeline` endpoint is **oldest-first, forward-cursor only** (no `order=desc`/tail).
- Terminal events (`run.completed|failed|cancelled|abandoned`) are emitted **last**, so for any run with >500 events the terminal event is on a later page. Page one is all non-terminal events → `getTerminalRunStatus` returns null → page treats the run as **active forever**.

Proven for this run: paging the timeline to the end (4 pages, ~3848 events of `run.detail_gap_recorded` from the ChatGPT 429/detail-gap loop) reaches `run.cancelled` on page 4. Page-one gating never sees it.

### Blast radius (this is bigger than the cancel control)

Every run with >500 events shows:
- wrong status badge (perpetually "active"/"started"),
- live-poller kept enabled forever (`<RunDetailPoller enabled={active} />`),
- (now) a wrongly-shown Cancel control.

The cancel control merely **inherited** a latent bug. Fixing the cancel gate alone (e.g. band-aiding the control) would leave the status badge and poller wrong. The objective-ideal fix cures all three at the source.

## Fix

The reference server already has the exact primitive: `queries/spine/get-run-terminal-event.sql` — a single indexed `ORDER BY event_seq DESC LIMIT 1` over the terminal event types, already "Used by ref-control's run-summary helper … without scanning the run's full event list."

Surface it in the timeline envelope:

1. **Reference timeline route** (`/_ref/runs/:runId/timeline`): add `terminal_status` (one of `completed|failed|cancelled|abandoned` or null) and the terminal event's reason where available, computed via the existing terminal-event query — independent of the paginated `events` window. Covered by OpenSpec change `add-run-timeline-terminal-status`.
2. **Console page**: consume `envelope.terminal_status` for `active`/badge/poller instead of `getTerminalRunStatus(events)`. Keep `getTerminalRunStatus(events)` only as a fallback for the in-page event scan (e.g. failure-row detail), but the **authoritative** active/terminal decision comes from the envelope field.
3. **Cancel control** then gates correctly on a terminal-accurate `active`.

## Decision Log

- 2026-06-03: Live Playwright verification of the new cancel control surfaced a pre-existing first-page-only terminal-status bug on long runs. Chose the root-cause fix (terminal status in the timeline envelope via the existing LIMIT-1 query) over a cancel-control-local band-aid, because it also fixes the wrong status badge and never-disabled poller for all long runs. Expands Phase 1 to touch the reference timeline route; tracked under its own OpenSpec change.
