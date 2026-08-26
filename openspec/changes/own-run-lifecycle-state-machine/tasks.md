## 1. Design (this change)

- [x] 1.1 Enumerate the closed state set, including `abandoned`, and rule
      `skipped` out as a dispatch outcome rather than a run state.
- [x] 1.2 Audit every boolean and side-state living beside run state and record
      an absorb / derive / delete verdict for each in `design.md`.
- [x] 1.3 Express every F1 incident cluster as a forbidden transition, and
      report the one cluster that cannot be expressed as a finding.
- [x] 1.4 Write the legal-transition table with each transition's precondition
      and single writer, and the forbidden table annotated with the incident
      each entry prevents.
- [x] 1.5 Specify the compare-and-swap predicate for SQLite and PostgreSQL
      together, including the explicit null arm.
- [x] 1.6 State the planner/executor split and its policy guard.
- [x] 1.7 Specify successor adjudication as a legal transition preserving
      observable behavior.
- [x] 1.8 Write the writers-first migration plan and the `drainActiveRuns`
      verdict.

## 2. Findings raised by this design (not fixed here)

- [ ] 2.1 Six terminal-set declarations disagree with `lib/spine.ts:1066`. Four
      omit `run.abandoned` (`connector-summary-read-model.ts:1253`,
      `db.ts:5437`, `postgres-storage.ts:2692`, `connector-summary-evidence-engine.ts:1599`);
      two omit `run.browser_surface_failed` (`lib/postgres-spine.ts:570`,
      `postgres-storage.ts:2336`). Closed by M6, not before.
- [ ] 2.2 `insert-run-history.sql:40` and `scheduler-store.ts:1018` upsert
      `status = excluded.status` with no `status = 'running'` fence, so a
      scheduler retry can overwrite a terminal status.
- [ ] 2.3 `controller-boot.ts:829` (PostgreSQL drift repair) matches on
      `run_id` alone while its SQLite twin at `:788` fences on
      `connector_instance_id`.
- [ ] 2.4 `run_generation` is written from a monotonic counter
      (`controller.ts:3187`) and from a retry `attempt`
      (`scheduler/run-executor.ts:819`) — one column, two meanings.
- [ ] 2.5 Two `createReferenceSchedulerManager` definitions exist
      (`server/index.ts:8828` live, `scheduler-manager-factory.ts:374`
      test-only). Resolve before M2.

## 3. Schema (implementation, not this change)

- [ ] 3.1 Add NULL-tolerant `run_history.owner_epoch TEXT` on SQLite via
      `addColumnIfMissing`, mirroring the `run_generation` migration.
