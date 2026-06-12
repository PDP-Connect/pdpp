# Audit/event logging for idempotent re-touched state: per-re-touch vs per-state-transition — prior art

**Date:** 2026-06-12
**Question:** For PDPP's spine audit log, when a work-queue item / gap / conversation is
re-processed across many runs but does **not change**, should the honest, minimal audit log
emit an event **per re-touch** or **per state-transition**? What is the consensus best practice
for not bloating an event log with no-op re-emissions while preserving auditability?

**Verdict up front:** Across every leading system surveyed, the consensus is **one event per
state-transition, not per re-touch.** A re-processing attempt that produces no semantic change
should emit **no new spine event**. The "how many times did we touch this" signal lives in
**mutable, queryable counter/current-state**, not in the append-only history. Auditability of the
*attempts* is preserved by (a) an attempt counter on the live record, (b) the terminal event
carrying a summary of what happened (incl. retry count), and (c) reconstructing "we tried N times"
from existing run-lifecycle events — never by appending one no-op event per attempt.

---

## 1. Temporal / durable-execution histories — the most directly on-point precedent

Temporal's Workflow Event History is an append-only log where **"every meaningful state transition
produces a new event."** The directly load-bearing rule for re-touch (verified against the official
docs, not a summary):

> "For an Activity Execution, the `ActivityTaskStarted` Event will **not** show up in the Workflow
> Execution Event History until the Activity Execution has completed or failed (having exhausted all
> retries). **This is to avoid filling the Event History with noise.** Use the Describe API to get a
> pending Activity Execution's attempt count."
> — https://docs.temporal.io/encyclopedia/retry-policies (§ Event History)

This is the canonical answer to the exact PDPP question:

- **Retries (re-touches) are deliberately withheld from the durable log.** N failed attempts that
  haven't yet produced a terminal outcome contribute **zero** history events.
- **The attempt count is NOT in the log** — it is mutable, queryable live state read via the
  `Describe` API (`Info.Attempt`). The history only gains an event when the activity *transitions*
  to completed or to failed-after-exhaustion.
- **Determinism is the deeper reason:** "the Workflow's command sequence stays deterministic across
  replays regardless of how many times an activity was internally retried." Per-retry events would
  make the history unbounded and non-reproducible.

The principle generalizes beyond activities: history records *transitions* (Started, Completed,
Failed, Cancelled, Timed Out), and the engine actively suppresses intermediate retry noise.

Sources:
- https://docs.temporal.io/encyclopedia/retry-policies
- https://docs.temporal.io/encyclopedia/event-history
- https://docs.temporal.io/blog/idempotency-and-durable-execution
- https://docs.temporal.io/workflows

## 2. Event sourcing / DDD aggregates — "an event is a thing that *happened*"

The foundational command/event split says the no-op must be suppressed **at the write model**,
before anything is appended:

- A command expresses *intent to change*. The aggregate validates the command "**against its current
  state**"; if the command "would not change the state (e.g., setting a value to what it already is),
  the handler can simply return without emitting an event, treating it as a successful no-op."
- Greg Young (CQRS): "events are a recording of **the action that occurred**." If no action occurred
  (no transition), there is nothing to record. Events are named in the **past tense** precisely
  because they assert that a state change already happened.
- This is *idempotent command handling*: re-issuing the same command yields the same state and emits
  no second event. It is distinct from *idempotent event consumption* (dedup on the read side via
  tracked `event_id`s for at-least-once delivery) — both matter, but only the first is about not
  bloating the log.

Critical nuance — **what counts as a no-op is a domain decision**:
> "In some domains, a command that produces no state change may still carry audit or compliance
> significance (the intent was recorded), in which case some teams choose to log it as a separate
> 'attempted/rejected' event rather than fully suppressing it. The right choice depends on whether
> your event log's primary purpose is state reconstruction or also a complete behavioral audit trail."

So the escape hatch when re-touch *is* audit-significant is a **distinct, lower-frequency event type**
(`*.attempted` / `*.rejected`), not silently re-emitting the same `*.changed` event. The test is:
is this a new fact about *what the system attempted*, or a duplicate of an already-recorded state?

Sources:
- https://microservices.io/patterns/data/event-sourcing.html
- https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/event-sourcing.html
- https://codeopinion.com/idempotent-aggregates/
- https://blog.ttulka.com/events-vs-commands-in-ddd/
- https://learn.microsoft.com/en-us/dotnet/architecture/microservices/microservice-ddd-cqrs-patterns/domain-events-design-implementation

## 3. Stripe events — `*.updated` is a state-transition event, never a re-touch ping

