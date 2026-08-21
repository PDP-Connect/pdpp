## Context

The vocabulary for run lifecycle already exists and is mostly correct. What is
missing is an owner. `run.abandoned` is a first-class terminal event in
`check-run-terminal.sql` and `run-history-writer.ts`; `run_generation` is a
textbook Kleppmann fencing token; `finalizeRunCleanup` implements a correct
compare-and-swap. Each is right on its own. None of them is *the* authority,
so each had to be invented where it was needed, and the copies drift.

This design is therefore about consolidation, not invention. The states are
already implied by the terminal set; the transitions are already implied by the
guards; the fence already ships in `controller_identity`. The work is to state
them once, in one module, with the database — not a comment — enforcing them.

Every claim below cites code read on `fix/sweep-fairness-and-transformer-bounds`
at `39d19704a`. Where the brief's figures did not reproduce, the measured value
is given and the discrepancy is named.

## Goals / Non-Goals

**Goals:**

- One closed state set, declared once, that every consumer reads.
- One writer per transition, named in the table.
- Every durable transition is a compare-and-swap fenced by owner epoch, failing
  at the database rather than by convention.
- Every historical incident cluster is expressible as an illegal transition, or
  is recorded as a finding explaining why it is not.
- Property tests that fail before implementation and pass after.

**Non-Goals:**