- [ ] 3.2 Add `run_history.owner_epoch TEXT` on PostgreSQL via
      `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, **in the same change** as 3.1.
- [ ] 3.3 Stamp `owner_epoch` in the same write that admits a run.
- [ ] 3.4 Add a dual-backend test proving the column exists and is written on
      both, so a single-backend migration cannot ship.

## 4. The owner module (implementation, not this change)

- [ ] 4.1 Declare the state set and terminal subset once; every consumer derives.
- [ ] 4.2 Implement the transition table T1-T11 as epoch-fenced compare-and-swap.
- [ ] 4.3 Return refusal as an ordinary outcome; never retry blindly.
- [ ] 4.4 Route boot adjudication (T10/T11) through the same predicate.
- [ ] 4.5 Cut writers over per the M1-M6 tranches, deleting each old path in the
      same change as its replacement.

## 5. Property-test skeletons (this change — must fail or `.todo`)

Each skeleton is authored `.todo` or asserting against the not-yet-existing
owner module, and is marked in-file as a skeleton. **A skeleton that passes
before implementation is the defect this program exists to kill.** Each names
its property, generator, and invariant, and maps to a forbidden transition.

- [x] 5.1 `run-lifecycle-transition-legality.property.test.ts` — **F7, F5.**
      Generator: random sequences of transition attempts drawn from the full
      state × transition cross-product. Invariant: the observed state after any
      sequence is reachable from the initial state by legal transitions only,
      and a terminal state is never left.
- [x] 5.2 `run-lifecycle-epoch-fencing.property.test.ts` — **F2.** Generator:
      interleavings of two actors with distinct epochs attempting transitions on
      one run. Invariant: only the run's owner epoch ever changes state; the
      stale actor's statement matches zero rows. Runs on both backends.
- [x] 5.3 `run-lifecycle-single-terminal.property.test.ts` — **F5, F4.**
      Generator: concurrent terminal attempts of differing kinds, including a
      boot adjudicator racing an executor. Invariant: exactly one terminal state
      results; an interrupted run terminalizes `abandoned`, never `failed`.
- [x] 5.4 `run-lifecycle-planner-writes-nothing.property.test.ts` — **F1.**
      Generator: planner eligibility evaluations against instances in every
      state, including one with a run in flight. Invariant: zero durable writes
      and zero connector-instance write-lock acquisitions occur during a planner
      read. This is the GroupMe 503 as a property.
- [x] 5.5 `run-lifecycle-no-permanent-wedge.property.test.ts` — **F6.**
      Generator: runs abandoned mid-flight by an epoch that never returns.
      Invariant: a terminal state is always reachable, and the connector
      instance can admit a new run afterwards. This is the YNAB wedge.
- [x] 5.6 `run-lifecycle-cas-no-stale-premise.property.test.ts` — **F3.**
      Generator: transitions whose observed state is mutated by a competing
      actor between the caller's read and its write. Invariant: no transition
      commits on a premise that changed under it. This is the drain/clock race.
- [x] 5.7 `run-lifecycle-terminal-set-agreement.property.test.ts` — **the
      declaration requirement.** Generator: every terminal state, read through
      every consumer of the terminal set. Invariant: all consumers agree, and
      both backends agree. Fails today on the six divergent declarations.
- [x] 5.8 `run-lifecycle-adjudication-idempotence.property.test.ts` — **T10/T11.**
      Generator: repeated adjudication passes over overlapping orphan sets,
      including a run in the newest boot epoch. Invariant: exactly one terminal
      event per orphan; newest-epoch runs are never adjudicated; record counts
      are never revised.

- [ ] 5.9 Register 5.1-5.8 in the suite as expected-failing until the owner
      module lands, so their red state is deliberate and visible rather than
      an unexplained broken build.

## 6. Pre-registered canary metrics (D15)

Registered **before** any Step 1 deploy. Post-hoc criteria are how "green"
claims died in this program.

- [ ] 6.1 **Restarts.** 20 consecutive controller restarts in a replaced
      container with zero adjudication anomalies: every `run.started` without a
      terminal event belongs to the newest boot epoch, and no run holds two
      terminal events. Measured by query, not by log reading.
- [ ] 6.2 **Race-class property tests green.** All of 5.1-5.8 pass on both
      SQLite and PostgreSQL. Any skipped test counts as a failure.
- [ ] 6.3 **Transition throughput is non-zero.** Count of successful transitions
      per state pair over the canary window is greater than zero for T1, T2, and
      at least one terminal transition. A machine that refuses everything would
      otherwise satisfy every "zero anomalies" metric.
- [ ] 6.4 **Refusal rate is bounded.** Refused transitions stay under 1% of
      attempts outside adjudication. A rising refusal rate means the expected
      state is being computed wrong somewhere.
- [ ] 6.5 **Behavior preservation (D14).** Per-connector run outcomes over the
      canary window match the pre-change baseline in kind and count. Terminal
      state distribution shifts only by the `failed` → `abandoned`
      reclassification the design intends.
- [ ] 6.6 **No permanent wedge.** Zero connector instances refusing a new run
      with `active_run_exists` for longer than one scheduling interval.
      Baseline: the UAT instance previously held 7 of 8 `running` rows as
      zombies up to two days old.
- [ ] 6.7 **Dual-backend parity.** 6.1-6.6 measured on both backends. A
      PostgreSQL-only or SQLite-only pass is a failure, not a partial success.

## 7. Validation

- [ ] 7.1 `openspec validate own-run-lifecycle-state-machine --strict`.
- [ ] 7.2 `openspec validate --all --strict` against the recorded baseline of 11
      pre-existing failures, so this change's contribution is distinguishable.
- [ ] 7.3 Re-verify the single-writer inventory against the branch head before
      M2 begins; it is a point-in-time read and concurrent agents own adjacent
      files.
