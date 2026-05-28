# Restart-reconciliation status: how should `controller_restarted` runs surface?

Date: 2026-04-27
Status: open question
Author: bug-hunt session

## Problem

When the reference AS shuts down with controller-managed runs in flight, the next process's `reconcileAbandonedControllerRuns` (`runtime/controller.ts:649-687`) synthesizes a terminal `run.failed` event for every orphaned row in `controller_active_runs`. The synthesized event sets:

```
event_type: 'run.failed'
status:     'failed'
data: {
  source:         buildRunSource(connector_id),
  reason:         'controller_restarted',
  failure_reason: 'controller_restarted',
  message:        'Reference server restarted while a controller-managed run was still active.'
}
```

It does **not** populate `data.known_gaps` or `data.known_gaps_summary`.

Concrete example from a 2026-04-28 02:43:30 UTC restart batch (the AS was killed during dev-server iteration):

| Connector | Records ingested before restart | Run duration | Terminal status today |
|---|---|---|---|
| amazon | 0 | 3.5 min (still enumerating years) | `failed` |
| codex | ~12 batches' worth | 19 min | `failed` |
| gmail | 1,500 (in 500-batch pages) | 19 min | `failed` |
| claude-code | 7 batches / 1,779 records | 19 min | `failed` |
| slack | 0 (slackdump cache warm-up) | 19 min | `failed` |

For amazon and slack (zero ingest before restart) `failed` is uncontroversial. For gmail / codex / claude-code (real records flushed before the restart), the same `failed` label hides the fact that the records are queryable and the run was interrupted, not unsuccessful.

## Adjacent ground truth

- The runtime's terminal vocabulary is binary: `succeeded` | `failed` (plus the in-flight `started` / `in_progress`). There is no `partial` status on the spine.
- Partial-completeness is expressed orthogonally as `known_gaps[]` on the terminal event. The spec at `openspec/specs/reference-implementation-architecture/spec.md:1470-1492` requires the runtime to expose machine-readable known gaps when a connector run "skips streams, records, or source regions that were in requested scope but not collected."
- The dashboard's `connectorHasPartialCoverageHint` (`apps/web/src/app/dashboard/lib/run-gaps.ts:45-56`) renders the orange `Partial` badge when `totalRecords > 0` AND `lastRun.known_gaps` has at least one entry that classifies as a `coverageGap` (i.e. not a `protocolViolationGap`). Because the restart-reconciliation event ships with no gaps, that gate never fires for `controller_restarted`.
- Reddit currently shows `Partial` because its connector emitted `kind: "manual_action_required"` in `known_gaps` (a Cloudflare-challenge interaction blockage), not because of any reconciliation logic.

## What "known gap" means today

Per the spec and per `apps/web/src/app/dashboard/lib/run-gaps.ts`:

```ts
interface KnownGap {
  kind: string;           // taxonomy slot ("manual_action_required", "credentials_missing", ...)
  reason: string;         // machine-friendly reason code (often == kind)
  stream?: string | null;
  scope?: Record<string, unknown>;   // structured "what we couldn't reach"
  message?: string;
  recovery_hint?: { action?: string; retryable?: boolean; ... };
}
```

The spec's framing ("skips streams, records, or source regions that *were in requested scope*") implies the runtime knows what it didn't reach. `controller_restarted` is asymmetric: at reconciliation time the AS has no in-flight scope tracking from the dead subprocess, so it cannot enumerate what was missed at the stream/scope level — only that the run did not run to completion.

## Options

### A. Synthesize a `controller_restarted` known_gap entry on reconciliation

`reconcileAbandonedControllerRuns` attaches:

```js
known_gaps: [{
  kind: 'controller_restarted',
  reason: 'controller_restarted',
  message: 'Reference server restarted while a controller-managed run was still active.',
  recovery_hint: { action: 'retry', retryable: true },
}]
known_gaps_summary: { count: 1, by_reason: { controller_restarted: 1 } }
```

The dashboard's existing partial-detection logic then picks this up. Result: gmail/codex/claude-code render `Partial`; amazon/slack stay `Failed` (gated by `totalRecords > 0`).