Stripe's `Event` objects are immutable snapshots of **changes**. The event-object docs phrase every
`*.updated` type as a *transition*:

- `source.updated`: "Occurs whenever **a source's details are changed**."
- `customer.subscription.updated`: "Occurs whenever a subscription changes (e.g., switching from one
  plan to another, or changing the status …)."
- `invoice.updated`: "Occurs whenever an invoice changes (e.g., the invoice amount)."

The `data.previous_attributes` ("changes") sub-dictionary **only contains attributes whose values
were modified.** "If you update a charge, the original charge event remains unchanged." In practice
Stripe "generally won't emit an `updated` event (or will emit one with empty `previous_attributes`)
when nothing actually changed." An idempotent write that changes nothing does **not** produce a fresh
event flood.

Stripe also separates two concerns PDPP should keep separate:
- **The event = a recorded transition** (immutable, append-only, what the audit trail is for).
- **Delivery may repeat** (at-least-once) → consumers dedup on the stable `evt_…` id. This is a
  *transport* duplicate, not a *new* event. (PDPP analog: spine rows are the source of truth; any
  retry of a spine-read API must not mint new spine rows.)

Sources:
- https://docs.stripe.com/api/events/object
- https://docs.stripe.com/webhooks
- https://docs.stripe.com/api/idempotent_requests

## 4. Kafka log compaction — the "collapse re-touches to latest-per-key" mechanism

Kafka makes the design tension explicit by offering **two cleanup policies** and pointing each at a
different use case:

- `cleanup.policy=delete` (time/size retention) → **event logs, audit trails, time-series.** Keep
  every event; an audit trail *needs* the full sequence of transitions.
- `cleanup.policy=compact` → **state stores, changelogs, current-state.** "Records with the same
  primary key are selectively removed when there is a more recent update … the log is guaranteed to
  have at least the last state for each key." Compaction "transforms a topic from an append-only
  event log into … a table of current state."

The explicit guidance: **compaction is NOT suited for audit/history** because it discards
intermediate values; **audit trails use delete/infinite retention, not compaction.**

The lesson for PDPP: the re-touch / current-status signal ("this gap is still pending; attempt
count = N; last touched at T") is a **compacted, latest-per-key projection** (a `connector_state` /
gap-status table) — *not* an append to the audit spine. Mixing the two (appending a no-op spine event
on every re-touch) is exactly the anti-pattern Kafka separates by policy. Tombstones (null-payload,
latest-per-key, retained briefly so consumers see the delete) are the compaction analog of "this key
reached a terminal/absent state" — again a transition, not a re-touch.

Sources:
- https://docs.confluent.io/kafka/design/log_compaction.html
- https://developer.confluent.io/courses/architecture/compaction/
- https://kafka.apache.org/documentation/ (§ Log Compaction)

## 5. AWS CloudTrail — even the "log everything" system separates read no-ops from writes

CloudTrail is the closest thing to a "log every touch" system, and even it draws the line:

- It splits events into **read-only** (`Get*`/`Describe*`, "do not change the state of a resource")
  vs **write** (`Put*`/`Delete*`/`Write*`, "add, change, or delete resources").
- It does **not** log everything by default: data events (the high-volume plane) are **off by
  default** "because data events are high-volume … millions of log entries per day."
- The standard bloat-control is "**log only write events**" — i.e. when the audit purpose is *state
  change*, you filter out the read/no-op plane. (Caveat: the `readOnly` flag is occasionally wrong,
  e.g. GuardDuty `GetRemainingFreeTrialDays` is marked `readOnly:false` — so classify by *intent and
  effect*, not by method-name heuristics. Directly relevant: PDPP should classify a spine emission by
  whether it records a transition, not by which code path reached `emitSpineEvent`.)

So even a security/forensic audit log — the use case with the *strongest* argument for "record every
touch" — defaults to **write-plane only** and treats read/no-op touches as filterable noise.

Sources:
- https://docs.aws.amazon.com/awscloudtrail/latest/userguide/logging-management-events-with-cloudtrail.html
- https://docs.aws.amazon.com/awscloudtrail/latest/userguide/logging-data-events-with-cloudtrail.html
- https://repost.aws/knowledge-center/cloudtrail-data-management-events

---

## 6. Synthesis — the consensus contract for an honest, minimal re-touch audit log

