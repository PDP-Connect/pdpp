## Context

Connection health is already a typed server projection. The stream-health audit
is intentionally narrower: it evaluates required-stream coverage evidence for
settled visible summaries. It does not consider owner actions, connector
repair, runtime availability, lifecycle scope, or an omitted configured
connection. A passing audit therefore cannot answer whether the owner fleet is
fully healthy.

## Goals / Non-Goals

**Goals:**

- Compose existing typed evidence into one server-owned owner read model.
- Reconcile configured inventory with assessable summaries before claiming
  whole-fleet health.
- Preserve identity for every affected connection and keep dimensions separate.
- Let dashboard aggregate copy consume the same result.

**Non-Goals:**

- Persisting a fleet state or introducing another connection-health state
  machine.
- Changing per-connection health precedence, schedule policy, connector
  collection, or stream-audit predicates.
- Inferring state from rendered UI copy, failed-run strings, or connector keys.

## Decisions

### Pure composition accepts explicit evidence

The composer is transport-neutral and pure. Its input contains configured
inventory, current summaries with rendered verdicts, runtime envelope, and a
typed stream-audit result. Its output contains state, `fully_healthy`, scope,
and dimensions. The route obtains evidence and serializes the result; it does
not own policy.

This separates I/O from classification and gives tests a small deterministic
oracle. A database-backed fleet projection was rejected because it would add
staleness, lifecycle, and migration concerns without new primary evidence.

### Inventory reconciliation gates a whole-fleet claim

The composer starts from configured inventory. Revoked connections are
intentional exclusions; draft and setup connections are visible setup-pending
scope. Any remaining configured connection absent from the assessable summary
set is returned as unassessed and prevents `fully_healthy`.

Using only visible summaries was rejected because summary filtering can hide a
configured binding and create a false all-clear. The reconciliation also checks
the inverse difference: a summary identity absent from the inventory snapshot
is unassessed evidence of an incoherent read, not a connection the fleet may
silently ignore.

### Typed dimensions retain independent causes

Runtime, stream coverage, attention, system repair, recovery trouble, work,
freshness advice, intentional policy, unknown evidence, and scope each remain
separate output dimensions. The fleet state is a conservative precedence over
those dimensions:

1. `unhealthy` for runtime failure, stream-audit failure, owner action,
   connector broken/degraded, retryable or terminal recovery trouble, or
   stalled work.
2. `indeterminate` when no unhealthy evidence exists but genuine unknown
   evidence, inconclusive coverage, or unassessed inventory remains. Active
   bounded work remains in the work dimension as progress context; it does not
   make an otherwise fresh, coverage-settled source uncertain.
3. `healthy_with_advisories` when only freshness advice remains.
4. `healthy` otherwise.

`fully_healthy` is true only for `healthy`. Manual or paused policy alone is
not a fault; stale manual or paused data is an advisory. This fits the current
connection-health separation between scheduler policy and data health.

### Stable connection identity is the aggregation key

Every dimension stores a safe connection reference keyed by
`connector_instance_id` / `connection_id`; no bucket aggregates by connector
type. This preserves distinct ChatGPT, Slack, and financial-source bindings.

### One owner-only read surface is the integration seam

The reference owner route exposes the composed value. The console consumes it
for aggregate copy only and continues to render per-connection detail from the
existing summary contract. Extending the stream audit was rejected because its
output and exclusion rules are deliberately coverage-specific.

## Risks / Trade-offs

- [The summary projection changes shape] → Keep classification at the typed
  snapshot/verdict boundary and add fixtures for each discriminating outcome.
- [Inventory and summary reads observe different moments] → Return
  `indeterminate` for a missing assessment rather than hide the disagreement.
- [Console copy drifts from server semantics] → Derive aggregate state and
  causes from the owner route, leaving layout local.

## Migration Plan

The new read surface is additive. Existing connection summaries and the stream
audit retain their contracts. Rollback removes the new route and console
consumer without durable cleanup because the change stores no fleet state.
