## Why

Run state has no owner. It is spread across an append-only spine, a durable
`run_history` projection, a durable `controller_active_runs` flight table, and
at least five in-process maps in `runtime/controller.ts` — with no single
component that decides which transitions are legal.

The consequence is measured, not theorized. Terminal events are emitted from at
least five modules: `runtime/index.ts` (lines 4071, 5117, 5172, 5367, 5414,
5563), `runtime/controller.ts` (3707, 4083), `server/stores/terminal-run-commit-store.ts:117`,
`operations/local-device-terminal-collection.ts:211`, and — bypassing
`emitSpineEvent` entirely with raw `INSERT`s — `lib/controller-boot.ts`. Each
site re-derives for itself what a legal terminal write is.

Two facts found while writing this proposal show the cost directly:

1. **The terminal set disagrees with itself.** `check-run-terminal.sql:15` and
   `get-run-terminal-event.sql:13` list five terminal events including
   `run.abandoned`. `connector-summary-read-model.ts:1253`
   (`TERMINAL_RUN_EVENT_TYPES`) and `db.ts:5437`
   (`SPINE_TERMINAL_EVENT_TYPES_SQL`) list four and omit `run.abandoned` — and
   `db.ts`'s own comment says the two are "kept in exact sync." They are in
   sync with each other and out of sync with the spine. An abandoned run is
   therefore invisible to the connector-summary fold and to the
   `connector_instance_id` backfill that fold depends on. The change that made
   `abandoned` a first-class terminal state could not update these because
   nothing declares the set once.

2. **The epoch cannot fence a durable write.** `run.started` stamps
   `boot_epoch`, `controller_id`, and `seq` into the spine event's `data_json`
   (`runtime/index.ts:2745-2749`), but `run_history` has no epoch column on
   either backend (`db.ts:1358`, `postgres-storage.ts:2169`). Every durable
   run-state UPDATE is fenced on `AND status = 'running'` alone
   (`run-history-writer.ts:355`, `:406`; `controller-boot.ts:670`). That fence
   stops a double-terminal write but cannot stop a *stale epoch's* write: a
   predecessor container that comes back from a pause still sees `running` and
   still wins. Fencing exists in-process instead, as a hand-rolled
   compare-and-swap on a JavaScript map (`controller.ts:3249`) plus a
   `run_generation` counter (`controller.ts:1046`) — correct, and invisible to
   the database that actually arbitrates.

The historical incidents are all one shape. The GroupMe 503 was two components
mutating run state through the same per-instance mutex, fixed by a guard in the
scheduler (`scheduler.ts:636`) that mirrors "the guard `executeRun` already
applies one step later" — the same rule stated twice because no component owns
it. The collector-runner drain race was two clock reads with opposite boundary
semantics. The YNAB wedge was an `activeRuns` entry that outlived its run and
409-ed the instance until restart.

This change writes down the machine: a closed state set, a transition table
whose forbidden entries name the incident each one prevents, and a
compare-and-swap predicate fenced by the owner epoch that already ships
durably in `controller_identity` (`lib/controller-boot.ts:96-151`).

## What Changes

This change is **design and tests-first only**. It authors the contract and
failing property-test skeletons; it writes no implementation. That is
deliberate — the implementation is single-threaded and starts from a settled
design.

- Define the **closed run state set** and require it be declared exactly once,
  so a terminal-set divergence like `TERMINAL_RUN_EVENT_TYPES` becomes a
  compile-time impossibility rather than a comment asking two constants to
  agree.
- Rule on every side-state that lives beside run state today: `activeRuns`,
  `controller_active_runs`, `run_generation`, `settledRunIds`,
  `needsHumanAttention`, the scheduler's `cooling_off` and
  `scheduler_dispatch_wedged` markers — each **absorbed**, **derived**, or
  **deleted**, with the verdict recorded in `design.md`.
- Define the **legal transition table**: each transition's precondition and its
  single writer. Define the forbidden transitions, each annotated with the
  historical incident it prevents.
- Require every durable transition to be a **compare-and-swap fenced by owner
  epoch** — `WHERE state = <expected> AND owner_epoch = <mine>` — and specify
  the predicate for SQLite and PostgreSQL together, since this repo runs both
  and a Postgres-only design has already shipped silent divergence here once.
- Add an `owner_epoch` column to `run_history` on both backends, NULL-tolerant,
  so the fence has a column to read. It does not exist today.
- State the **D4 split**: the planner reads the machine and emits intents; only
  the executor transitions. Scheduling *policy* stays out of the machine —
  "runnable" is not "chosen to run next."
- Formalize **successor adjudication** as a legal transition executed at boot,
  replacing the sibling-script framing, with observable behavior unchanged.
- Author **property-test skeletons**, one per historical incident cluster, each
  failing or `.todo` and marked as a skeleton. A skeleton that passes without
  implementation is the hollow-test defect this program exists to kill.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: Define the closed run state set and
  its single declaration, the legal-transition table and its single-writer
  rule, the epoch-fenced compare-and-swap requirement and its dual-backend
  predicate, the planner/executor split, and successor adjudication as a
  lifecycle transition.

## Impact

- Design-only in this change. No runtime file is modified.
- New failing property-test skeletons under `reference-implementation/test/`,
  named `run-lifecycle-*.property.test.ts`, excluded from the green gate until
  the implementation change lands.
- The implementation this design governs will touch
  `reference-implementation/runtime/controller.ts`,
  `runtime/index.ts`, `runtime/scheduler.ts`,
  `server/stores/run-history-writer.ts`, `lib/controller-boot.ts`,
  `server/db.ts`, and `server/postgres-storage.ts`.
- Additive `run_history.owner_epoch` on SQLite and PostgreSQL, NULL-tolerant,
  so existing databases migrate without a backfill.

## Non-Goals

- **Any implementation.** No writer is cut over here, no state is renamed in
  code, no migration runs.
- **Scheduling policy.** Fairness, throttling, backoff curves, and dispatch
  ordering stay where they are. The machine answers whether a transition is
  legal, never which connector should run next.
- **Coverage-ledger and health work.** Steps 2 and 3 of this program depend on
  this machine and are sequenced after it (D17).
- **Auto-resume or auto-retry of interrupted runs.** Unchanged from the landed
  owner-epoch change: adjudication is silent and the normal schedule picks the
  work up.
- **Committing staged cursors under interruption.** Still gated on the
  bounded-`DETAIL_COVERAGE` evidence that production does not yet emit.

## Residual risks

- The transition table is authored against the code as read on
  `fix/sweep-fairness-and-transformer-bounds` at `39d19704a`. A concurrent
  agent owns the scheduler-conformance helper and the store drivers; if those
  land new run-state writers, the single-writer inventory needs a re-read
  before implementation begins.
- One historical cluster — the maintenance-sweep shared-deadline starvation
  family — is **not** expressible as an illegal run transition. It is a
  fairness defect in a different subsystem, recorded in `design.md` as a
  finding rather than forced into the table.