| System | Re-touch that doesn't change state | Where the "we tried N times" signal lives |
|---|---|---|
| Temporal | **No history event** (retries withheld "to avoid noise") | Mutable attempt counter, `Describe` API |
| Event sourcing / DDD | **No event** (aggregate validates vs current state, returns no-op) | Current aggregate state; optional distinct `*.attempted` event if audit-significant |
| Stripe | **No `*.updated`** (or empty `previous_attributes`) | `previous_attributes` diff on real transitions only |
| Kafka | Audit topic keeps all *transitions* (`delete` policy); current state collapses to latest-per-key (`compact`) | Compacted state-store / changelog topic, separate from the audit topic |
| CloudTrail | Read/no-op plane filtered out; **write-plane only** for change audit | (n/a — it just doesn't log the no-op touch) |

**The four-part best-practice contract:**

1. **Emit on transition, suppress on re-touch.** Decide *before* the append whether this re-processing
   actually changed the entity's status/identity. If not, append nothing. This is enforced at the
   write model (Temporal engine, DDD aggregate, Stripe's diff), not by hoping a consumer filters later.

2. **Put the "touch count" in mutable current-state, not in history.** A `last_touched_at`, an
   `attempt`/`retry_count`, and a `status` on a latest-per-key projection answer "how many times / is
   it still pending" without one log row per attempt. (Kafka: compacted changelog. Temporal:
   `Info.Attempt`.) History stays bounded and replayable; current-state stays cheap to query.

3. **Re-touch becomes audit-worthy only when it is itself a new fact.** If "we attempted and it was
   rejected/deferred again" carries compliance/forensic meaning, record it as a **distinct, named
   event type** (`*.attempted`, `*.rejected`, `*.deferred`) — never by re-emitting the original
   `*.changed`/`*.recorded` event. Pick the type by *what new thing happened*, not by *which code path
   ran*. Even then, prefer to fold repeated identical re-touches into a count on a single event
   (Temporal folds all retries into one terminal event's attempt count) rather than N events.

4. **Idempotency keys make re-emission a safe no-op, not a duplicate row.** Where the same logical
   transition can be reached twice (boot reconciliation, resumed run, redelivered command), give it a
   stable identity and a unique constraint so the second emit collapses to a no-op. (PDPP already does
   this: `controller-boot.ts:180` — "Unique-violation on `spine_run_abandoned_cause_unique` →
   idempotent no-op"; `attention-writer.js` dedupe keys. This is the right pattern; the gap is
   applying the *same discipline* to gap/coverage re-touches.)

## 7. Direct implications for PDPP's spine

- **The spine is an audit/transition log** (CloudTrail-`delete`/Stripe class), **not** a
  current-state projection (Kafka-`compact` class). Per the table above, the spine should carry
  *transitions* of runs/grants/gaps, and a **separate latest-per-key projection**
  (`connector_state` / a gap-status table) should carry "current status + attempt count + last
  touched." This is exactly the split Kafka encodes as two cleanup policies and the split DDD/CQRS
  encodes as event-store-vs-read-model.

- **A gap/conversation re-processed across many runs but unchanged must NOT mint a spine event per
  run.** That is the per-re-touch anti-pattern every surveyed system rejects. The correct signal is
  a counter/timestamp on the gap's current-state row. This squares with the recovered-gap re-defer
  class bug in MEMORY (`project_chatgpt_cooldown_starves_recovery`, `…recovered_gap_redefer…`): the
  store's `ON CONFLICT … (never reopens)` upsert is *already* the idempotent-no-op-on-re-touch
  discipline (good); the spine should follow the same rule and not append a no-op event each time a
  recovered key is re-emitted.

- **`SUMMARY_EVENT_CAP = 5000` (spine.ts:791) and the "largest observed run: 2,542 events" comment
  are the smell of re-touch bloat.** A run that emits thousands of events is closer to Temporal's
  "fill the history with noise" failure mode than to a clean transition log. If those events are
  per-detail-fetch / per-retry re-touches, the SLVP-ideal move is to fold them into bounded
  transition events + a counter, not to raise the cap. (Temporal explicitly keeps the per-attempt
  count *out* of history for this reason.)

- **Auditability is preserved, not lost, by this discipline.** "We tried this gap 51 times and it
  stayed pending" is fully reconstructable from (a) the run-lifecycle transition events that already
  exist per run + (b) the gap's current-state attempt counter. You lose nothing an honest auditor
  needs; you shed the no-op rows that make the log dishonest-by-volume (951 hostage non-pressure
  gaps, per MEMORY) and expensive to summarize.

**One-line answer:** Emit per **state-transition**, never per **re-touch**; keep the retry/touch
count in mutable latest-per-key current-state (Kafka-compact / Temporal `Describe`), reserve new
audit events for genuinely new facts (a distinct `*.attempted`/`*.deferred` type folded to a count,
not a re-emitted `*.changed`), and make any unavoidable re-emission an idempotent no-op via a unique
key — which PDPP already does for run-abandonment and attention, and should extend to gap/coverage.
