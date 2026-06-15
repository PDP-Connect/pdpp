# SLVP-Ideal Design: Preventing a Stuck/Hung Job Run from Permanently Wedging a Single-Flight System

**Date:** 2026-06-14  
**Context:** PDPP reference-implementation runtime — `reference-implementation/runtime/controller.ts`  
**Question:** What is the SLVP-ideal design for tracking "is this run still active?" so a hung run self-heals and never blocks future runs, WITHOUT ever double-dispatching a genuinely-live run?

---

## 1. Problem Statement

The PDPP reference implementation enforces a single-flight invariant per connection: at most one `runNow` can be active at a time. The 409 `run_already_active` guard reads from an **in-memory `Map<string, ActiveRun>`** called `activeRuns`. Cleanup — deleting from the map and from the `controller_active_runs` DB table — runs in the run promise's `.finally()` chain.

**The bug (proven live):** if the connector subprocess hangs (never resolves or rejects), `.finally()` never fires. The `activeRuns` entry leaks permanently. All subsequent `runNow` calls for that connection return 409 forever — until process restart. Because the system advertises "manual run-now" as recovery for a stalled scheduled connector, one wedged run makes manual recovery impossible too.

There is no watchdog. There is a parallel `controller_active_runs` DB table, but the 409 guard reads only the in-memory map; the DB row is not checked for staleness.

**A fix was drafted:**
1. A per-run wall-clock watchdog (default 1h, env-overridable, Infinity-disable): if the run exceeds its budget, force-finalize (emit `run.failed run_timed_out`, clear map + DB, abort subprocess).
2. Stale-entry reconciliation at the 409 guard: if the existing entry's promise has already settled, or it is over-budget, reclaim it and proceed instead of 409-ing.

This document assesses whether that drafted fix is the SLVP-ideal design.

---

## 2. Prior Art

### 2.1 Temporal: StartToClose Timeout vs. Heartbeat Timeout

Temporal is the most deeply-designed prior art for this exact problem. It distinguishes three orthogonal timeouts for a long-running Activity:

- **ScheduleToStart Timeout** — time from scheduling to worker pickup.
- **StartToClose Timeout** — maximum wall-clock duration of a single Activity task execution (one attempt). This is the hard ceiling. If the worker hangs, the Temporal server detects the missing heartbeat (or deadline expiry) and fails the task.
- **Heartbeat Timeout** — maximum allowed silence between `RecordHeartbeat` calls. The worker must periodically ping the Temporal service during long work. If the worker stops heartbeating (hung, crashed, GC paused), this timeout fires within seconds/minutes rather than hours.

**Key Temporal insight:** StartToClose is a ceiling ("this run can't take longer than X even if heartbeating"), while Heartbeat is a *liveness detector* ("if the worker goes silent for Y seconds, presume dead now"). Temporal's own documentation recommends setting both for long-running activities: the Heartbeat timeout for fast failure detection, StartToClose as the hard overall cap.

Sources:  
- https://docs.temporal.io/encyclopedia/detecting-activity-failures (StartToClose, Heartbeat sections)  
- https://docs.temporal.io/activities#heartbeat-timeout

Temporal heartbeats are throttled by the SDK (at most every `heartbeatTimeout * 0.8` seconds to avoid flooding); the final heartbeat before failure is always delivered immediately.

### 2.2 Sidekiq (Pro): Process Heartbeat + Orphan Reaper

Sidekiq's `super_fetch` uses two mechanisms:

1. **Worker heartbeat** — every Sidekiq process sends a heartbeat to Redis every few seconds (heartbeat expires after 60 seconds). A process is considered dead when its heartbeat has expired.
2. **Orphan reaper** — on startup (and hourly via a full SCAN), `super_fetch` finds jobs in "working" private queues whose *owning process heartbeat has expired*, and re-enqueues them. Timing guarantee: "might recover in 5 minutes or 3 hours, there's no guarantee. Restarting a process is the best way to signal Sidekiq Pro to look for orphans."

Source: https://github.com/sidekiq/sidekiq/wiki/Reliability

