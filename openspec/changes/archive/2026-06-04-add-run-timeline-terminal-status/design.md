# Design — Run timeline terminal status

## Context

The reference run-timeline endpoint is paginated oldest-first. Terminal spine
events are emitted at the tail, so a long terminal run can look active when a
consumer reads only the first page. That produced an operator-console defect:
the run detail page could keep polling and offer cancellation for a run that had
already reached `run.cancelled`, `run.failed`, `run.completed`, or
`run.abandoned`.

The reference already has a host-side terminal-event lookup:
`queries/spine/get-run-terminal-event.sql`. The fix should expose that
window-independent result on the timeline envelope instead of requiring every
consumer to page to the tail.

## Decision

Add `terminal_status` to the reference run-timeline envelope. The value is the
run's terminal class when a terminal spine event exists and `null` otherwise.
The value is independent of the requested timeline page or limit.

The operator console uses `terminal_status == null` as the active-run predicate
for the status badge, the live poller, and active-run cancellation controls.

## Rationale

- The terminal state is run-level metadata, not a property of the current event
  window.
- The host can answer the question with one indexed tail lookup rather than a
  full event scan.
- The field is additive and reference-control scoped; it does not change MCP,
  `/v1`, grant-scoped, or protocol semantics.
- Consumers get a single, auditable liveness predicate instead of reimplementing
  fragile event-window inference.

## Alternatives Considered

1. **Require consumers to fetch every page.** Rejected: expensive and fragile for
   long runs, and it pushes a run-level concern into every consumer.
2. **Reverse-sort timeline pages.** Rejected: changes the timeline contract and
   makes sequential event reading worse.
3. **Teach only the console to call a private summary helper.** Rejected: fixes
   one page but leaves the timeline envelope itself misleading.

## Validation

- Timeline envelope tests cover terminal runs whose terminal event is outside
  the fetched event page.
- In-progress runs return `terminal_status: null`.
- Console tests cover terminal-status-driven rendering, polling, and cancel
  control gating.