- Scheduling policy of any kind (D4's guard).
- A generic "workflow engine." Six boot reconcilers should share a predicate,
  not an executor — the sibling change already ruled on this and it holds here.
- Changing observable connector behavior. This is a refactor of truth-keeping
  (D14).

## (a) The closed state set

Nine states. `run_history.status` is the durable projection of this set, and
its existing literals map one-to-one — the set is not new vocabulary, it is the
existing vocabulary closed and named.

| State | Terminal | Durable projection | Meaning |
|---|---|---|---|
| `pending` | no | `run_history.status='pending'` | Admitted by the executor, not yet started. Exists so admission has a durable pre-state to CAS against. |
| `running` | no | `status='running'` | `run.started` emitted; the owning epoch is executing. |
| `awaiting_interaction` | no | `status='running'` + derived | The connector asked the owner for input and is blocked. Today derived in SQL by `controller-boot.ts:374-387`. |
| `cancel_requested` | no | `status='running'` + derived | `run.cancel_requested` seen; the executor has not yet stopped. |
| `succeeded` | **yes** | `status='succeeded'` | `run.completed`. |
| `failed` | **yes** | `status='failed'` | `run.failed`. An observed failure. |
| `surface_failed` | **yes** | `status='surface_failed'` | `run.browser_surface_failed`. Terminal pre-launch. |
| `cancelled` | **yes** | `status='cancelled'` | `run.cancelled`. Owner-initiated. |
| `abandoned` | **yes** | `status='abandoned'` | `run.abandoned`. No owner will ever report. Distinct from `failed` per the landed owner-epoch change. |

`pending` is the one addition. Everything else already exists as a
`toTerminalStatus` output (`run-history-writer.ts:91-108`) or a `status`
literal. `awaiting_interaction` and `cancel_requested` are named here because
the machine must be able to *refuse* transitions out of them; they project onto
`running` so no reader changes.

`skipped` is deliberately **not** a run state. It is written to
`run_history.status` by the scheduler's pre-run gate
(`scheduler/pre-run-gate.ts:99,119,141,157,173,193`) and by
`scheduler/run-executor.ts:555,572,592` for attempts that never started a run.
A skipped attempt has no `run.started` event and no run to transition — it is a
*dispatch outcome*, which is planner territory under D4. Recording it in the
same column as run state is how "scheduler-generated `status:"skipped"` records
fed into health classification" (the Gmail identity self-poisoning loop) became
possible. The machine does not adopt it; the migration keeps it writable by the
planner and forbids the machine from reading it as a run state.

**The set SHALL be declared once.** Today the terminal event set is declared in
at least **thirteen** places and **six of them disagree**. `lib/spine.ts:1066`
claims authority in its own comment — "All run-status projection code must read
from this set; never hardcode subset checks" — and is then not read by the
divergent copies:

| Declaration | Contents | Verdict |
|---|---|---|
| `lib/spine.ts:1066` (claims canonical) | 5 | correct |
| `stores/run-history-writer.ts:60`, `stores/connector-attention-store.ts:50`, `scripts/repair/adjudicate-orphaned-runs.ts:123`, `controller-boot.ts:707`, `queries/spine/check-run-terminal.sql:15`, `queries/spine/get-run-terminal-event.sql:13`, `db.ts:5992` | 5 | correct |
| `connector-summary-read-model.ts:1253` | **4 — omits `run.abandoned`** | **defect** |
| `db.ts:5437` `SPINE_TERMINAL_EVENT_TYPES_SQL` | **4 — omits `run.abandoned`** | **defect** |
| `postgres-storage.ts:2692,2716,2744,2793` | **4 — omits `run.abandoned`** | **defect** |
| `connector-summary-evidence-engine.ts:1599,1799` | **4 — omits `run.abandoned`** | **defect** |
| `lib/postgres-spine.ts:570` | **4 — omits `run.browser_surface_failed`** | **defect** |
| `postgres-storage.ts:2336` | **4 — omits `run.browser_surface_failed`** | **defect** |

`db.ts:5433` states it is "kept in sync with" `connector-summary-read-model.ts`.
The two agree with each other and both disagree with `lib/spine.ts`. The
observable consequence: an abandoned run is invisible to the connector-summary
fold and to the `connector_instance_id` backfill the fold's partial index
serves. The 121 runs adjudicated by the sibling change are exactly the
population this omission hides. Separately, four PostgreSQL-side declarations
omit a *different* member than the SQLite-side ones, so the two backends
disagree about what "terminal" means — cluster 4's defect class, in the
terminal vocabulary itself.

A comment asking two constants to stay in sync is not a mechanism. This is the
completeness test for D3 working as intended: writing the state set down found
six live divergences that no test catches.

### Audit: every side-state that lives beside run state

Verdicts are **absorb** (becomes a real state), **derive** (computed from the
machine, never stored), or **delete**.

| Side-state | Location | Verdict | Rationale |
|---|---|---|---|
| `activeRuns` map | `controller.ts:981` | **derive** | Currently the real admission authority; `finalizeRunCleanup:3249` hand-rolls a CAS on it. Becomes a read-through cache of `state ∈ {pending, running}` fenced by epoch. Its correctness stops depending on process memory. |
| `activeRunPromises` | `controller.ts:986` | **keep, out of scope** | Holds a JS promise, not state. "Await this run" is a runtime affordance with no durable meaning. Not a second truth. |
| `settledRunIds` | `controller.ts:997` | **delete** | Exists only to answer "did finalize already run?" — which `state` in a terminal set answers exactly. The `isStale` probe at `:3312` becomes a state read. |
| `controller_active_runs` | `db.ts:1149`, `postgres-storage.ts:1945` | **absorb** | The durable flight table. Becomes the `pending`/`running` rows of the machine rather than a parallel table. `reconcileBrowserSurfaceLeasesAfterBoot` reads it and keeps working — it is being re-homed, not removed. |
| `run_generation` | `db.ts:1156`, `controller.ts:1046` | **absorb → replaced by `owner_epoch`** | A per-instance monotonic fencing token, correct in kind but reinvented and *in-process* (`runGenerations` Map, cleared only by test reset). The owner epoch is the same idea already durable in `controller_identity`. One fence, not two. Note: the run-generation column shipped to SQLite before Postgres once — the exact dual-backend gap this design forbids. |
| `runWatchdogSettlements` | `controller.ts:1031` | **derive** | Watchdog fires ⇒ attempt an `abandoned` transition. If the CAS loses, the run already terminalized. Removes the timer/completion race entirely. |
| `needsHumanAttention` | `controller.ts:1055` | **delete (not absorb)** | In-memory `Set`, lost on restart, and **not a run state** — it is a per-*connection* automation-suppression policy. Absorbing it would smuggle scheduling policy into the machine, violating D4. It moves to the scheduler's own policy input, derived from terminal runs whose reason is an unresolved interaction. |
| `cooling_off` / `blocked` | `scheduler-backoff.ts:252` | **delete from run state** | Already not run state — a `recommendedHealthState` derived from a failure streak. Named here to record it as correctly-placed policy, and to forbid it moving in. |
| `scheduler_dispatch_wedged` | `scheduler.ts:197-215` | **derive** | A synthetic `status:"failed"` `RunRecord` fabricated when the pre-launch gate misses its liveness ceiling. Under the machine this is a real `failed` transition with `terminal_reason='scheduler_dispatch_wedged'`, not a fabricated record. The word "wedged" survives as a reason, not a shadow state. |
| `run_history.status` | `db.ts:1365` | **absorb** | The durable projection. Gains `owner_epoch` (below). |
| `scheduler_managed` | `db.ts:1379` | **keep, out of scope** | Provenance, not lifecycle. Marks which writer touched the row; scheduler cadence readers filter on it. Orthogonal. |
| `manual_upload_artifacts.owner_epoch` | landed sibling | **precedent** | Not run state. Cited because it is the pattern this design generalizes: an epoch column that replaced a wall clock. |

### F1 cluster completeness (D3's test)

| Cluster | Expressible as illegal transition? |
|---|---|
| GroupMe 503 — dispatch probe vs. active run | **Yes.** Planner attempting any write while `state ∈ {pending, running}`. Forbidden transition F1 below. |
| Ingest 503 never retried (Aug recurrence) | **Yes**, partially. The batch-level retry is HTTP policy, but the *observable* defect — a run reporting `failed` while records were durably committed — is `running → failed` attempted by a non-owner. Forbidden F5. |
| YNAB stuck-run wedge (`activeRuns` leak) | **Yes.** A run with no live owner epoch stuck non-terminal; `abandoned` becomes reachable, so the 409 cannot be permanent. Forbidden F6. |
| Collector-runner drain boundary race | **Yes.** Two clock reads with opposite boundary semantics; under CAS the second read cannot act on the first read's stale premise. Forbidden F3. |
| Run-generation fencing / stale controller write | **Yes.** Precisely the epoch CAS. Forbidden F2. |
| Controller-restart misclassification (`failed` vs `abandoned`) | **Yes.** `running → failed` by the boot path is forbidden; only `running → abandoned` is legal there. Forbidden F4. |
| **Maintenance-sweep shared-deadline starvation (×3)** | **NO — reported as a finding.** |

**The cluster that does not fit.** The maintenance-sweep starvation family
(2026-08-01 ×2, 2026-08-03) is not a run-lifecycle defect. No illegal run
transition occurs: every run in those incidents was in a legal state the whole
time. The defect is that a *shared budget* was divided unfairly across
page-mates, so some connections never got serviced. Forcing it into this table
would require modelling scheduler fairness as run state — which is exactly the
policy-in-the-machine error D4 forbids. Recording it as out of scope is the
honest answer, and it belongs to the sweep-fairness work already in flight on
this very branch. The state set is not missing a state on its account.

## (b) The legal transition table

**Single writer per transition.** "Executor" means the one owner module this
design mandates; today its responsibilities are split across `runtime/index.ts`,
`runtime/controller.ts`, and `runtime/scheduler/run-executor.ts`.

| # | Transition | Precondition | Single writer |
|---|---|---|---|
| T1 | `∅ → pending` | No non-terminal run for this `connector_instance_id` | Executor (admission) |
| T2 | `pending → running` | Caller holds the current owner epoch; `run.started` emitted | Executor |
| T3 | `running → awaiting_interaction` | Connector emitted `run.interaction_required` / `run.assistance_requested` | Executor |
| T4 | `awaiting_interaction → running` | Interaction reached a terminal interaction event | Executor |
| T5 | `running → cancel_requested` | Owner requested cancel (`run.cancel_requested`) | Executor, on owner intent |
| T6 | `running → succeeded` | Connector reported DONE; terminal commit gate passed | Executor |
| T7 | `running → failed` | Observed failure attributable to this run | Executor |
| T8 | `running → surface_failed` | Browser surface failed pre-launch | Executor |
| T9 | `cancel_requested → cancelled` | Executor observed the request and stopped | Executor |
| T10 | `{pending, running, awaiting_interaction, cancel_requested} → abandoned` | Run's `owner_epoch` is neither the actor's nor the newest boot epoch | **Boot adjudicator** (the sole exception to "executor only"; see (f)) |
| T11 | `awaiting_interaction → abandoned` | As T10, with reason `controller_terminated_while_awaiting_owner_interaction` | Boot adjudicator |

Terminal states have no outgoing transitions. That is the whole point of the
set being closed.

### Forbidden transitions, each naming the incident it prevents

| # | Forbidden | Incident prevented |
|---|---|---|
| F1 | Any run-state write by the **planner/scheduler** | **GroupMe 503.** `dispatchIfDue` probed `getForwardEvidenceDebt`'s reconcile write against an instance with a run in flight, contending on the per-instance mutex and turning committed batches into `connector_instance_busy` failures. Fixed at `scheduler.ts:636` by a guard whose own comment says it mirrors "the guard `executeRun` already applies one step later" — one rule stated twice. Under F1 the planner has no write path to guard. |
| F2 | Any transition whose actor's epoch ≠ the run's `owner_epoch` | **Stale-controller writes / run-generation fencing.** A predecessor that resumes after a successor took over must lose *at the database*. Today `run_history` has no epoch column, so this is enforced only in process memory (`controller.ts:1046`). |
| F3 | Any transition whose observed `state` ≠ the CAS expected state | **Collector-runner drain boundary race.** Two clock reads with opposite boundary semantics (`<=` on claim, `>` on `nextRetryTime`) let a deadline landing between them produce a false "empty" exit. A CAS cannot act on a premise that changed under it. |
| F4 | `{pending, running, …} → failed` by the boot/adjudication path | **Controller-restart misclassification.** 134 production runs recorded `run.failed`/`controller_restarted`; 55 had staged a cursor and 34 had durably ingested a batch. Interruption is not observed failure. Only T10/T11 are legal there. |
| F5 | A second terminal transition on an already-terminal run | **Double-terminal / ingest-503 misreporting.** The existing `AND status='running'` fence (`run-history-writer.ts:355`) already provides this for `run_history`; F5 makes it a property of the machine rather than of each writer remembering to add it. |
| F6 | A run remaining non-terminal with no live owner epoch | **YNAB stuck-run wedge.** A hung subprocess left an `activeRuns` entry forever, 409-ing every future manual run until restart. `abandoned` must always be reachable, so "wedged forever" is unrepresentable. |
| F7 | Any transition out of a terminal state | Terminal means terminal. Makes `records_emitted` revision-after-terminal — explicitly forbidden by the landed change — structurally impossible. |
| F8 | Any write to run state not routed through the owner module | **D1.** A `transitionRun()` helper that five modules import is today's distributed writes wearing a uniform. Raw `INSERT`s into `spine_events` (`controller-boot.ts:526`, `:597`) are the current instance of this. |

### Three live defects the table would have prevented

Found while auditing writers. Each is a real, current divergence — reported as
findings, not fixed here.

1. **An unfenced upsert can overwrite a terminal status.**
   `queries/controller/insert-run-history.sql:40` and its PostgreSQL twin
   `stores/scheduler-store.ts:1018` are `ON CONFLICT (run_id,
   connector_instance_id) DO UPDATE SET status = excluded.status` with **no
   `status = 'running'` fence**. Every other status writer has one
   (`run-history-writer.ts:355`, `:406`; `controller-boot.ts:670`, `:791`,
   `:859`). The scheduler's `appendRunHistory` normally runs *after* the generic
   writer has already finalized the row, so a scheduler retry can revise an
   already-terminal outcome. This is forbidden transition **F5** and **F7**,
   both violated by one statement.
2. **The PostgreSQL drift repair fences on `run_id` alone.**
   `controller-boot.ts:829` joins `WHERE h.run_id = t.run_id AND h.status =
   'running' AND h.connector_instance_id IS NOT NULL` — an `IS NOT NULL` check,
   not an equality. Its SQLite twin at `:788-790` correctly fences
   `AND connector_instance_id = ?`. The codebase documents in several places
   that `run_id` is not unique across connections, which is why every other
   writer fences on the pair. A dual-backend asymmetry in the repair path
   itself — cluster 4's defect class, inside the adjudication code.
3. **`run_generation` is written from two incompatible sources.**
   `controller.ts:3139-3187` derives it from a monotonic per-instance counter;
   `scheduler/run-executor.ts:819` sets it from `attempt`, a retry counter.
   One column, two meanings. Absorbing the fence into `owner_epoch` (M5)
   retires the ambiguity rather than arbitrating it.

4. **Two `createReferenceSchedulerManager` definitions exist.** One is inline
   at `server/index.ts:8828` and is what production calls (`:8378`). The other
   is exported from `server/scheduler-manager-factory.ts:374`, carries its own
   copy of all four dispatch probes — including the same
   `reconcileDirtyConnectorSummaryEvidence` write at `:558` — and is imported
   by **nothing outside tests**; the two importing tests take only
   `createRunManagedConnectorViaController`. A parallel copy of the exact
   subsystem this design governs, whose divergence no test can see. M2 must
   pick one before cutting writers over. This is D5's masking-pair hazard
   sitting in the tree already.

A fifth observation, not a defect: **`drainActiveRuns` has no production
caller.** All 116 call sites are test teardown. Its own doc comments
(`controller.ts:987`, `server/index.ts:8567`) still describe it as the
graceful-shutdown path and are stale relative to `server/index.ts:9670-9691`.
See the migration section for the full verdict.

## (c) The CAS + owner-epoch schema

### Schema change

`run_history` gains one column on both backends, NULL-tolerant so existing rows
migrate without a backfill:

- SQLite (`server/db.ts`): `owner_epoch TEXT` via the existing
  `addColumnIfMissing` helper — the same mechanism `run_generation` used at
  `db.ts:6171`.
- PostgreSQL (`server/postgres-storage.ts`):
  `ALTER TABLE run_history ADD COLUMN IF NOT EXISTS owner_epoch TEXT;` — the
  same shape used for `controller_active_runs.run_generation` at
  `postgres-storage.ts:1960`.

Verified absent today: `db.ts:1358-1395` and `postgres-storage.ts:2169-2197`
list every column, and neither has an epoch. The epoch exists only inside the
spine event's `data_json` (`runtime/index.ts:2745-2749`), which no `UPDATE` can
fence on cheaply. **Both backends in the same change** — `run_generation`
shipped to SQLite without Postgres once and was caught only as a deploy
blocker; the landed owner-epoch change repeats the warning. This design treats
a single-backend schema change as a defect by construction.

The epoch value is the boot epoch already stashed by
`emitControllerBootedAndStashEpoch` (`controller-boot.ts:202-231`), whose
identity half is durable in `controller_identity` (`controller-boot.ts:96-151`,
one row `id='singleton'`, live in production and verified by reading the file).

### The predicate

Every durable transition is one statement. No read-then-write.

**SQLite** (`better-sqlite3`, synchronous; decide by `.changes`):

```sql
UPDATE run_history
   SET status = ?,            -- new state
       completed_at = ?,      -- terminal transitions only
       terminal_reason = ?
 WHERE run_id = ?
   AND connector_instance_id = ?      -- run_id alone is not unique
   AND status = ?                     -- expected state
   AND (owner_epoch = ? OR owner_epoch IS NULL);
```

**PostgreSQL** (decide by `rowCount`):

```sql
UPDATE run_history
   SET status = $1,
       completed_at = $2,
       terminal_reason = $3
 WHERE run_id = $4
   AND connector_instance_id = $5
   AND status = $6
   AND (owner_epoch = $7 OR owner_epoch IS NULL);
```

Four properties of this predicate are load-bearing:

1. **`changes`/`rowCount` = 0 means the transition was refused**, and the caller
   must treat that as an ordinary outcome — someone else already moved the run.
   It is never retried blindly and never escalated to the owner.
2. **`connector_instance_id` is part of the fence, not decoration.** `run_id`
   alone is not unique across connections; both `run-history-writer.ts:355` and
   `controller-boot.ts:670` already fence on the pair, and this preserves that.
3. **The NULL arm is spelled out explicitly, not written `IS DISTINCT FROM`.**
   The landed sibling change was bitten by exactly this: on PostgreSQL,
   `owner_epoch IS DISTINCT FROM NULL` reduces to `owner_epoch IS NOT NULL` and
   would spare precisely the legacy rows that most need claiming. Writing
   `(owner_epoch = $7 OR owner_epoch IS NULL)` is identical on both backends
   and cannot silently reduce.
4. **The NULL arm is `OR`, not `AND`.** A legacy row written before the column
   existed has no claimant, so any epoch may adjudicate it. A row *with* a
   different epoch may not.

The adjudication transition (T10/T11) inverts arm 4 — it must match rows whose
epoch is *not* the actor's — and additionally excludes the newest boot epoch, so
live work is never adjudicated:

```sql
   AND (owner_epoch IS NULL OR owner_epoch <> :mine)
   AND (owner_epoch IS NULL OR owner_epoch <> :newest_boot_epoch)
```

This is the predicate the landed change already proved against production: its
dry run reported 123 before the newest-epoch exclusion and 121 after, the two
extras being runs a live container had started ninety seconds earlier.

### Why CAS and not a lock

An advisory lock answers "may I proceed?" at a moment; a CAS answers "was the
world still as I assumed when I wrote?" — which is the actual question after an
`await`. This repo already has at least five independently-invented admission
mechanisms (F1's count), and adding a sixth lock would extend that list. The CAS
adds no new mechanism: it is a `WHERE` clause on writes that already happen.

## (d) Property-test skeletons

Listed in `tasks.md` §5 with file names. Each is `.todo` or asserts against the
not-yet-existing owner module, so **none can pass before implementation**. That
is the requirement: this program has already shipped a conformance test that
asserted behavior it never exercised, and a guard that cannot fail certifies a
regression as safe.

Each skeleton names its property, its generator, and its invariant, and each
maps to a row in the forbidden table above. Dual-backend skeletons run against
SQLite and PostgreSQL from one body, because a Postgres-only divergence is
invisible to this suite by construction — that is a named defect class here
(6,792 tests stayed green while production could not paginate).

## (e) The D4 split, stated precisely

- The **planner** (`runtime/scheduler.ts`, `scheduler/dispatch-governor.ts`,
  `scheduler-backoff.ts`) READS run state and emits **intents**. It writes no
  run state, ever.
- The **executor** is the sole writer of transitions T1-T9, and the boot
  adjudicator of T10-T11.

**The split does not hold today.** A first pass suggested it nearly did —
`runtime/scheduler.ts` emits no spine event and contains no literal `UPDATE
run_history`. That reading was wrong, and the correction matters more than the
original claim. The scheduler writes run state four ways:

| # | Write | Site |
|---|---|---|
| P1 | `INSERT INTO run_history` for skip and back-off records | `scheduler.ts:432`, `:445` (`recordAndNotify` → `schedulerStore.appendRunHistory`), called from `dispatchIfDue:655`, `:662`; SQL at `scheduler-store.ts:570` / `:995` |
| P2 | `scheduler_last_run_times` upsert | `scheduler.ts:477`; `scheduler-store.ts:1607` |
| P3 | In-process `activeRuns` set and five announcement-dedup maps | `scheduler.ts:547`, `:576`; `dispatch-governor.ts:559`, `:563`, `:588`, `:590`, `:593` |
| P4 | **A durable repair write inside the dispatch-eligibility probe** | `server/index.ts:9057` — `getForwardEvidenceDebt` calls `reconcileDirtyConnectorSummaryEvidence([instanceId])` *before* its read at `:9058`; that reconcile takes `withConnectorInstanceWrite` and issues `withPostgresTransaction({ lockConnectorInstanceId })` upserts (`connector-summary-evidence-engine.ts:1281`, `:1866`, `:2691`) |

**P4 is the GroupMe 503 mechanism**, and it is the clearest violation of D4:
a read-only-looking eligibility probe that takes the per-instance write mutex.
So F1 must forbid *side-effecting reads*, not merely direct writes. A planner
that "only reads" but whose read reconciles is a writer.

P1 is the second-order version of the same error: the scheduler writes rows
that feed back into `runtime.history`, which is the next tick's own decision
input. The Gmail identity self-poisoning loop is exactly this — scheduler-
generated `status:"skipped"` records read back as run outcomes.

Under this design: P4 moves to the executor or becomes genuinely read-only.
P1's records stay writable by the planner but are not run states (see
`skipped`, above) and the machine never reads them. P2 is planner-owned cadence
state, unaffected. P3's `activeRuns` set is replaced by an epoch-fenced read of
the machine — today it is an in-process `Set` that dies with the process, so
the `dispatchIfDue` guard does not suppress a probe against a run started by a
different process or surviving a restart.

**The policy guard.** The machine answers *is this transition legal*. It never
answers *which connector runs next*. Concretely: `cooling_off`, `blocked`,
backoff curves, fairness rotation, admission deadlines, and per-statement
budgets stay in the planner. "Runnable" means "no legal impediment to a T1"; it
does not mean "chosen." `needsHumanAttention` is deleted from the controller
for exactly this reason — it reads like run state and is actually automation
policy.

## (f) The D6 formalization

`scripts/repair/adjudicate-orphaned-runs.ts` and
`reconcileOrphanedRunsAtBoot` (`controller-boot.ts:344`) implement the same
adjudication with different scopes. The script is the owner-operated backlog
tool: dry-run by default, ignores `controller_id` (the field that was broken),
excludes the newest boot epoch, snapshots pre-images into an `aor_backup` table
inside the write transaction. The boot reconciler is the steady-state path:
filters on `controller_id`, runs before HTTP routes mount, aborts boot on error.

Under this design the boot reconciler **is** transitions T10/T11 — the same
predicate, expressed once in the owner module. Three properties must be
preserved exactly, because this is a behavior-preserving move (D14):

1. **Idempotency stays on `caused_by_event_id`,** via the
   `spine_run_abandoned_cause_unique` partial index. Repeated passes emit
   exactly one terminal event per orphan. The existing code catches *only* the
   named constraint and never blanket-catches `23505` / `SQLITE_CONSTRAINT_UNIQUE`;
   the owner module must keep that discipline.
2. **Newest-epoch exclusion stays,** and stays load-bearing. Without it,
   adjudication declares live work abandoned and frees its resource for a
   competing run — reintroducing the duplicate-execution hazard the fence
   exists to prevent.
3. **`records_emitted` is never revised.** Records durably ingested before the
   interruption stay committed. F7 makes this structural.

The one real change: the raw `INSERT`s at `controller-boot.ts:526` and `:597`
that bypass `emitSpineEvent` — and therefore had to hand-write their own
`run_history` projection at `:657` and `:837` to avoid stranding rows at
`running` — route through the owner module instead. The event and its
projection already commit in one transaction; that stays. The bypass is the F8
violation this design closes.

The repair script remains a script. It is owner-operated, dry-run-first,
`--limit`-bounded, and deliberately ignores the ownership filter — properties
of an operational tool, not of a lifecycle transition. It should call the same
predicate rather than reimplement it, which is the whole benefit.

## (g) The D5 migration plan

Writers cut over atomically per subsystem, old paths deleted in the same change,
readers migrate after. Never let old and new writers coexist across a deploy
boundary — every "parallel systems" period in this repo produced a masking pair.

| Tranche | Writers cut over | Deleted in the same change |
|---|---|---|
| M1 | Schema + owner module (no callers yet) | nothing — additive only |
| M2 | Terminal writes: `runtime/index.ts` ×6, `controller.ts` ×2, `terminal-run-commit-store.ts`, `local-device-terminal-collection.ts` | the direct `emitSpineEvent` terminal calls at those sites |
| M3 | Admission + finalize: `activeRuns`, `settledRunIds`, `runWatchdogSettlements` | `settledRunIds`; hand-rolled CAS at `controller.ts:3249` |
| M4 | Boot adjudication (T10/T11) | raw `INSERT`s at `controller-boot.ts:526`, `:597` |
| M5 | Fence unification | `run_generation` column + `runGenerations` map |
| M6 | Readers: the four terminal-set declarations collapse to one | `TERMINAL_RUN_EVENT_TYPES`, `SPINE_TERMINAL_EVENT_TYPES_SQL` |

M6 is where the `run.abandoned` omission defect is repaired — as a consequence
of single declaration, not as a separate fix.

### The `drainActiveRuns` collision — verdict: **the brief's premise no longer holds**

The brief asks me to confirm the Sidekiq *quiet* vs *drain* split and say which
references migrate. Measured on this branch, `39d19704a`:

- **139 total references** — the brief's number reproduces exactly.
- **3** are in `openspec/changes/adjudicate-interrupted-runs-by-owner-epoch/**`
  (prose in the landed sibling change).
- **127** are in `reference-implementation/test/**`, of which **116** are call
  expressions — overwhelmingly `await controller.drainActiveRuns(1000)` as
  test teardown.
- **9** are in source: `runtime/controller.ts` ×7 (one definition at `:4144`,
  one interface member at `:786`, one export at `:4394`, four comments) and
  `server/index.ts` ×2 — **both of which are comments, not call sites**.

**There is no shutdown call site left to delete. It is already gone**, removed
by the landed sibling change. `server/index.ts:8570` now reads "The shutdown
path deliberately does NOT drain," and `:9686-9689` records that
"`drainActiveRuns` itself stays on the controller: it means 'await in-flight
runs' … Sidekiq draws the same line between *quiet* and *drain*."

So: **the split is correct and is already implemented.** My verdict confirms the
brief's reading of the semantics and corrects its state — this is not open work.
The residual figures also differ slightly from the sibling change's prose, which
says "137 references … 136 remain." Today's count is 139 including its own 3
lines of prose, i.e. 136 outside that change plus 3 inside it. The numbers are
consistent; the sibling was counting before it wrote about itself.

Which references migrate under this design: **none of the 116 test calls.**
`drainActiveRuns` means "await in-flight run promises" — a runtime affordance
over `activeRunPromises` (JS promises, ruled "keep, out of scope" above), not a
run-state mutation. It never transitions a run. It stays exactly where it is
and keeps its name.

## Risks / Trade-offs

- [Design authored against a moving branch] -> A concurrent agent owns the
  scheduler-conformance helper and the store drivers. The single-writer
  inventory is a point-in-time read of `39d19704a` and must be re-verified
  before M2 begins. Named as a residual risk, not mitigated here.
- [`pending` is a new state with no existing projection] -> It is the only
  addition, and it exists so admission has something to CAS against. If M1
  measurement shows admission can safely CAS `∅ → running` directly, `pending`
  should be dropped rather than kept for symmetry — a state that no transition
  needs is a second truth in waiting.
- [Absorbing `controller_active_runs` touches browser-surface leases] ->
  `reconcileBrowserSurfaceLeasesAfterBoot` reads that table to decide which
  leases are still held. Absorption must preserve that read or re-home it in
  the same tranche; it is explicitly not a deletion.
- [Deleting `needsHumanAttention` changes automation behavior] -> It is
  in-memory and already lost on every restart, so its current behavior is
  "suppress until restart." Moving it to a derived scheduler policy input makes
  it durable, which is a *behavior change* and must be measured on the canary
  rather than assumed neutral. This is the one item in the audit that is not
  behavior-preserving on its face.
- [CAS refusals become invisible] -> A transition that returns 0 rows is a
  normal outcome, which means a bug that refuses *every* transition looks like
  a quiet system. The canary metrics in `tasks.md` §6 therefore count
  successful transitions, not just absence of anomalies.