**Key Sidekiq insight:** the reaper uses *process-level* liveness (heartbeat), not job-level timeouts. An orphaned job is detected when its worker's heartbeat dies, not when the job itself exceeds a wall clock limit. This is a reaper pattern, not a per-job watchdog.

### 2.3 Kubernetes Jobs: activeDeadlineSeconds

Kubernetes Jobs provide `spec.activeDeadlineSeconds` — a hard wall-clock ceiling for the entire Job. Once exceeded, all running Pods are terminated and the Job status becomes `Failed` with reason `DeadlineExceeded`. This takes precedence over `backoffLimit`.

Source: https://kubernetes.io/docs/concepts/workloads/controllers/job/#job-termination-and-cleanup

**Key k8s insight:** pure wall-clock deadline — no heartbeat involved. The controller (apiserver + job-controller) is external to the job itself and has its own persistent state. The job's "liveness" is tracked by the control plane, not by the job process.

### 2.4 AWS Step Functions: HeartbeatSeconds

Step Functions Tasks support `HeartbeatSeconds` — if the task integration does not call `SendTaskHeartbeat` within that window, the Task state fails with `States.HeartbeatTimeout`. There is also a `TimeoutSeconds` (hard ceiling). The task token (`GetActivityTask`) is issued to exactly one worker; the workflow only advances on `SendTaskSuccess` or `SendTaskFailure`.

Source: https://docs.aws.amazon.com/step-functions/latest/dg/concepts-amazon-states-language.html  
Prior-art corpus: "Step Functions task token is the strictest form: GetActivityTask vends a token to exactly one worker, workflow only advances on token return."

**Key Step Functions insight:** the liveness decision is made by a durable, external state machine. The worker cannot be its own judge.

### 2.5 Celery: Visibility Timeout

Celery's Redis broker uses a visibility timeout: a claimed task becomes reclaimable to another worker if not acknowledged within the window. The Celery documentation explicitly warns: **if any task runs longer than the visibility timeout, it will be delivered twice**. The lesson: if you use pure wall-clock timeouts (rather than heartbeats), the timeout must exceed your worst-case task duration, or tasks will double-dispatch.

Source: https://docs.celeryq.dev/en/stable/userguide/configuration.html#visibility-timeout  
Celery config: `broker_transport_options = {'visibility_timeout': 18000}` (5 hours example)

**Key Celery insight:** visibility timeout = "lease must be longer than the task" OR "task must heartbeat to extend the lease." Celery favors wall-clock timeout set generously over any heartbeat mechanism.

### 2.6 Kleppmann: Fencing Tokens and the Double-Dispatch Problem

Martin Kleppmann's "How to do distributed locking" (https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) is the canonical statement of the double-dispatch hazard:

- A process can acquire a lock, go into a long GC pause (or be descheduled by the OS), have its lease expire, and another process takes over. When the first process resumes, it doesn't know its lease expired.
- The fix is **fencing tokens**: a strictly monotonically increasing integer issued by the lock service each time a lock is acquired. Every write to the storage layer includes the token; the storage layer **rejects writes with a token lower than the last seen token**.
- Kleppmann's conclusion: if locks are for *correctness* (not just efficiency), you need fencing tokens. Pure TTL-based locks are insufficient because a paused process can violate the exclusive-access invariant after the TTL.

Kleppmann draws the distinction:
> "If you need locks only on a best-effort basis (as an efficiency optimization, not for correctness), I would recommend sticking with the straightforward single-node locking algorithm for Redis. If you need locks for correctness, please don't use Redlock. Instead, please use a proper consensus system."

Redis's own distributed lock documentation (Redlock) explicitly recommends implementing fencing tokens for correctness-critical applications: https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/

### 2.7 GoodJob: PostgreSQL Advisory Locks

GoodJob (Rails background job library) uses PostgreSQL advisory locks for job ownership. The advantage: advisory locks are session-scoped — if the process dies, the session ends and the advisory lock is automatically released. This is crash-safe liveness tracking without a heartbeat: the *database connection itself* is the heartbeat.

Source: https://github.com/bensheldon/good_job

**Key GoodJob insight:** using a connection-scoped lock as the liveness token means no explicit heartbeat is needed. The process being alive = the DB connection being alive = the lock being held. Crash-safe by construction.

