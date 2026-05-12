# Design brief: boot-epoch reconciliation for abandoned runs

**Status:** Implementation contract (revised 2026-05-11 after external SLVP review).
**Author:** the owner Nunamaker (via working session, 2026-05-11).
**Audience:** A third-party expert with zero PDPP context. Adversarial review requested before implementation.
**Scope:** Protocol-level invariant and runtime mechanism for ensuring the spine event log never contains orphaned `run.started` events whose owning process has terminated. Specifies new event types, schema additions, boot-time reconciliation, and a verifiable SQL invariant.

This brief follows the pattern of `docs/binary-content-invariant-design-brief.md` — invariant first, prior art second, design third, staged implementation last.

---

## 0. What is PDPP, and why does this brief exist

PDPP (Personal Data Polyfill Protocol) is a reference implementation of an OAuth-2.1-extension protocol for human consent over personal data flows. The reference implementation runs jobs called *connector runs* — adapter processes that capture records from data sources (Gmail, Slack, Codex sessions, etc.) and emit them into PDPP storage. Each run's lifecycle is recorded as a sequence of events in the **disclosure spine**, an append-only event log in `spine_events` (`reference-implementation/server/db.js:498-528` for SQLite, `reference-implementation/server/postgres-storage.js:478-514` for Postgres).

A normal run lifecycle:

```
run.started { actor_id: <connector_id>, run_id: <run_id>, ... }
…
run.completed | run.failed | run.cancelled { run_id: <same>, ... }
```

The terminal events (`run.completed`/`run.failed`/`run.cancelled`) are emitted by the runtime controller (`reference-implementation/runtime/controller.ts:760-830`, `reference-implementation/runtime/index.js:1063+`).

**The incident:** during the SQLite→Postgres migration (`docs/binary-content-invariant-design-brief.md`), the migrated database was opened by the reference container, and the dashboard reported all 13 connectors as "Running · 1567m 23s" — a uniform 26-hour stuck-since duration. Investigation revealed:

- 12 `run.started` events across 9 connectors lack matching terminal events.
- These orphans are real: the runtime process that emitted them crashed between `run.started` and the terminal event.
- Postgres reports 0 rows in `scheduler_run_history`, the table the existing abandoned-run reconciler (`reference-implementation/runtime/controller.ts:823`) reads. So the reconciler runs successfully but has nothing to clean up.
- The dashboard's `isRunning` derivation reads from `/_ref/runs`, which projects status from `spine_events`. It sees `run.started` without terminal → reports `"in_progress"`.

The two views of the world disagree:
- The runtime reconciler thinks no runs are running (correct — no live processes).
- The dashboard thinks 13 runs are running (incorrect — but consistent with the event log).

The dashboard is the more rigorous view: **only the event log is authoritative**. A reconciler that depends on a side table (`scheduler_run_history`) cannot see orphans that survived a migration or a sufficiently long downtime where the side table was rotated. The fix is to make orphan reconciliation a property of the event log itself.

---

## 1. Concrete evidence

Spine state on the freshly-migrated Postgres database, queried per connector:

| Connector | starts | terminals | orphans |
|---|---|---|---|
| amazon | 26 | 25 | 1 |
| chase | 16 | 14 | 2 |
| chatgpt | 27 | 27 | 0 |
| claude-code | 12 | 12 | 0 |
| codex | 11 | 11 | 0 |
| github | 11 | 11 | 0 |
| gmail | 26 | 23 | 3 |
| manual_action_stub | 3 | 3 | 0 |
| reddit | 10 | 9 | 1 |
| slack | 22 | 20 | 2 |
| stream-test-stub | 5 | 5 | 0 |
| usaa | 29 | 27 | 2 |
| ynab | 13 | 13 | 0 |
| **Total** | **211** | **199** | **12** |

The source SQLite had the same orphans before migration — they're not a migration artifact, they're a pre-existing condition the migration faithfully preserved. `scheduler_run_history` had 0 rows in both source and target. Each connector's most-recent run event is, individually, terminal — but the dashboard groups by `run_id` and finds 12 distinct run_ids with `run.started` and no corresponding terminal.

---

## 2. The three approaches considered

### A. Time-threshold

Treat any orphaned `run.started` older than N minutes as failed. Single config knob.

