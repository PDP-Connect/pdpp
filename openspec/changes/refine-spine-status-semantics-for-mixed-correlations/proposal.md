## Why

The spine event model conflates two semantically distinct uses of `status`:

- **Run lifecycle status**: `run.completed` / `run.failed` — exactly one terminal event per run.
- **Sub-resource lifecycle status**: events like `run.stream_session_resolved` carry their own `status: "completed"` because the *session* resolved, not the run.

Both kinds live on the same `spine_events` table, both have a `status` column, both can be `"completed"`. Today `summarizeEvents` (`reference-implementation/lib/spine.ts`) walks the events array from last to first and returns the most recent non-"unknown" `status`. For a run correlation that emits both `run.failed` and `run.stream_session_resolved` (status="completed"), the order events happen to be loaded in determines the displayed status — the dashboard can show "completed" for a run that actually failed.

We landed a targeted patch (prefer run-terminal event types when summarizing a run) to stop misleading the dashboard. That patch is a hardcoded list — adding a new run-terminal event type next year forgets to update the list, and the bug returns. The deeper fix is for the spec / event model to distinguish run-terminal events from sub-resource events explicitly so any consumer (dashboard, CLI, third-party reader) gets honest run status without guessing.

## What Changes

This proposal does NOT lock in a fix shape. It captures the design tension and the open question for spec-owner consideration.

Candidate directions (not pre-judged):

- **(a) Event-level terminal flag.** Each event type that is *the* terminal event for a correlation declares so (e.g. a `terminal: true` field on the event, or a normative table in the spec). Consumers filter by it.
- **(b) Separate spines.** Run-lifecycle events and sub-resource events live on separate event spines, joined by `run_id`. The dashboard reads the run-lifecycle spine for badges.
- **(c) Status namespacing.** Sub-resource events use a different status vocabulary (e.g. `session_completed` instead of bare `completed`) so consumers can disambiguate by status alone.

Each option has different implications for the `spine_events` schema, the API of `listSpineCorrelations`, and the protocol's commitments to third-party consumers reading the timeline.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture` — minor; the spine summary computation today reflects the open question.

## Impact

- `reference-implementation/lib/spine.ts` — the targeted patch lives here today (`summarizeEvents` filters by run-terminal event types when summarizing a run). Will likely change shape when the design lands.
- `reference-implementation/server/index.js` — `getLatestConnectorRunSummary` consumes the summary. No changes required by the targeted patch; consumer of the future fix.
- `apps/web/src/app/dashboard/runs/[runId]/page.tsx` — already filters correctly via `getTerminalRunStatus` (only looks at `run.completed` / `run.failed`). The bug was at the spine summary layer, not the dashboard.

## Out of scope (deferred)

- The streaming-companion-specific question of "should `run.stream_session_resolved` even exist on the run spine, or should streaming sessions be their own correlation?" That belongs in the streaming companion design notes (`openspec/changes/add-run-interaction-streaming-companion/design-notes/`) once the broader event-model question is resolved here.
- Any change to clients, grants, or other correlation kinds that may have analogous mixed-status problems. Audit deferred.

## Owner Self-Review

- This is a spec-shaped question, not a reference-implementation choice. The targeted patch in this tranche is reference-only and explicitly labeled as such.
- No spec assertions, no manifest fields, no normative changes.