---

## 3. The Four Dimensions of the Verdict

### Dimension A: Wall-Clock Timeout vs. Heartbeat (or Both?)

**What leading systems do:**
- Temporal: **both** — a Heartbeat Timeout for fast failure detection (detects "worker is hung" within the heartbeat interval) AND a StartToClose Timeout as a hard ceiling.
- Kubernetes Jobs: wall-clock only (`activeDeadlineSeconds`), but the controller is external and durable.
- Celery: wall-clock only, but the timeout must exceed worst-case task duration to avoid double-delivery.
- Step Functions: heartbeat within a hard outer timeout.
- Sidekiq: process-level heartbeat (not per-job wall-clock).

**For PDPP specifically:**

The connector subprocess is a black box — the controller cannot inject heartbeat calls into it without changing connector contracts. This rules out a Temporal-style per-run heartbeat unless a sidecar protocol is added. What the controller *can* do is set a wall-clock watchdog timer and abort the subprocess if it fires.

YNAB reconciles ~22k records in a legitimate run. A 1h wall-clock cap may be tight if runs routinely take 45+ minutes. The drafted fix makes this env-overridable with `Infinity`-disable, which is pragmatically correct.

**Verdict for PDPP:** A wall-clock watchdog is the right and sufficient mechanism *for this architecture*. A heartbeat would require a connector protocol change (connectors would need to emit periodic liveness signals), which is a bigger scope change. The wall-clock approach with a generous, overridable default (e.g., 2h rather than 1h, with `Infinity`-safe escape hatch) is SLVP-appropriate.

The missing element in the drafted fix: the watchdog timer fires, aborts the subprocess, and clears the map. But if the node event loop itself is hung (not just the subprocess), the `setTimeout` callback will never fire. This is a pathological edge case for a Node.js process, and it makes the subprocess-kill-based watchdog the pragmatic ceiling for a reference implementation. A separate **reaper** on process startup (see Dimension D) handles the restart-after-crash scenario.

### Dimension B: In-Memory Map vs. DB Lease as Source of Truth

**Current design:** `activeRuns` Map is the 409 source of truth. `controller_active_runs` DB table is populated in parallel but NOT read by the 409 guard. The DB row is deleted in `.finally()`.

**The anti-pattern:** In-memory-map-as-source-of-truth is exactly the design that causes the originally reported bug AND the restart problem. If the process crashes, the in-memory map is lost and the 409 guard has no stale state to read — BUT the DB `controller_active_runs` table still has the row from the crashed run, which now can never be cleaned up by that process's `.finally()`.

In the *absence of a crash*, the in-memory map is actually fine: it's consistent, fast, and the DB is a parallel write for external observability only. The problem is only:

1. **Hung subprocess:** `.finally()` never fires → map entry leaks in-process.
2. **Process crash:** map is destroyed → DB row leaks across restart → the 409 guard doesn't read the DB row, so there's no false 409 after restart. But the DB table has a zombie row that could confuse reconciliation logic.

**What the best systems do:** GoodJob uses DB-connection-scoped advisory locks (crash-safe by construction). Temporal's service is itself durable. Sidekiq writes heartbeats to Redis. The pattern: **durable external state** (DB, Redis) as the source of truth, with the in-process map as a cache/fast-path.

**SLVP-ideal for PDPP:**

Given the system is already single-process (one Node.js server, one SQLite or Postgres DB), the cleanest upgrade is:

