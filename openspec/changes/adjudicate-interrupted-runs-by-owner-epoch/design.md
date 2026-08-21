## Context

PDPP already had the right mechanism and the right terminal vocabulary.
`run.abandoned` is a first-class terminal event in `check-run-terminal.sql`,
`run-history-writer.ts`, and the `terminal_status` contract in
`openspec/specs/reference-implementation-architecture/spec.md`. A boot
reconciler already wrote it. The design was disabled by one identity defect,
and the surrounding machinery — a drain, a wall clock, a second reconciler —
existed to compensate for the resulting silence.

This change is therefore mostly subtraction. The one substantive addition is
durable identity; the deletions are its consequence.

## Goals / Non-Goals

**Goals:**

- Every run reaches exactly one durable terminal state, written by exactly one
  writer.
- An interrupted run is named `abandoned`, never `failed`.
- A successor container can adjudicate its predecessor's orphans.
- No adjudication decision depends on a tuned time threshold.

**Non-Goals:**

- Finishing in-flight work during shutdown.
- Committing staged cursors under interruption.
- A generic cross-table "interrupted work engine". Six boot reconcilers should
  share a *predicate*, not an executor; a unified engine would need per-table
  SQL, projections, and terminal vocabularies injected into it, which is
  relocation rather than decomplecting.

## Decisions

### The successor adjudicates; the dying owner writes nothing

The dying process is the wrong writer because it cannot be relied on to run at
all. A `kill -9` gets no shutdown path, so any design that needs the owner to
write its own terminal state has an unhandled case by construction.

This is the layering mature systems ship. Temporal's server has no
crash-detection channel and converts worker silence into a recorded outcome
with a timer alone; its `WorkerStopTimeout` — "the time delay before hard
terminate worker" — defaults to **0s**, so it does not wait for in-flight work
by default. Kafka's successor performs the recovery: `InitProducerId` "Bumps up
the epoch of the PID, so that the any previous zombie instance of the producer
is fenced off" and "Recovers (rolls forward or rolls back) any transaction left
incomplete by the previous instance." Primary sources for both, with quotes and
access dates, are in the research entry
`ai/research/pdpp/interrupted-work-needs-an-owner-fenced-terminal-state-not-a-graceful-shutdown-because-dockers-10s-stop-is-shorter-than-the-work.md`
(claims A, sources `sdk-go-worker-base`, `temporal-activity-failures`,
`kip-98`).

Alternative: retarget the controller path to write `run.abandoned` instead of
deleting it. Rejected because two writers racing for one run's terminal event
is worse than one. The boot reconciler is the better writer: it reads the
append-only spine rather than the `controller_active_runs` flight table, it is
idempotent on `caused_by_event_id` through the
`spine_run_abandoned_cause_unique` partial index, and it aborts boot on error
instead of swallowing it.

### `abandoned` stays distinct from `failed`

Interruption is Kubernetes' `Unknown`, not `False`. Kubernetes keeps the two
distinct because they drive different remediation — node `Unknown` yields an
`unreachable` taint, `False` yields `not-ready`. The same holds here: `failed`
on a bank connector means ask the human; `abandoned` means nobody knows, and
the normal schedule will pick it up. Collapsing them is what pages an owner for
a deploy.

The cost of the collapse is measured, not theoretical: of 134 production runs
recorded as `run.failed`/`controller_restarted`, 55 had staged a cursor and 34
had durably ingested a batch before being written down as plain failures.

### Durable identity beats an env var

Setting `PDPP_CONTROLLER_ID` in the run command would fix the filter. It is
rejected as the *default* because its failure mode is silent. Production runs
from a hand-rolled `docker run`; an identity that depends on an operator
reproducing a flag on every container recreation is one omission away from
reopening this exact defect, with no signal that it has reopened. That is how
the defect hid for three months. Reading the value from the same database that
holds the runs makes the correct answer the default. `PDPP_CONTROLLER_ID` is
kept as an override so a genuine multi-controller deployment can still
partition ownership.

`os.hostname()` survives only as the seed for the first row, never as the live
identity. The boot epoch still advances per boot; only the identity is stable,
so adjudication still distinguishes "a prior incarnation owned this" from "I
own this".

### The drain is deleted, not lengthened

Rejected on measurement. Production sets no `--stop-timeout`
(`docker inspect pdpp-core-prod-drain` returns `StopTimeout=<nil>`), so
Docker's 10s default governs, and `--stop-timeout` is fixed at container
creation — Docker has no equivalent of systemd's runtime `EXTEND_TIMEOUT_USEC=`
extension. Only 2 of 17 connectors finish inside 10s at p95; slack's p95 is
4052.8s. The gap is two orders of magnitude and is not closable by tuning.

The drain was observed in production failing exactly that way, logging
`{"drained":0,"elapsedMs":5000,"timedOut":1,"msg":"connector run drain complete"}`.
It is a negative, not a small win: it consumes half the SIGKILL budget doing
nothing while making the failure look handled.

