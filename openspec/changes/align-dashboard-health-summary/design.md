## Context

The connection health model already distinguishes raw facts, conditions, and projection states. The dashboard summary currently derives top-level counters from a subset of that projection. The result can be misleading: cards sorted as urgent because they are `degraded` do not affect `Needs attention`, and registered/no-data connections are displayed in a separate bucket while the headline label still says `Connections`.

## Goals / Non-Goals

**Goals:**

- Make the dashboard summary lossless enough that a degraded/stalled connection is visible at the top of the page.
- Keep one source of truth: the summary consumes the existing projection, not independent run-history guesses.
- Clarify whether the primary connection count means registered total or connections with durable progress.

**Non-Goals:**

- Do not change the underlying connection-health projection taxonomy.
- Do not treat unknown freshness as stale without a freshness policy.
- Do not redesign the connection card layout.

## Decisions

1. **Add or expose a degraded rollup instead of hiding degraded under "Needs attention 0".**

   The smallest honest fix is to count `degraded` and `cooling_off` in an attention-visible bucket. Implementation can either widen "Needs attention" to include these states or add a distinct "Degraded" stat. The acceptance criterion is semantic: the summary cannot claim no attention-relevant work while degraded/stalled cards are present.

2. **Keep unknown freshness distinct from stale.**

   A connection with unknown freshness and old ingest timestamps should not be counted as stale unless a freshness policy says it is stale. Copy should communicate "freshness unknown" rather than implying "not stale."

3. **Clarify connection counts.**

   If the primary list excludes no-data registrations, the label must say that. Alternatively, the summary can include registered total plus a with-data/no-data breakdown.

## Risks / Trade-offs

- **Risk: Summary becomes noisy.** Mitigation: keep the count tied to dominant projection state or explicit axes rather than every warning string.
- **Risk: Operators confuse degraded with blocked.** Mitigation: labels and tests should distinguish "blocked/needs owner action" from "degraded/retryable or stalled work."
- **Risk: Dashboard and CLI drift.** Mitigation: tests should verify the dashboard uses the projection payload fields rather than bespoke run-history inference.