**Rejected.** The threshold is arbitrary; it collapses "slow" and "dead" into one verdict; same query at different times returns different answers; rule lives in operator config rather than schema. The literature's only mainstream example is **Airflow's zombie task threshold**, which is "the system most plagued by false positives" (independent SLVP research, citing Airflow's OOM-eviction and long-SSH-operator failure modes).

### B. Boot-epoch / startup-fence (the endorsed design)

Every `run.started` is stamped with a `boot_epoch` belonging to the process incarnation that emitted it. On every process boot, the controller emits a synthetic `run.abandoned` terminal event for any `run.started` whose `boot_epoch != current_epoch` and that lacks a matching terminal.

**Endorsed by independent research.** This is the dominant pattern in mature systems:

| System | Mechanism | Reference |
|---|---|---|
| PostgreSQL | `pg_control.TimelineID` + XID epoch; WAL replay determines transactions provably aborted | [Recovery Internals](https://www.cybertec-postgresql.com/en/postgresql-recovery-internals/) |
| Kafka | Producer epoch + `transactional.id`; stale epoch → `ProducerFencedException` | [KIP-447](https://cwiki.apache.org/confluence/display/KAFKA/KIP-447) |
| systemd | Kernel `_BOOT_ID` stamped on every journal entry; `journalctl --list-boots` partitions logs by incarnation | journald(8) |
| Kubernetes | `coordination.k8s.io/Lease.holderIdentity`; new leader fences old holderIdentity | [Leases](https://kubernetes.io/docs/concepts/architecture/leases/) |
| GoodJob (Postgres) | Session-level advisory lock; PG releases atomically on session death | [#273](https://github.com/bensheldon/good_job/pull/273) |
| etcd / ZooKeeper | Lease ID / session ID attached to keys; store deletes keys when lease/session dies | etcd docs |

**Common pattern:** *bind in-flight work to a durable identity for the current process incarnation; on next boot, any work bound to a non-current identity is provably orphaned.* The terminal verdict is **deterministic** ("epoch ≠ current"), not probabilistic ("hasn't responded in N minutes").

### C. Heartbeat

Running jobs emit periodic `run.heartbeat` events. Readers treat starts without recent heartbeats as dead.

**Useful as augmentation, not as primary mechanism.** Kafka, Temporal activities, k8s leases, ZK, and etcd all use heartbeats — but every one pairs heartbeats with an epoch/generation/session ID for fencing. Pure heartbeats reintroduce the time-threshold problem (Airflow-grade flakiness). Heartbeats answer "is this *still* alive?"; only an epoch answers "is this *the same incarnation*?"

---

## 3. Endorsed design

### 3.1 The invariant

**After controller boot reconciliation completes, every non-terminal `run.started` from a prior boot epoch MUST have a corresponding `run.abandoned` terminal event in the spine, for the same `run_id`. Current-epoch runs remain in-progress until they emit a terminal event or are reconciled by a future liveness mechanism.**

This is a property of the event log alone. It does not depend on `scheduler_run_history`, on process liveness signals, or on operator-supplied time thresholds.

**Scope note (post-review):** Boot-epoch reconciliation is a **startup recovery invariant, not a complete liveness detector.** It guarantees: after boot, no orphan from a previous incarnation remains. It does **not** guarantee: orphans introduced by within-boot hangs (child process deadlock with controller still alive) are terminated. The latter is the scope of a future heartbeat/timeout design — see §5.5. The architectural fact is that the runtime emits `run.failed` from `proc.on('close')` (`reference-implementation/runtime/index.js:1779`) when a child exits, so the *only* in-boot orphan path is a hung child whose controller hasn't given up on it. That gap exists today and is outside this brief's scope.

### 3.2 Two new event types

**`controller.booted`** — emitted as the first event of every process incarnation, after spine initialization but before any other emit:

```json
{
  "event_type": "controller.booted",
  "actor_type": "runtime",
  "actor_id": "controller",
  "data_json": {
    "epoch": "<uuid>",
    "seq": <monotonic integer>,
    "controller_id": "<stable controller identity>",
    "started_at": "<iso8601>",
    "process_info": {
      "node_version": "...",
      "git_sha": "...",
      "storage_backend": "postgres" | "sqlite"
    }
  }
}
```

- `epoch` is a UUID generated once per process start (identity).
- `seq` is `MAX(seq from prior controller.booted) + 1`. **This is monotonic only under the current single-controller assumption.** Two controllers booting concurrently can compute the same next seq. For a future multi-controller deployment, this would need a real DB sequence, advisory lock, or a sequence-allocating coordination point.
- `controller_id` is a stable identifier for the *controller deployment*, not the process incarnation. Default: the value of `PDPP_CONTROLLER_ID` env var if set, otherwise the container/host hostname (`os.hostname()`). Two controllers running side-by-side (accidental double-deploy, k8s rolling deploy overlap) have different `controller_id` values. **The reconciler only abandons orphans whose `controller_id` matches the current controller** (§3.4 query gains `AND data_json->>'controller_id' = $current_controller_id` to its predicate). This prevents a new controller from terminating a sibling controller's in-flight runs.
- `process_info` is intentionally minimal: fields that help debug a historical boot (versioning, backend). `pid` is omitted — PIDs aren't durable across hosts and add no audit value. `runtime_version` is omitted; in a monorepo it's derivable from `git_sha`.

**`run.abandoned`** — emitted by the boot-time reconciler for each orphaned `run.started`:

```json
{
  "event_type": "run.abandoned",
  "actor_type": "runtime",
  "actor_id": "<original connector_id>",
  "run_id": "<original run_id>",
  "data_json": {
    "caused_by_event_id": "<orphan's event_id>",
    "original_boot_epoch": "<uuid>",
    "original_controller_id": "<string, may be null for legacy>",
    "reconciled_by_boot_epoch": "<uuid>",
    "reconciled_by_seq": <int>,
    "reconciled_by_controller_id": "<string>",
    "source": "recovery_worker",
    "reason": "controller_terminated_before_run_finished"
  }
}
```

Rationale for the distinct event type (not `run.failed(reason=abandoned_at_boot)`):

> "Don't synthesize events the aggregate itself would never emit. Projections and downstream consumers may double-count or mis-attribute causation. Use a distinct event type so projections can treat recovery-emitted terminals differently."
>
> — paraphrased from Vernon's *Implementing Domain-Driven Design*, Microsoft's [Compensating Transaction Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/compensating-transaction), and [event-driven.io](https://event-driven.io/en/should_you_throw_exception_when_rebuilding_state_from_events/).

The `caused_by_event_id` field keys the reconciler's idempotency: re-running boot-time reconciliation produces the same single `run.abandoned` per orphan, not N of them.

### 3.3 Schema additions

**No structural change** to `spine_events`. The two new event types live in the existing schema; only the `event_type` enum (informal, by convention) grows.

The boot-epoch stamping on `run.started` lives in the existing `data_json` JSONB column:

```json
// run.started data_json (before)
{ "source": {...}, "trace_id": "...", ... }

// run.started data_json (after, additive)
{ "source": {...}, "trace_id": "...", "boot_epoch": "<uuid>", "seq": <int> }
```

**Field naming consistency:** the same two fields appear on `controller.booted.data_json` and `run.started.data_json`. Both use the names `boot_epoch` (UUID) and `seq` (monotonic integer). No `boot_seq` alias is introduced — readers always use `data_json->>'boot_epoch'` and `data_json->>'seq'`, regardless of which event type they're reading.

Adding a `boot_epoch` field to `data_json` is backwards-compatible: existing readers ignore it; new readers that need it can `WHERE data_json->>'boot_epoch'`.

**Stamping is enforced at the spine layer, not by convention.** `emitSpineEvent` (`reference-implementation/lib/spine.ts:387`) rejects any `run.started` whose `data_json` lacks `boot_epoch` and `seq`. The error is loud (`Error("emitSpineEvent: run.started requires boot_epoch; controller singleton not initialized?")`) and aborts the emit. Rationale: if a test fixture, import script, or future code path emits `run.started` outside the runtime's stamping wrapper, the brief's invariant would silently corrupt that run's identity (it would look prior-epoch forever and get re-abandoned every boot). Enforcing at the spine layer means stamping cannot be skipped accidentally.

### 3.4 The boot-time reconciler

In `startServer` (`reference-implementation/server/index.js:5648+`), after spine initialization and before scheduler/route mounting:

```
1. Generate boot_epoch_uuid = randomUUID()
2. controller_id = env.PDPP_CONTROLLER_ID || os.hostname()
3. boot_epoch_seq = (SELECT COALESCE(MAX((data_json->>'seq')::int), 0) + 1
                    FROM spine_events
                    WHERE event_type = 'controller.booted'
                      AND data_json->>'controller_id' = controller_id)
4. Emit controller.booted{epoch: boot_epoch_uuid, seq: boot_epoch_seq, controller_id, ...}
5. Store boot_epoch + controller_id in process-local module state (a singleton readable by emitters).
6. Reconcile orphans owned by THIS controller:
   SELECT s.event_id, s.run_id, s.actor_id, s.data_json
   FROM spine_events s
   WHERE s.event_type = 'run.started'
     AND (s.data_json->>'boot_epoch') IS DISTINCT FROM boot_epoch_uuid
     -- Defensive: only abandon orphans this controller owns.
     -- Legacy events lacking controller_id (NULL) are treated as this controller's
     -- (first-run migration semantics; safe under single-controller assumption).
     AND COALESCE(s.data_json->>'controller_id', controller_id) = controller_id
     AND NOT EXISTS (
       SELECT 1 FROM spine_events t
       WHERE t.run_id = s.run_id
         AND t.event_type IN ('run.completed', 'run.failed', 'run.cancelled', 'run.abandoned')
     )
     AND NOT EXISTS (
       SELECT 1 FROM spine_events r
       WHERE r.event_type = 'run.abandoned'
         AND (r.data_json->>'caused_by_event_id') = s.event_id
     );
7. For each orphan (from the SELECT result), emit run.abandoned in one transaction
   (idempotent on caused_by_event_id; enforced by §3.5 unique index;
    one row per orphan event_id regardless of run_id collisions, per §3.4 collision semantics).
```

`NOT EXISTS` is used throughout instead of `NOT IN` to avoid the classic `NOT IN (NULL)` footgun and to make the correlation explicit.

The `IS DISTINCT FROM` handles legacy `run.started` events without a `boot_epoch` field — those count as "from a different incarnation" because the only incarnation that could have written them is, by definition, not this one.

**Compatibility note:** `run.started` events without `boot_epoch` are treated as prior-epoch *only if they lack a terminal event*. Legacy starts with matching terminals are left unchanged — this design does not retroactively modify or abandon old completed runs.

The reconciler runs **once per boot, synchronously, before the server accepts requests**. SLVP property: the invariant holds at the moment the server begins serving.

**Reconciliation semantics on `run_id` collision:** the §3.4 query selects orphans by `event_id`, not by `run_id`. Two `run.started` events sharing the same `run_id` (legacy data quirk, test fixtures, copy-paste) are both candidates for abandonment. To make iteration deterministic — independent of transaction snapshot semantics — the reconciler runs as a **single `SELECT` followed by per-row `INSERT`s in one transaction**. The SELECT result is the authoritative list; the iteration emits exactly one `run.abandoned` per orphan `event_id`, regardless of `run_id` collisions. Result: two orphans sharing a `run_id` produce two `run.abandoned` events with different `caused_by_event_id` values.

**Hard boot barrier — mechanism, not just assertion:** the runtime mechanizes the barrier by *not mounting HTTP routes* until reconciliation has committed. Concretely: `startServer` builds the Fastify/Express app after step 6 completes; nothing serves traffic before then. Tests:

1. **Stamping test:** schedule a `run.started` emission immediately after `startServer()` returns; assert the event carries the current boot's `boot_epoch`.
2. **Barrier test:** issue a GET request to `/_ref/runs` while `startServer` is still inside the reconciliation phase (use a slow reconciler stub to make the window observable); assert the request either blocks until reconciliation completes or returns 503 / connection-refused. Either is acceptable; what's rejected is "the dashboard sees a half-reconciled state."

**Failure semantics:** if the reconciler throws a non-idempotency error (disk full, connection drop, transaction rollback), the boot **aborts**. The server does not start serving traffic. SLVP-correct: the invariant in §3.1 must hold at the moment traffic begins, so a reconciler that can't complete must prevent traffic. Operators should not wrap the reconciler call in `try/catch` swallow paths.

### 3.5 Database-enforced idempotency

The reconciler emits at most one `run.abandoned` per orphan `run.started`, keyed on `caused_by_event_id`. The brief enforces this at the database layer (not just convention) via a unique partial index on Postgres:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS spine_run_abandoned_cause_unique
  ON spine_events ((data_json->>'caused_by_event_id'))
  WHERE event_type = 'run.abandoned';
```

A second reconciler attempting to insert a duplicate `run.abandoned` for the same orphan will fail at INSERT (Postgres unique-violation). The runtime catches this **by matching the specific constraint name `spine_run_abandoned_cause_unique`** (Postgres `error.constraint` field) — not by catching all SQLSTATE 23505. Blanket-catching all unique-violations would mask unrelated constraint bugs (e.g., a future PK collision). On the matched constraint, the runtime treats it as a successful idempotent no-op.

SQLite supports expression partial indexes in v3.9+. If the SQLite version in production doesn't support it, the SQLite fallback is a transactional `NOT EXISTS` check immediately before the insert, in the same write transaction — equivalent to a unique index only under SQLite's single-writer serialization property (which holds for the reference implementation).

### 3.6 The verifiable invariant

A standards reviewer can run:

```sql
-- Verifier: the boot-epoch reconciliation invariant.
--
-- This query MUST return 0 after startServer's reconciler commits.
-- Running it during boot (before reconciliation completes) is not
-- meaningful — the answer is time-sensitive in that single window.
--
-- Single-controller assumption: this picks the most-recent controller.booted
-- by seq DESC. Multi-controller deployments have multiple current epochs
-- and need a per-controller variant of this query.
--
-- Pre-feature `run.started` events (no boot_epoch field) are intentionally
-- captured by the IS DISTINCT FROM predicate — their NULL boot_epoch
-- compares unequal to the current uuid, so they're treated as
-- prior-incarnation. See §3.4 compatibility note.
WITH current_epoch AS (
  SELECT data_json->>'epoch' AS epoch,
         data_json->>'controller_id' AS controller_id
  FROM spine_events
  WHERE event_type = 'controller.booted'
  ORDER BY (data_json->>'seq')::int DESC
  LIMIT 1
)
SELECT count(*) AS orphans
FROM spine_events s, current_epoch
WHERE s.event_type = 'run.started'
  AND (s.data_json->>'boot_epoch') IS DISTINCT FROM current_epoch.epoch
  AND COALESCE(s.data_json->>'controller_id', current_epoch.controller_id) = current_epoch.controller_id
  AND NOT EXISTS (
    SELECT 1 FROM spine_events t
    WHERE t.run_id = s.run_id
      AND t.event_type IN ('run.completed', 'run.failed', 'run.cancelled', 'run.abandoned')
  );
```

Note `ORDER BY (data_json->>'seq')::int DESC` — `seq` is the ordering authority, not `occurred_at`. Timestamps are useful metadata; the monotonic seq is the authoritative source for "which epoch is current."

The `controller_id` filter mirrors §3.4: under single-controller, the query verifies "no prior-epoch orphans for me." Under multi-controller, this query needs to be parameterized per controller — out of scope.

This query must return `0` immediately after `startServer` completes. It is:
- **Time-independent** — same answer at any point in this boot.
- **Schema-derivable** — readable from `spine_events` alone, no side tables.
- **Audit-friendly** — Linux-Foundation reviewer can run it and judge correctness from the result.

This becomes a new check in the Stage 6 `migrate-storage verify` invariant suite.

### 3.7 Dashboard consequence

`apps/web/src/app/dashboard/lib/rs-client.ts:895` currently:

```ts
const RUNNING_STATUSES = new Set(["started", "in_progress"]);
```

After this change, `run.abandoned` projects to `status: "abandoned"`, which is **terminal** (not in `RUNNING_STATUSES`). The dashboard displays orphans as having ended, with reason "controller_terminated_before_run_finished" surfaced in the detail view.

Stream display.detail authorship principle is preserved: the abandoned-reason text is **runtime-authored**, not client- or connector-authored. The `reason` field on `run.abandoned.data_json` is mandatory and constrained to the recovery worker's vocabulary.

**Centralize the terminal-event-types set (testable amendment).** Any consumer with a hardcoded `["run.completed", "run.failed", "run.cancelled"]` set will silently miss `run.abandoned` until updated. The rollout MUST grep for all of these strings and update each. Known consumers to audit:

- `reference-implementation/lib/spine.ts:660` — `RUN_TERMINAL_EVENT_TYPES`.
- `reference-implementation/runtime/controller.ts:776` — existing reconciler's terminal-set query.
- `reference-implementation/server/db.js:1008` — Spine index predicate filter (`WHERE event_type IN (...)`).
- `apps/web/src/app/dashboard/lib/rs-client.ts:895` — `RUNNING_STATUSES`.
- The new `migrate-storage verify` invariant query (§3.6).
- Any sync/export endpoint exposing run lifecycle.
- Any metrics endpoint computing success/failure/cancelled totals.
- Tests asserting exactly three terminal statuses.

The implementation plan (§6) ends with a verification commit that adds a test fixture emitting `run.abandoned` and asserts every consumer treats it as terminal.

---

## 4. Why this is SLVP-ideal

**Simplicity:**
- One new field on existing events (`boot_epoch`).
- Two new event types using the existing schema.
- One synchronous boot-time function (~30 lines, single SQL query + per-row emit).
- No background workers, no thresholds, no clock synchronization, no side tables.

**Losslessness:**
- The orphan `run.started` is preserved (append-only).
- The synthetic `run.abandoned` carries explicit provenance (`source`, `original_boot_epoch`, `caused_by_event_id`).
- The full incarnation history is reconstructible from `controller.booted` events alone.
- Re-running reconciliation is a no-op (idempotent on `caused_by_event_id`).

**Verifiability:**
- The SQL invariant above returns the same value regardless of when queried.
- A reviewer can construct the test (rotate epoch, observe orphans get reconciled) without mocking time.
- Boot-epoch presence on `run.started` and `run.abandoned`'s causal link can be unit-tested directly.

---

## 5. Resolved design questions (formerly open)

The original draft listed five open questions. The external SLVP review resolved each. Recorded here for traceability.

### 5.1 UUID vs monotonic integer for `boot_epoch`

**Resolved: keep both.** UUID for identity, monotonic integer for ordering. Reviewer caveat: `MAX(seq)+1` is **single-controller only** — two concurrent boots could compute the same next seq. The brief's wording (§3.2) now explicitly states this limitation rather than implying future-proof readiness.

### 5.2 Process fingerprint contents

**Resolved: trim.** Drop `pid` (not durable across hosts). Keep `node_version`, `runtime_version`, `git_sha`, `storage_backend`. Only fields that help debug a historical boot belong here.

### 5.3 Event-type name

**Resolved: `run.abandoned`.** Acceptable. The reviewer's concern that "abandoned" could imply voluntary connector action is mitigated by the mandatory `source: "recovery_worker"` and `reason: "controller_terminated_before_run_finished"` fields on the event payload. The reason field stays mandatory.

### 5.4 Summary event after reconciliation

**Resolved: skip.** Derivable from per-orphan events:
```sql
SELECT count(*) FROM spine_events
WHERE event_type = 'run.abandoned'
  AND data_json->>'reconciled_by_boot_epoch' = :epoch;
```
A separate summary event creates a second count that can drift. If future boot diagnostics need it, add it then.

### 5.5 Heartbeat augmentation

**Resolved: defer with sharp framing.** This brief solves **crash/restart orphans**. It does **not** solve **same-boot hung runs**. The architectural fact is that the runtime emits `run.failed` from `proc.on('close')` (`runtime/index.js:1779`) when a child exits, so the in-boot orphan case requires a child that's hung *and* a controller that hasn't given up — a gap that exists today and is not regressed by this design. A future heartbeat/timeout design with its own SLVP review will close that gap. The invariant in §3.1 is scoped accordingly: "after boot reconciliation completes" — not "for all time."

### 5.6 Invariant scope (new, raised by reviewer)

**Resolved: narrowed.** The original invariant overreached ("every run.started must eventually have a terminal"). The corrected invariant in §3.1 covers only prior-epoch orphans after boot reconciliation. Current-epoch runs remain in-progress until they terminate. This is the honest statement of what boot-epoch reconciliation actually guarantees.

---

## 6. Verdict (after two rounds of review)

**Approved as implementation contract.** The core architecture is right: boot-epoch + compensating terminal event + event-log-only invariant is the correct fix for migrated/crashed orphan runs. Amendments incorporated across two review rounds (see §9 for the full change log):

1. **Invariant narrowed** to prior-epoch orphans after boot. Same-boot hung runs explicitly out of scope (§3.1, §5.5).
2. `NOT EXISTS` throughout; `seq`-based ordering (§3.4, §3.6).
3. `MAX(seq)+1` documented as **single-controller only** (§3.2, §8).
4. **Database-enforced idempotency** via named unique partial index `spine_run_abandoned_cause_unique` (§3.5). Constraint catch matches the name, not all 23505.
5. **Hard boot barrier as a mechanism** (HTTP routes not mounted until reconciler commits), with a real race-condition test (§3.4, Stage 5).
6. **Spine-layer stamping enforcement**: `emitSpineEvent` rejects unstamped `run.started` (§3.3).
7. **`seq` is the single field name** across both `controller.booted` and `run.started` event types. No `boot_seq` alias (§3.3).
8. **`controller_id` field for multi-controller safety** (env var or hostname). The reconciler only abandons orphans whose `controller_id` matches the current controller, preventing a new controller from terminating a sibling's in-flight runs in an accidental double-deploy (§3.2, §3.4).
9. **`run_id` collision semantics explicit**: one `run.abandoned` per orphan `event_id`, single SELECT-then-INSERT transaction (§3.4).
10. **Reconciler failure aborts boot** explicitly; no try/catch wrapping (§3.4, Stage 6).
11. **Verifier SQL annotated** with validity preconditions and single-controller scope (§3.6).
12. Process fingerprint trimmed: `node_version`, `git_sha`, `storage_backend` only (§3.2).
13. **Centralized terminal-event-types set** with explicit consumer audit (§3.7).
14. `controller.reconciliation_completed` summary event deferred (derivable from per-orphan events).

## 7. Implementation plan (staged commits)

Modeled on the binary-content invariant rollout.

### Stage 1 — Design brief (this document)

Lands first.

### Stage 2 — External SLVP review

Done. Amendments incorporated; see §6.

### Stage 3 — Spine event-type registration, stamping enforcement, unique index

- Add `controller.booted` and `run.abandoned` to spine event-type schemas. Update any spine-event Zod schema (if present) and the `RUN_TERMINAL_EVENT_TYPES` set in `reference-implementation/lib/spine.ts:660`.
- **Spine-layer stamping enforcement:** `emitSpineEvent` (`reference-implementation/lib/spine.ts:387`) rejects `run.started` whose `data_json` lacks `boot_epoch` or `seq`. Error message names the missing field.
- Add the Postgres unique partial index `spine_run_abandoned_cause_unique` on `(data_json->>'caused_by_event_id') WHERE event_type = 'run.abandoned'`. Add the SQLite equivalent (expression partial index v3.9+; transactional `NOT EXISTS` check fallback otherwise).
- Tests:
  - Events round-trip through `emitSpineEvent` / `listSpineEventsPage`.
  - `emitSpineEvent({event_type: 'run.started', data_json: {}})` rejects with the loud error.
  - Duplicate `run.abandoned` for the same `caused_by_event_id` fails at the DB layer with the **named** constraint `spine_run_abandoned_cause_unique` (not just any 23505).

### Stage 4 — Stamp `boot_epoch` and `seq` on `run.started`

The runtime emits `run.started` in `reference-implementation/runtime/index.js:1063`. Add `boot_epoch` and `seq` to the `data_json`, read from the controller singleton (Stage 5). Test: every emitted `run.started` carries the fields and they match the controller's recorded boot.

### Stage 5 — `controller.booted` emission + hard boot barrier

In `startServer` (`reference-implementation/server/index.js:5648+`), after `initPostgresStorage` succeeds and *before HTTP routes are mounted*, emit `controller.booted` and stash `{boot_epoch, seq, controller_id}` in process-local state. The HTTP app must not be served until Stage 6's reconciler commits.

Tests:
- Every server boot emits exactly one `controller.booted`; `seq` increments monotonically across boots; `controller_id` matches `PDPP_CONTROLLER_ID` or `os.hostname()`.
- **Stamping test:** schedule a `run.started` emission immediately after `startServer()` returns; assert the event carries the current boot's `boot_epoch`.
- **Boot-barrier test:** install a slow-reconciler stub that takes ≥200ms; issue a GET to `/_ref/runs` while the boot is mid-reconciliation; assert the request either blocks until the boot completes or returns 503/connection-refused. The test fails if the dashboard sees a half-reconciled state.

### Stage 6 — Boot-time abandoned-run reconciler

The new function `reconcileOrphanedRuns()` lives next to the existing `reconcileAbandonedControllerRuns` in `reference-implementation/runtime/controller.ts:780-830`. Called from `startServer` after `controller.booted` lands. Implementation:
- One `SELECT` for orphan candidates (per §3.4 step 6 query).
- One transaction containing per-row `INSERT`s of `run.abandoned`.
- Constraint violation on `spine_run_abandoned_cause_unique` → treat as idempotent no-op (matched by constraint name).
- Any other error → propagate up; boot aborts.

Tests:
- Zero orphans after boot.
- Idempotent: second call emits no additional events; named-constraint violation caught as no-op; other unique violations re-raised.
- Preserves orphan events (append-only).
- **Run_id collision:** seed two `run.started` events with the same `run_id` but different `event_id`, both lacking terminals; assert the reconciler emits **two** `run.abandoned` events with different `caused_by_event_id` values, regardless of iteration order.
- Cross-boot: emit orphan in boot 1, reconcile in boot 2, verify `original_boot_epoch` and `original_controller_id` populated correctly.
- **Multi-controller isolation:** emit orphan from controller A (controller_id="A"); boot controller B (controller_id="B"); assert controller B's reconciler does NOT abandon controller A's orphan.
- **Reconciler failure aborts boot:** stub a transient DB error mid-reconciliation; assert `startServer` rejects and the server does not accept traffic.

### Stage 7 — Dashboard status projection + terminal-set audit

Update `apps/web/src/app/dashboard/lib/rs-client.ts:895`:

```ts
const RUNNING_STATUSES = new Set(["started", "in_progress"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "abandoned"]);
```

Update `projectRun` to map `run.abandoned` → `status: "abandoned"`. Update connector-row display label ("Abandoned · N ago").

**Terminal-set audit (rollout requirement):** grep the entire codebase for hardcoded `["run.completed", "run.failed", "run.cancelled"]` patterns and update each. Known sites per §3.7. Add a test fixture emitting `run.abandoned` that asserts every projection / endpoint / metric treats it as terminal.

### Stage 8 — Verifier extension

Add the no-orphans invariant SQL from §3.6 as a fourth check in `migrate-storage verify` (`reference-implementation/scripts/migrate-storage/cli.mjs:verifyBinaryContentInvariant`). Document in `reference-implementation/docs/migrate-storage.md`.

### Stage 9 — Reconcile legacy orphans

After the runtime fix is in place: restart the reference container against the migrated Postgres. Verify the new boot's reconciler emits 12 `run.abandoned` events (one per known legacy orphan). Confirm the SQL invariant returns 0 and the dashboard shows 0 Running.

---

## 8. Out of scope

- **Heartbeat-based liveness detection.** Same-boot hung-child orphans are out of scope. See §5.5.
- **Multi-controller deployments.** `seq` provides intra-incarnation ordering only; concurrent boots could collide on `MAX(seq)+1`. Real multi-controller support requires a DB sequence or advisory lock — not in this brief.
- **`scheduler_run_history` cleanup.** The legacy reconciler in `controller.ts:780-830` continues to work; this brief is additive.
- **Schema migration of `spine_events`.** No structural change is required — `boot_epoch` is a new field in `data_json` (additive JSONB). The only DB addition is the unique partial index from §3.5.

---

## 9. Change log

Two review rounds informed this brief.

### Round 1: Initial expert review

| Original | Revised |
|---|---|
| Invariant "every `run.started` must eventually have a terminal event" | Invariant scoped to **prior-epoch orphans after boot reconciliation completes** (§3.1). Same-boot hung runs declared out of scope. |
| `run_id NOT IN (...)` in reconciliation SQL | **`NOT EXISTS`** with explicit correlation, throughout (§3.4, §3.6). |
| Current epoch ordered by `occurred_at` | Current epoch ordered by `(data_json->>'seq')::int DESC` (§3.6). `seq` is the ordering authority. |
| `seq` framed as multi-controller-ready | `seq` framed as **single-controller monotonic only** (§3.2, §8). |
| `caused_by_event_id` idempotency by convention | **Database-enforced** via unique partial index (§3.5). |
| `process_info: { node_version, pid }` | Trimmed: `node_version`, `git_sha`, `storage_backend`; `pid` and `runtime_version` dropped (§3.2). |
| Boot ordering described in prose | **Hard boot barrier** with explicit test in Stage 5 (§3.4, §7). |
| Terminal-event-types update mentioned in passing | **Centralized terminal-set audit** with explicit consumer list (§3.7) and end-of-rollout verification test. |
| 5 open questions for reviewer | All resolved; recorded in §5. |

### Round 2: Adversarial review against scenarios

A second independent reviewer stress-tested the design against ten failure scenarios. Eight real issues found, all incorporated:

| Issue | Resolution |
|---|---|
| `seq` (in `controller.booted`) vs `boot_seq` (in `run.started`) — same concept, two names | **Unified to `seq`** in both event types (§3.2, §3.3). |
| Stamping enforcement only by convention | **`emitSpineEvent` rejects unstamped `run.started` loudly** (§3.3). |
| `run_id` collision semantics ambiguous | **Explicit: one `run.abandoned` per orphan `event_id`, single SELECT-then-INSERT transaction** (§3.4). |
| Boot barrier asserted, not mechanized | **Barrier mechanism: HTTP routes not mounted until reconciliation commits; testable via slow-reconciler stub + race-condition GET** (§3.4, Stage 5). |
| Blanket unique-violation catch fragile | **Catch specifically by constraint name `spine_run_abandoned_cause_unique`** (§3.5). |
| Multi-controller silent corruption: new controller would abandon sibling's runs | **Added `controller_id` field** (env var or hostname); reconciler only abandons orphans whose `controller_id` matches; multi-controller isolation test added (§3.2, §3.4, Stage 6). |
| Verifier SQL missing validity comments | **Added comments** stating "run after startServer commits," single-controller assumption, NULL `boot_epoch` semantics (§3.6). |
| Reconciler failure semantics unspecified | **Explicit: reconciler failure aborts boot. Operators must not wrap in try/catch swallow paths** (§3.4, Stage 6). |

---

---

## Appendix A: file-tree references

- `reference-implementation/lib/spine.ts:387` — `emitSpineEvent` entry point.
- `reference-implementation/lib/spine.ts:660` — `RUN_TERMINAL_EVENT_TYPES` set (to extend).
- `reference-implementation/runtime/index.js:1063` — `run.started` emission site.
- `reference-implementation/runtime/controller.ts:780-830` — existing abandoned-run reconciler (reads from `scheduler_run_history`).
- `reference-implementation/server/index.js:5648+` — `startServer` boot sequence.
- `reference-implementation/server/db.js:498-528` — SQLite `spine_events` schema.
- `reference-implementation/server/postgres-storage.js:478-514` — Postgres `spine_events` schema.
- `apps/web/src/app/dashboard/lib/rs-client.ts:895` — `RUNNING_STATUSES` set (dashboard projection).
- `reference-implementation/scripts/migrate-storage/cli.mjs` — `verifyBinaryContentInvariant` (extend with no-orphans check).

## Appendix B: glossary

- **Spine** — the disclosure event log; `spine_events` table.
- **Run** — one execution of a connector. Identified by `run_id`.
- **`run.started` / `run.completed` / `run.failed` / `run.cancelled`** — the four existing run-lifecycle event types.
- **`controller.booted`** — the new event type emitted as the first event of every process incarnation. Carries the boot epoch.
- **`run.abandoned`** — the new event type the boot-time reconciler emits for orphaned `run.started` events.
- **`boot_epoch`** — UUID identifying a single process incarnation. Stamped on every `run.started` emitted during that incarnation. Bound by analogy to PostgreSQL `pg_control.TimelineID`, Kafka producer epoch, systemd `_BOOT_ID`.
- **`seq`** — monotonic integer paired with `boot_epoch` on both `controller.booted` and `run.started` events. Supports ordering ("is this epoch newer than that one?"). Single-controller monotonic only; multi-controller deployments need additional coordination.
- **`controller_id`** — stable identifier for the controller deployment (from `PDPP_CONTROLLER_ID` env var or `os.hostname()`). Distinguishes sibling controllers in a multi-controller deployment; prevents one controller from abandoning another's in-flight runs.
- **Orphan** — a `run.started` event without a matching terminal event in the same `run_id`.
- **SLVP** — Simplest Lossless Verifiable Path. The quality bar; see `docs/binary-content-invariant-design-brief.md` for the full definition.
- **Fencing token** — Kleppmann's term for `boot_epoch`-style identity.
- **Compensating event** — the event-sourcing literature's name for a synthetic terminal event appended after the fact (e.g., `run.abandoned`).