Only the shutdown call site is removed. `drainActiveRuns` stays on the
controller, where it means "await in-flight runs" — 137 references exist on the
base branch and 136 remain, the single removal being the shutdown call. Sidekiq
draws the same line between *quiet* and *drain*.

### The epoch fence, not a wall clock, decides in-flight ownership

A wall-clock reaper must guess a threshold and can be wrong in both directions.
River documents the cost in its own config comment — "this can result in repeat
or duplicate execution of a job that is not actually stuck but is still
working" — and Oban's Lifeline carries the same caveat. An epoch fence needs no
guess: a unit stamped with epoch E, observed by epoch E' ≠ E, is *provably*
orphaned.

A `NULL` owner epoch must be swept, since no live process claims it. On
PostgreSQL this arm is spelled out explicitly rather than left to
`IS DISTINCT FROM`, because `owner_epoch IS DISTINCT FROM NULL` reduces to
`owner_epoch IS NOT NULL` and would spare exactly the legacy rows that most
need reclaiming.

## Corrections to the research entry

The research entry is `settled` and its prior-art layer holds, but
implementation measurement refuted four of its claims. The spec deltas reflect
the measurements, not the entry.

1. **"The leak is live and accruing" — false.** The entry inferred acceleration
   from re-measuring 121 as 123 forty minutes later. Those two extra rows were
   runs the live container had started minutes earlier — live work, not new
   orphans. The newest true orphan is 2026-07-10. The leak stopped because the
   *dishonest* path started catching what the honest one could not see; two
   defects were masking each other.

2. **Deleting `MANUAL_UPLOAD_IN_FLIGHT_STALE_MS` rests on an epoch that did not
   exist.** The entry said the wall clock answered "a question the epoch
   answers exactly", assuming an epoch was available on that table. It was not:
   `manual_upload_artifacts` had no epoch column, confirmed absent on the live
   database. Deleting the clock without adding the column would have been a
   straight regression — the sweep would have had nothing left to distinguish
   live work from dead. The column is the substantive change; the deletion is
   the consequence.

3. **"The two reconcilers race on the same runs" — false.** They are fully
   disjoint: zero of the 134 `controller_restarted` runs ever also received a
   `run.abandoned`. This strengthens the case for deleting the controller path
   rather than weakening it — there was no overlap proving the boot path
   already covered those runs, so the identity fix had to land first.

4. **The §11 gate is answered NO.** The entry asked whether connectors emit
   bounded `DETAIL_COVERAGE` with `covered == considered` and a non-null
   boundary. Zero of 34,928 `run.detail_coverage_declared` events in production
   carry `boundary`, `slice_start`, or `slice_end`. Committing staged cursors
   under `INTERRUPTED` would therefore fabricate denominators. That stage is
   correctly not shipped and is an explicit non-goal.

## Risks / Trade-offs

- [A backfill adjudicates live work] -> The repair tool excludes runs belonging
  to the newest `controller.booted` epoch. This is load-bearing: the first dry
  run against production reported 123 because it picked up two runs the live
  container had started ninety seconds earlier. Adjudicating those would have
  declared live work abandoned and freed the connection for a competing run,
  reintroducing the exact duplicate-execution hazard the epoch fence exists to
  avoid. Excluding the newest epoch fixes it with no threshold to tune; the
  dry run then reported 121, matching the measured backlog.
- [Deleting the controller path loses stale-claim cleanup] -> It does not. The
  function is retained as `releaseAbandonedControllerRunClaims` and still
  releases stale `controller_active_runs` rows, because
  `reconcileBrowserSurfaceLeasesAfterBoot` reads that table to decide which
  leases are still held. Releasing a claim and reporting on the work are
  separate jobs.
- [No drain means Chromium residue leaks] -> Chromium residue is still cleaned
  at next boot by `profile-lock.ts`.
- [A multi-controller deployment adjudicates a peer's live runs] -> The boot
  reconciler still filters on `controller_id`, and `PDPP_CONTROLLER_ID`
  partitions ownership. Only the repair tool ignores `controller_id`, and it is
  documented as single-controller-only, with `--connector` scoping for anyone
  else.
- [Legacy rows without an epoch] -> Both new columns are NULL-tolerant. A NULL
  owner epoch is treated as unclaimed and swept; a NULL `controller_id` is
  treated as ours under the single-controller assumption, which is the
  pre-existing behavior.

## Migration Plan

1. Land durable identity first. It is behavior-preserving on a host whose
   hostname was already stable, and on a container host it only makes the
   existing ownership filter match reality.
2. Run the repair tool's dry run, confirm the scope, then `--apply` with
   pre-image snapshots. Reversible: it only adds terminal events where none
   exist, and never edits or deletes an existing event.
3. Delete the controller failure path only after identity is durable, so the
   boot reconciler demonstrably covers the cases it covered.
4. Delete the drain and fence the manual-upload sweep. Both are independent of
   the above.
5. Roll back by restoring the controller path and the drain call site. Already
   written `run.abandoned` events remain valid and correct.