- Keep the in-memory map as the fast path (it's already there, and it's correct for the running-process case).
- On startup: read any rows from `controller_active_runs` that were NOT cleaned up (i.e., they belong to this process's prior session or to a previous crash), emit `run.failed run_timed_out` for each, and delete them. This is a **startup reaper** (see Dimension D).
- The 409 guard stays as the in-memory map — there is no false positive from the DB after the startup reaper clears stale rows.

The drafted fix's stale-entry reconciliation (checking `promise.settled` in the 409 guard) is a valid in-process fix but does NOT survive a crash-and-restart scenario. After restart, `activeRuns` is empty — no false 409. The zombie DB rows remain but don't cause 409s. So the crash case is benign for the 409 guard, but the zombie DB rows are a correctness debt (misleading observability, potential future guard issues).

**Verdict:** The in-memory map as the 409 source of truth is ACCEPTABLE for a single-process reference implementation, provided the watchdog timer correctly force-finalizes hung runs within the same process. The DB row is a secondary concern. A startup reaper that sweeps `controller_active_runs` for orphan rows (from prior crashes) makes the system fully restart-safe.

### Dimension C: Fencing Tokens / Run-Generation to Prevent Double-Dispatch of a Zombie

**The double-dispatch scenario:**

1. Run A starts, gets a run_id. Process hangs. Watchdog fires at T+1h, reclaims the slot, starts Run B.
2. If Run A's subprocess was not actually killed (e.g., watchdog used a soft signal that was ignored), Run A continues executing and committing spine events.
3. Run B also commits spine events. Two runs write to the same stream for the same connection simultaneously.

**Does the drafted fix prevent this?**

The drafted fix aborts the subprocess (AbortController signal) when the watchdog fires. If the subprocess is a child process, it can be killed with `SIGKILL`. If the subprocess ignores the signal (impossible with SIGKILL, possible with SIGTERM), there is a brief double-execution window.

**Is a fencing token needed?**

Kleppmann's fencing token argument is specifically for *distributed* settings where network partitions can cause a paused client to resume and think it still holds the lock. In a **single-process** system:

- The run-promise's identity is held in the in-memory map. If the watchdog reclaims it and starts a new run, the old promise is still running (until killed). But the old promise's write path (connector subprocess → spine events) goes through the same process and DB — there is no network partition between the old "zombie" run and the storage layer.
- `SIGKILL` on the subprocess guarantees the subprocess is dead. After kill, the zombie cannot write.
- The controller itself (in Node.js) won't double-write because the old promise is abandoned (not awaited), and Node.js is single-threaded — the watchdog runs cleanup synchronously before the new run begins.

**However:** if the connector subprocess uses a shared file descriptor, DB connection, or socket that the controller holds open *across* the kill-and-restart boundary, and if the subprocess somehow survived (SIGTERM, not SIGKILL), there is a brief race. This is pathological for a reference implementation using `child_process.spawn`.

**Verdict:** A fencing token (monotonic run-generation number stamped on spine events and checked at write) would be SLVP-ideal in a distributed or multi-process system. For a **single-process reference implementation** with `SIGKILL` semantics on the subprocess, a fencing token is NOT strictly required — the subprocess kill is the fence. However, adding a `run_generation` counter to `controller_active_runs` costs little and provides:

1. An audit trail (which generation reclaimed a slot).
2. Insurance against edge cases (SIGTERM instead of SIGKILL, slow subprocess exit).
3. Forward-compatibility if the system ever becomes multi-process.

The recommendation: store a monotonic `run_generation` in `controller_active_runs` at registration; include `run_id` in all spine events (already done); reject spine-event writes where `run_id` doesn't match the current `activeRuns[key].run_id`. This is lightweight and closes the zombie double-write class entirely.

### Dimension D: Per-Run Watchdog Timer vs. Periodic Reaper Sweep

**Tradeoffs:**

| Approach | Pros | Cons |
|---|---|---|
| **Per-run watchdog timer** (drafted fix) | Fires precisely at deadline; no polling overhead; reacts within the same process/event loop | Dies with the process (crash = stale entry); requires the event loop to be alive to fire |
| **Periodic reaper sweep** | Survives crashes (runs after restart); can reclaim entries from any past session; independent of run liveness within the process | Has worst-case latency = sweep interval; more moving parts (a separate timer loop) |

**What the best systems do:**

- Sidekiq: process-level heartbeat (external) + reaper sweep on startup and hourly.
- GoodJob: DB-session-scoped lock (crash-safe by design — no reaper needed).
- Kubernetes: controller-loop (external, always-on).
- Temporal: durable service with external scheduling.

The pattern: the best systems use a **startup reaper** (clear state from dead sessions) plus a **runtime watchdog** (bound the duration of live runs). They are complementary, not alternatives.

**For PDPP:**

- The **per-run watchdog** (drafted fix) is correct for the hung-subprocess case. It fires in-process and reclaims the slot quickly (within the watchdog window, default 1h).
- The **startup reaper** is needed for the crash case: on `createController()` initialization, sweep `controller_active_runs` for any rows that belong to this process (or any process) that are now stale (created_at older than the watchdog window), emit `run.failed run_timed_out` for each, and delete them. This is a one-time O(n) operation on startup where n is typically 0 or 1.

**Verdict:** Both are needed. The drafted fix adds the watchdog (good); it should also add a startup sweep of `controller_active_runs`. These are complementary and neither is sufficient alone.

---

## 4. Assessment of the Drafted Fix

### What the drafted fix does:
1. **Wall-clock watchdog** (default 1h): fires `setTimeout`, aborts subprocess, emits `run.failed run_timed_out`, clears `activeRuns` map and DB row.
2. **Stale-entry reconciliation at the 409 guard**: if `existing.promise` has settled (or if `existing.startedAt` + watchdog budget has elapsed), reclaim and proceed.

### What it gets right:
- Closes the primary bug: a hung subprocess no longer leaks the `activeRuns` entry permanently.
- Env-overridable timeout (Infinity-safe): correct for legitimately long runs.
- Emitting `run.failed run_timed_out` before clearing is honest (the run IS timed out, it IS a failure).
- AbortController abort propagates to the subprocess.
- Stale-entry reconciliation in the 409 guard adds defense-in-depth if the watchdog timer fires between the promise settling and the `.finally()` completing (a micro-race).

### Gaps vs. SLVP-ideal:

**Gap 1 (CRITICAL): No startup reaper.** If the process crashes while a run is active, the in-memory map is destroyed. After restart, there is no false 409 (the map is empty), but `controller_active_runs` has a zombie row. Nothing in the drafted fix sweeps this row on startup. Operationally benign for 409 (the map is empty, no false 409), but the zombie DB row is misleading and could interfere with future reconciliation logic. **Fix: add a startup sweep in `createController`.**

**Gap 2 (MODERATE): No run-generation / fencing.** The watchdog kills the subprocess and starts a new run. If the subprocess used SIGTERM (not SIGKILL) and survived briefly, it could continue writing spine events for a few milliseconds while the new run also starts. For a reference implementation with `child_process.spawn` and `SIGKILL`, this is theoretical — but a monotonic `run_generation` on `controller_active_runs` with a write-check at the spine-event commit point would eliminate the class entirely. **Fix: add `run_generation` (auto-incrementing int in DB), stamp spine events, reject writes from prior generations.**

**Gap 3 (MINOR): Watchdog timer only fires if event loop is alive.** A deeply hung Node.js event loop (rare but possible with native addons or infinite synchronous loops) would block the `setTimeout` callback. The subprocess watchdog kills the subprocess, but a hung controller process wouldn't fire the timer. **Mitigation: this is the edge case that an external process supervisor (systemd restart policy, Docker `restart: unless-stopped`) and the startup reaper together cover.**

**Gap 4 (MINOR): 1h default may be tight for legitimately long runs.** YNAB ~22k records: if network is slow, 1h might kill a legitimate run. The Infinity-disable escape hatch is the right safety valve. Consider defaulting to 2h (or making the default dependent on the connector's `maximum_staleness_seconds`) rather than 1h. This is a calibration question, not a design question.

### Is the drafted fix SUFFICIENT?

For the **primary scenario** (subprocess hangs, never resolves/rejects, same process keeps running): **YES** — the watchdog closes the bug.

For the **crash-and-restart scenario**: the fix does NOT add a startup reaper, so zombie DB rows persist. This does not cause false 409s (map is empty after restart), but it is an honesty gap.

For the **double-dispatch zombie scenario** in a single-process system with SIGKILL: the drafted fix is **safe in practice** — SIGKILL guarantees subprocess death before the new run can begin.

---

## 5. SLVP-Ideal Design for PDPP (Full Recommendation)

```
Layer 1 (in-process): Per-run wall-clock watchdog
  - setTimeout on run registration, cancelled in .finally()
  - On fire: abort subprocess (SIGKILL), emit run.failed run_timed_out,
    clear activeRuns[key] + controller_active_runs row
  - Default: 2h (env PDPP_MAX_RUN_WALL_CLOCK_MS, Infinity = disable)
  - Status: DRAFTED ✓

Layer 2 (startup): Startup reaper sweep
  - On createController(): SELECT * FROM controller_active_runs WHERE
    created_at < NOW() - interval '2 hours' (or watchdog budget)
  - For each row: emit run.failed run_timed_out (orphaned), DELETE row
  - Handles crash-and-restart scenario
  - Status: NOT IN DRAFTED FIX — needs to be added

Layer 3 (run identity): Run-generation fencing (optional but ideal)
  - AUTO INCREMENT run_generation column in controller_active_runs
  - Stamp run_generation on each spine-event batch
  - At spine-event write: check run_generation matches current active run
    for connector; reject if stale
  - Closes the zombie double-write class for all scenarios
  - Status: NOT IN DRAFTED FIX — add as a follow-on

Layer 4 (process supervision): External watchdog
  - Docker restart: unless-stopped / systemd Restart=on-failure
  - Already recommended in separate audit (no restart policy in
    docker-compose.yml is a known P2 finding)
  - Status: separate track
```

---

## 6. Adversarial Self-Check: Is the Simple In-Memory Watchdog Good Enough?

**The strongest argument that the drafted fix (in-memory watchdog + stale-entry reconciliation) is GOOD ENOUGH:**

1. **Single-process, not distributed.** Kleppmann's fencing token argument is for multi-process distributed systems where network partitions can confuse clock comparisons and lease expiry. In a single-process Node.js server with a local SQLite/Postgres DB, there is no network partition between the "reclaimer" and the "storage layer." The in-process watchdog timer fires, SIGKILL is sent, the subprocess dies, and only then does the new run begin. The zombie double-write class is eliminated by SIGKILL.

2. **The crash scenario is NOT a false 409.** After a crash and restart, `activeRuns` is empty. No 409 fires. The zombie `controller_active_runs` row is an observability problem but not a liveness problem. For a reference implementation focused on correctness and honesty, this is a P2 cleanup item, not a P0 correctness bug.

3. **Heartbeat adds complexity without proportionate gain.** Adding a heartbeat protocol would require changing the connector contract (every connector subprocess would need to emit periodic liveness signals). This is a bigger scope change than adding a watchdog timer. For a system where runs are bounded by the watchdog anyway, the added resilience of heartbeats (faster detection of hung runs) is not worth the cost.

4. **The reaper sweep is a one-liner.** Adding a startup reaper that checks `controller_active_runs` for stale rows is low-complexity and closes the crash scenario cleanly. It doesn't require a distributed consensus protocol.

**Why it does NOT fully clear the SLVP bar without the startup reaper:**

The system is honest about advertising "manual run-now is recovery." A process crash followed by a restart should leave the system fully able to run again immediately. Without the startup reaper, a zombie DB row means a future operator inspecting `controller_active_runs` would see a false in-flight run, and any reconciliation logic that reads the DB (rather than the in-memory map) would be confused. This is an honesty gap.

---

## 7. Confidence Assessment

| Dimension | Drafted Fix Rating | Gap | Confidence in Verdict |
|---|---|---|---|
| A: Wall-clock vs heartbeat | **Good** — wall-clock watchdog is pragmatically correct for a single-process system where connectors are black boxes | Default may be tight at 1h; suggest 2h | 95% |
| B: In-memory vs DB-lease source of truth | **Acceptable with caveat** — in-memory map is fine within a running process; startup reaper needed for crash case | Missing startup reaper for zombie DB row cleanup | 92% |
| C: Fencing token / run-generation | **Sufficient in practice** — SIGKILL is the fence for a single-process system | No run-generation stamp; theoretical zombie window with SIGTERM | 88% |
| D: Watchdog vs reaper | **Partial** — per-run watchdog is correct; startup reaper is missing | Startup reaper needed for crash-and-restart scenario | 90% |

**Overall confidence that the drafted fix (watchdog + stale-entry reconciliation) is SLVP-ideal AS-IS:** **72%**

**Confidence that drafted fix + startup reaper sweep = SLVP-ideal:** **91%**

**Confidence that drafted fix + startup reaper + run-generation = SLVP-ideal:** **97%**

---

## 8. Minimum Changes to Reach SLVP-Ideal

### Must-have (to reach 91%):
**Add a startup reaper in `createController`:**
```typescript
// At controller initialization, before registering any routes:
const staleMs = opts.maxRunWallClockMs ?? DEFAULT_WATCHDOG_MS;
const staleRows = await leaseStore.findStaleActiveRuns(staleMs);
for (const row of staleRows) {
  await finalizeOrphanedRun(row); // emit run.failed run_timed_out, delete DB row
}
```
This handles process crash + restart. The sweep is O(n) where n is typically 0; it runs once at startup.

### Nice-to-have (to reach 97%):
**Add run-generation to `controller_active_runs`:**
```sql
ALTER TABLE controller_active_runs ADD COLUMN run_generation INTEGER NOT NULL DEFAULT 1;
```
Increment on each new run for a given connector. Pass `run_generation` to the subprocess env (or include in spine events). At spine-event commit, check that the `run_generation` in the event matches the current row. Reject/warn if stale.

---

## 9. Summary

**The bug:** in-memory `activeRuns` map + no watchdog = hung subprocess leaks the slot permanently.

**The drafted fix:** per-run wall-clock watchdog + stale-entry reconciliation at the 409 guard. This closes the primary bug correctly.

**What it's missing vs SLVP-ideal:**
1. A startup reaper that sweeps `controller_active_runs` for orphan rows from crashed/prior sessions. This is the highest-value missing piece.
2. A monotonic run-generation fencing token on spine events (nice-to-have, closes the zombie double-write class definitively).

**The answer to "is the in-memory watchdog GOOD ENOUGH for a single-process reference implementation?":** Yes, for the primary hung-subprocess scenario. Not fully, for the crash-and-restart scenario (startup reaper needed). The double-dispatch / zombie problem is not a real threat in a single-process system with SIGKILL semantics.

**Final verdict:**
- Drafted fix as-is: **72% of SLVP-ideal** (misses startup reaper and run-generation)
- Drafted fix + startup reaper: **91% of SLVP-ideal** (practical SLVP bar for a reference implementation)
- Drafted fix + startup reaper + run-generation: **97% of SLVP-ideal** (closes all known classes)

The gap from 97% to 100% is the "external process supervisor" layer (Docker restart policy) which is a separate, already-identified finding.

---

## References

| System | Key URL | Insight |
|---|---|---|
| Temporal Activity Timeouts | https://docs.temporal.io/encyclopedia/detecting-activity-failures | StartToClose vs Heartbeat: use both; heartbeat for fast detection, StartToClose as hard ceiling |
| Temporal Heartbeat | https://docs.temporal.io/activities#heartbeat-timeout | Heartbeat Timeout = max silence between pings from worker; failure triggers retry |
| Sidekiq Reliability | https://github.com/sidekiq/sidekiq/wiki/Reliability | Process heartbeat (60s expiry) + orphan reaper on startup and hourly |
| Kubernetes Jobs | https://kubernetes.io/docs/concepts/workloads/controllers/job/#job-termination-and-cleanup | activeDeadlineSeconds = hard wall-clock ceiling, enforced by external controller |
| AWS Step Functions | https://docs.aws.amazon.com/step-functions/latest/dg/concepts-amazon-states-language.html | HeartbeatSeconds per task + TimeoutSeconds as outer bound |
| Celery Visibility Timeout | https://docs.celeryq.dev/en/stable/userguide/configuration.html#visibility-timeout | Timeout must exceed worst-case task duration OR tasks will double-deliver |
| Kleppmann Fencing Tokens | https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html | Fencing tokens (monotonic) required for correctness in distributed locking; wall-clock TTL alone is insufficient under GC pauses / process delays |
| Redis Distributed Locks | https://redis.io/docs/latest/develop/clients/patterns/distributed-locks/ | Redlock + fencing tokens: correctness requires monotonic tokens; wall-clock-only = efficiency optimization only |
| GoodJob | https://github.com/bensheldon/good_job | PostgreSQL advisory locks: session-scoped = crash-safe by construction, no heartbeat needed |