- **Pros:** smallest change. Re-uses existing UI affordance and existing taxonomy. No new status, no spec delta beyond a clarification that "known gap" can describe an unbounded gap (the runtime doesn't know what was missed).
- **Cons:** stretches the spec's current "in requested scope but not collected" framing. The synthesized gap has no `stream` and no `scope` — operators see "Partial" without being told *what's* partial. Conflates "we know what we didn't get" (manual_action_required) with "we don't know what we got."

### B. Add a third terminal status: `interrupted`

Spine event vocabulary becomes `succeeded | failed | interrupted`. Reconciliation emits `run.interrupted` (or keeps `run.failed` with `status: 'interrupted'`). Dashboard renders a distinct badge (e.g. yellow "Interrupted").

- **Pros:** semantically cleanest. Doesn't dilute `Partial`'s meaning. Distinguishes "the connector ran and reported what it got" from "we never got a clean exit signal."
- **Cons:** spec change, schema change (new status value), wider blast radius. Breaks any consumer that switches on `status in ['succeeded', 'failed']`.

### C. Dashboard-only inference, runtime unchanged

The dashboard learns to render `failure_reason === 'controller_restarted' && totalRecords > 0` as a distinct affordance ("Failed (interrupted, X records salvaged)"), independent of `known_gaps`.

- **Pros:** smallest blast radius. No spine event changes, no spec change.
- **Cons:** moves protocol-shaped reasoning into a UI layer. Other clients (CLI, future dashboards, third-party tooling) would each have to re-derive the same heuristic. Doesn't help anything that introspects the spine directly.

### D. Spec the gap class then implement

Add `kind: 'unknown_scope_loss'` (or similar) to the known-gap taxonomy with explicit semantics: "the runtime knows the run did not complete but cannot enumerate the missing scope." Then implement A using that kind.

- **Pros:** keeps spec honest. Distinguishes bounded ("manual_action_required at stream X") from unbounded ("we don't know") gaps in the data, not just by inference.
- **Cons:** more upfront work. Requires deciding whether the dashboard's `coverageGap` vs. `protocolViolationGap` classification needs a third bucket for unbounded gaps.

### E. Defer

Leave the behavior as-is. Restarts during active runs are expected to be rare in production deployments; the visible dev-loop oddness from `pkill` during iteration is not user-facing. Document the gap in the bug-hunt log and revisit if it surfaces against real operator workflows.

- **Pros:** no risk; preserves cycles for higher-leverage work.
- **Cons:** the dishonesty (gmail showing `Failed` when 1,500 records are queryable) remains. Anyone evaluating PDPP against the "Partial data SHALL NOT be represented as complete" requirement may notice the inverse — partial data being represented as failed.

## Cross-cutting questions

1. **Is `controller_restarted` a "known gap" by the spec's current definition?** The spec says "in requested scope but not collected." The runtime knows the run didn't complete but cannot point at what wasn't collected. Stretches the definition; not obviously violates it.
2. **Should `Partial` always be tied to `known_gaps`, or should it accept multiple inputs?** Today the dashboard couples them. Decoupling (e.g. "Partial = anything where data is queryable but the run did not complete cleanly") is simpler to render but loses the diagnostic detail `known_gaps` carries.
3. **Does the answer change for the agent-protocol audience?** A connector author needs to know whether their run finished cleanly. A standards reviewer needs to see honest partial-completeness modeling. An operator needs to know whether to re-run. The optimal label may differ across these audiences.
4. **What about future restart causes that are not `pkill`?** OOM kill, OS restart, pod eviction. Same reconciliation path, same question. A solution should generalize beyond dev-loop iteration.

## What today's reference does that should not change

- The reconciliation path itself is correct: it detects orphaned runs at startup and emits a terminal event so downstream consumers don't see a permanently `in_progress` row. This is what `harden-reference-runtime-reliability` baked in, and the spec's `Sustained dashboard workload does not crash the server` scenario depends on it.
- Records flushed before the restart remain queryable, with their `record_id`s and `stream` provenance intact. The data side is honest already; the question is purely about how the run's *terminal event* describes the situation.

## Examples to test any chosen option against

1. **gmail, 1,500 messages ingested, killed mid-stream.** What does the operator see at `/dashboard/records`?
2. **slack, 0 records ingested, killed during slackdump cache warm-up.** Same question.
3. **A future connector with refresh tokens that got revoked partway through a 5-stream run.** It emits `kind: 'credentials_missing', stream: 'transactions'` for the failed stream, then exits non-zero. The terminal event has both real `known_gaps` AND `failure_reason='connector_reported_failed'`. How does this stack with whatever `controller_restarted` becomes?
4. **A run that completes cleanly but with the connector's own `known_gaps` for one skipped stream.** Today: `succeeded` with `Partial` badge from coverage gap. Should `controller_restarted` use the same affordance, or look distinct?
