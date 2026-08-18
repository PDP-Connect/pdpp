# One generation row per connection, not a generic job queue

**Status:** intake. Terminal design proposed by an independent reviewer, not yet
owner-ratified. Deliberately NOT scoped into the corrective branch that prompted it.
**Date:** 2026-08-18

## Why this note exists

Five starvation bugs were found in the bounded maintenance sweep inside about
twenty-four hours. All five have the same shape: **work that cannot progress
consumes a shared budget, and work that can progress never runs.**

1. **Checkpoint floor.** The fold read from `min(checkpoint)` across participants.
   Three rows sat at checkpoint 0, so the floor was 0 against a 1.44M-event log.
   Every 2s pass restarted at 0, read zero qualifying events, and repeated.
2. **Zero-vs-null.** The first fix guarded `null`. The rows stored a literal `0`.
3. **Phase starvation.** "Missing" discovery consumed the whole budget before
   "generic" — the only path that classifies a row as dirty — could run.
4. **Post-deadline skip.** Discovery expired the deadline, so the repair loop
   skipped every candidate. 16 classified, 16 skipped, 0 repaired, on an idle
   database.
5. **Permanent exclusion.** The fix for #2 excluded `terminal_facts_historical`
   rows at checkpoint 0 from the fold. Its stated exit condition was unreachable:
   nothing marks such a row dirty, and the checkpoint advances only via the fold
   the row is excluded from. Three production rows stranded, one an active
   connection that could not recover.

Number 5 is the one that matters most for design purposes. It was introduced *by*
a starvation fix, written immediately after fixing the previous one, and it
converted a livelock into a permanent exclusion. That is not an attention failure.
It is what happens when fairness is an emergent consequence of phase order, cursor
position, and exception paths rather than an explicit durable invariant.

## The reviewer's verdict

> Replace the scheduling model; keep the shipped fix only as incident mitigation.

Confidence that the current model produces more bugs of this family: **0.96**.
Confidence that a small durable reconcile queue is the right terminal shape: **0.90**.

Crucially, the preferred design is **not** a generic durable job framework with
fold, missing-repair, generic-repair, and audit job types. That would preserve the
task-kind zoo that produced the bugs. It is:

> A level-triggered, generation-based projection controller keyed by connection.

## The design

One durable projection-state row per connection:

```
connector_instance_id
desired_generation
applied_generation
target_event_seq
folded_event_seq
applied_contract_version
dirty_since
next_attempt_at
last_attempt_at
attempt_count
last_outcome
```

Every canonical change that could affect a connection's summary increments
`desired_generation`, **preferably in the same transaction as the change**.
Multiple changes coalesce into the same row — the row *is* the durable
deduplicating queue entry. There is no separate queue table to keep in sync.

One bounded, idempotent operation reconciles a connection:

```
reconcile(connection_id):
  snapshot desired_generation
  fold at most N indexed events for this connection
  persist fold progress and yield if more remain
  read bounded canonical facts
  compute and write the complete desired summary
  set applied_generation to the generation that was reconciled
```

If the connection changes mid-reconciliation, `desired_generation` advances past
`applied_generation`, so it stays eligible automatically. A deferred or failing
connection gets `next_attempt_at`/backoff and cannot permanently hold first
position.

## What this deletes

These concepts stop existing, and with them the bugs they produced:

- "missing" versus "generic" discovery phases
- the shared minimum participant checkpoint
- the rotating page cursor
- process-local phase alternation
- the first-candidate deadline exemption

Missing, dirty, and code-version-stale collapse into two conditions:

```
applied_generation < desired_generation
applied_contract_version != CURRENT_VERSION
```

**Both of those conditions would have prevented a bug this codebase actually
shipped.** `applied_generation < desired_generation` is derived, not remembered,
so bug #5 is unrepresentable — a row cannot be stranded by a predicate that
forgot to let it back in. And `applied_contract_version != CURRENT_VERSION` is
exactly the check that was missing when production ran fold logic version 5 while
every committed branch was at 4: a clean build shipped a binary older than its own
data, the version guard failed closed, and 26 of 28 evidence rows went unreadable
with no signal beyond a fleet of grey pills.

