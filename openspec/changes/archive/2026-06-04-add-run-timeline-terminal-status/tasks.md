# Tasks — Run Timeline Terminal Status

## 1. Envelope shape

- [x] 1.1 Add `terminal_status` to the run-timeline envelope type in `reference-implementation/operations/ref-spine-events-page/index.ts` (the operation that owns `object`/`event_count`/`truncated`/`next_cursor`). Type: `"completed" | "failed" | "cancelled" | "abandoned" | null`. For non-run kinds (trace, grant) the field SHALL be omitted or null.
- [x] 1.2 The operation SHALL receive the terminal status as an input (it has no DB access by design — it owns envelope shape only). Thread a `terminal_status` input alongside the existing `page` input.

## 2. Terminal-status read (host wiring)

- [x] 2.1 In the run-timeline route/host wiring (`reference-implementation/server/routes/ref-spine-timelines.ts` + the `listSpineEventsPage`/spine-read context it is given in `server/index.js`), perform a terminal-event lookup for the run kind using the existing `queries/spine/get-run-terminal-event.sql` (`ORDER BY event_seq DESC LIMIT 1`). Map the returned `event_type` to the terminal status class (`run.completed`→`completed`, etc.); null when no terminal event exists.
- [x] 2.2 The lookup SHALL run only for the run kind (skip for trace/grant). It SHALL be independent of `limit`/`cursor`.
- [x] 2.3 Pass the resolved terminal status into `executeRefSpineEventsPage` so it lands in the envelope.

## 3. Console consumption

- [x] 3.1 Add `terminal_status` to the console `TimelineEnvelope` type and `normalizeTimeline` in `apps/console/src/app/dashboard/lib/ref-client.ts`.
- [x] 3.2 In `apps/console/src/app/dashboard/runs/[runId]/page.tsx`, derive the authoritative terminal/active decision from `envelope.terminal_status`: `active = envelope.terminal_status == null`. Use it for the status badge, the `<RunDetailPoller enabled={active} />` gate, and the `{active ? <CancelRunControl/> : null}` gate.
- [x] 3.3 Keep the existing `getTerminalRunStatus(events)` only for in-page detail derivations that genuinely need the event object (e.g. failure rows, gap classification) — but it SHALL NOT be the source of the active/terminal decision. Where the envelope says terminal but the event is not on the current page, the page SHALL still reflect the terminal state (badge + no cancel control).

## 4. Tests

- [x] 4.1 Operation test: envelope includes `terminal_status` for the run kind from the threaded input; omitted/null for trace/grant.
- [x] 4.2 Route/host test: a run with a terminal event beyond the first page (seed >limit events with a terminal at the tail) yields `terminal_status` set on the FIRST page response (limit small), proving window-independence. A run with no terminal event yields null.
- [x] 4.3 Console test: page treats `terminal_status != null` as terminal even when `events` (the page window) contains no terminal event — badge shows terminal, Cancel control not rendered, poller disabled.

## 5. Validation

- [x] 5.1 `openspec validate add-run-timeline-terminal-status --strict`.
- [x] 5.2 Targeted `node --test` over the operation + route tests (reference-implementation) and the console page test.
- [x] 5.3 `git diff --check`.

## Acceptance checks

- The run-timeline envelope carries `terminal_status` derived from the most-recent terminal spine event via a single indexed query, independent of `limit`/`cursor` (1.x, 2.x, 4.2).
- For a long run whose terminal event is past the first page, the console shows the correct terminal badge, disables the poller, and does NOT render the Cancel control (3.x, 4.3).
- No `/mcp` or `/v1` change; trace/grant timelines unaffected (2.2, 4.1).