## Bounds are still required

The controller shape does not remove the need for hard bounds:

- bounded indexed event pages
- PostgreSQL `statement_timeout` and `lock_timeout`
- bounded SQLite query shapes, or interruption where the driver allows it
- a soft pass admission deadline
- a maximum number of units per wake

The reviewer's P1-2 stands independently of the redesign: the current 2000ms
`maxDurationMs` is a cooperative admission hint, not a wall-clock or database
occupancy bound. Measured on production *after* removing an unrelated CPU
contention problem, a pass still reported `repair_duration_ms: 5322` with skipped
candidates. If a unit cannot be hard-cancelled, it does not belong inside a
claimed 2-second maintenance loop.

## The three invariants

The reviewer rejected the single-invariant framing ("a pass that finds candidates
must repair at least one") as insufficient — it conflates repair success with
scheduling and does not bound a pathological unit. Three independent, separately
testable invariants are required:

**A. Bounded yield.** No operation may run between durable yield points unless its
worst-case work is bounded or it has enforceable cancellation.

**B. Monotonic outcome.** Every attempted work item must durably advance a cursor,
complete, defer with a future eligibility time, back off, or terminate. An
identical no-op retry cannot repeat forever.

**C. Bounded fairness.** Every continuously eligible item and nonempty task class
must receive an attempt within a defined number of scheduler turns, **across
process restarts**.

Invariant C is the one the current implementation cannot satisfy: fairness lives
in module-local variables (`nextDirtyAfterId`, `nextFirstObservationPhase`) whose
convergence bound vanishes on restart.

## The audit becomes a backstop

The hot path should not recompute fleet-wide aggregates. Expensive facts such as
record counts should be maintained incrementally where practical and verified by a
slower paged audit. The periodic sweep stops being the primary repair engine and
becomes what it should have been: a detector of missed invalidations that marks
connections behind. Orphan detection belongs there too, not in the latency-
sensitive loop.

## Scope discipline

The reviewer was explicit that this redesign should **not** be added to the
corrective branch. That branch finishes a bounded list:

- advance fairness from the last *attempted* candidate, not the last fetched
  page member — **done** (`ab28764f2`)
- repair `terminal_facts_historical` re-entry and boundary stamping — **partially
  done** (`078b72e3a` prevents new stranding; already-stranded rows still need a
  one-time re-entry path, in progress)
- the four adversarial tests, plus below-page-limit, above-page-limit, and
  restart cases — **partially done**, restart case outstanding
- hard per-query/per-unit bounds, and an honest name for the pass deadline
- no-progress telemetry and alerting
- durable fairness, or fairness derived from durable per-item attempt state —
  **deliberately deferred to this note's design**, since it needs a schema change
  and a different discovery query shape

Durable fairness is the item that most clearly belongs here rather than there:
implementing it in the current model means adding per-item attempt columns and
reshaping the discovery query, which is most of the projection-state row anyway.
Doing it twice would be waste.

## Open questions

- Does `desired_generation` increment in the same transaction as every canonical
  change, or is a trigger acceptable? Same-transaction is stated as preferred;
  the cost is touching every writer.
- What is the migration path for the existing `connector_summary_evidence` rows,
  including the three currently stranded at checkpoint 0?
- Does the audit backstop need its own fairness guarantee, or is a slow full
  rotation sufficient given it is no longer the primary repair path?
- SQLite parity: `statement_timeout` has no direct equivalent. Is a bounded query
  shape provably sufficient, or is driver-level interruption required?

## Provenance

Independent design review of the bounded maintenance sweep, 2026-08-18, conducted
against `sweep-design-review-20260818.zip` (the four starvation bugs, the shipped
minimum-one fix, and the supporting patches). The reviewer retracted one
production measurement from that packet after it was shown to be confounded by an
uncapped embedding transformer competing with PostgreSQL — the code-level
counterexamples and the structural conclusion were unaffected.

Related: `connector-sidecar-packaging-2026-08-17.md` and
`upstream-disclosure-window-2026-08-17.md` share the shape of a component whose
correctness depends on a peer's version with nothing verifying the pair.
