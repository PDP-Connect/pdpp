# Memo: `_ref` timeline endpoints reuse the unbounded-`.all()` pattern that the archived `fix-rs-query-memory-pressure` change established as forbidden

**Author**: Claude
**Date**: 2026-04-27
**Status**: Self-contained handoff. Describes a confirmed regression of a previously-fixed pathology in a different code surface, with primary evidence preserved. No recommendations. Intended to be actionable without re-reading prior chat context.

---

## 1. What was observed

A native crash interrupted a dev session on 2026-04-27 at approximately 10:59 local. The triggering URL, recorded by the apps/web request log immediately before the crash, was:

```
GET /dashboard/runs?peek=run_1777231731305 200 in 71ms
```

followed by:

```
Segmentation fault (core dumped)
ELIFECYCLE  Command failed with exit code 139.
```

The crashing process was the apps/web Next.js dev server (`next-server (v16.2.3)`, pid 1982273), not the reference-implementation dev server. A 9.5 GB core file was written to `apps/web/core.1982273` (since deleted after backtrace extraction).

## 2. Backtrace from the core

`gdb` was run against the core with the matching Node binary from the local dev environment. The crashing thread's frames:

```
#0  v8::base::OS::Abort()
#1  v8::internal::Isolate::PushParamsAndDie(...)
#2  v8::internal::Scavenger::IterateAndScavengePromotedObject(
      v8::internal::Tagged<v8::internal::HeapObject>,
      v8::internal::Tagged<v8::internal::Map>,
      v8::base::StrongAlias<v8::internal::HeapObjectSizeTag, unsigned int>)
#3  v8::internal::Scavenger::Process(v8::JobDelegate*)
#4  v8::internal::ScavengerCollector::JobTask::ProcessItems(
      v8::JobDelegate*, v8::internal::Scavenger*)
#5  v8::internal::ScavengerCollector::JobTask::Run(v8::JobDelegate*)
#6  v8::platform::DefaultJobWorker::Run()
#7  node::PlatformWorkerThread(void*)
#8  start_thread (libc)
#9  __GI___clone3 (libc)
```

This is identical, frame-for-frame at the V8 layer, to the signature documented in the archived OpenSpec change `openspec/changes/archive/2026-04-24-fix-rs-query-memory-pressure/proposal.md`:

> The crash signature was `SIGSEGV` inside V8's parallel scavenger (`v8::internal::HeapObject::SizeFromMap`) during a `better-sqlite3` result marshaling call.

The archived change diagnosed that signature as "us, not V8" — the result of unbounded `.all()` materialization of large JSON-column tables under concurrent dashboard load, driving V8's old-space to its limit and triggering a fatal scavenge during result marshaling.

A copy of the gdb summary was preserved locally during the investigation; the relevant backtrace is included above so this note remains self-contained.

## 3. The pathology the archived change forbade

The archived change introduced the following normative requirement in `openspec/specs/reference-implementation-architecture/spec.md` (verified present at lines 242-301 of the current spec; see "Requirement: The RS read-path for enumerated routes SHALL not materialize unbounded result arrays"):

For an enumerated set of read paths, the RS SHALL stream rows and apply access-control filters and pagination bounds in SQL. The enumerated set in the archived change was:

1. `server/records.js::fetchVisibleRecordRows` → rewritten as `fetchVisibleRecordRowsPaginated`
2. `server/records.js::hydrateExpandedRelations` → rewritten as `fetchExpansionChildrenGroupedByForeignKey`
3. `lib/spine.js::listSpineCorrelations` and `searchSpine` → rewritten with SQL `GROUP BY` and indexed equality
4. `server/ref-control.js::listRecordsTimeline` → rewritten with per-pair prepared statements and `.iterate()`

The archived change targeted the four call sites observed to have triggered the V8 scavenger crash on a 3.3 GB SQLite snapshot. It did not include `listSpineEvents`. Whether that was an oversight or an intentional scope decision is not recorded in the archived design notes.

## 4. The regression site

`reference-implementation/lib/spine.ts:383-411`, `listSpineEvents`, uses `.all()` for every filter branch. The body is verbatim:

```ts
export async function listSpineEvents(filters: SpineEventFilters = {}): Promise<SpineEventRecord[]> {
  const db = getDb() as SpineDatabase | undefined;
  if (!db) {
    return [];
  }

  let rows: SpineEventRow[];
  if (filters.traceId) {
    rows = db
      .prepare("SELECT * FROM spine_events WHERE trace_id = ? ORDER BY rowid")
      .all(filters.traceId) as SpineEventRow[];
  } else if (filters.grantId) {
    rows = db
      .prepare("SELECT * FROM spine_events WHERE grant_id = ? ORDER BY rowid")
      .all(filters.grantId) as SpineEventRow[];
  } else if (filters.runId) {
    rows = db
      .prepare("SELECT * FROM spine_events WHERE run_id = ? ORDER BY rowid")
      .all(filters.runId) as SpineEventRow[];
  } else if (filters.eventType) {
    rows = db
      .prepare("SELECT * FROM spine_events WHERE event_type = ? ORDER BY rowid")
      .all(filters.eventType) as SpineEventRow[];
  } else {
    rows = db.prepare("SELECT * FROM spine_events ORDER BY rowid").all() as SpineEventRow[];
  }

  return hydrateRows(rows);
}
```

This is the same shape (`.all()` of a row scan, then JSON re-hydration of a `data_json` column per row, then return as a single in-memory array) that the archived change forbade for the four sites it covered.

## 5. The four call sites that reach this function

`grep -rn "listSpineEvents\b"` in `reference-implementation/` (excluding node_modules and tests) returns these production callers:

| Caller | File:line | Public surface |
|---|---|---|
| Trace timeline | `server/index.js:2111` | `GET /_ref/traces/:traceId` |
| Grant timeline | `server/index.js:2122` | `GET /_ref/grants/:grantId/timeline` |
| Run timeline | `server/index.js:2133` | `GET /_ref/runs/:runId/timeline` |
| Run-event lookup | `server/ref-control.ts:298` | Internal helper used by `/_ref/runs/:runId` and run-related ref-control surfaces |

All four call `listSpineEvents` with exactly one filter and forward the entire returned array into `buildTimelineEnvelope`. The web client at `apps/web/src/app/dashboard/lib/ref-client.ts:224, 235, 246` consumes all three of the timeline endpoints via `normalizeTimeline` and renders them in dashboard pages.

## 6. Concrete sizing against the current substrate

Measured against `packages/polyfill-connectors/.pdpp-data/pdpp.sqlite` on 2026-04-27:

- Total `spine_events` rows: **96,972**.
- Mean `data_json` bytes per row: **232 bytes**.
- Maximum `data_json` bytes for a single row: **327,917 bytes** (≈320 KB).
- Largest run by total event-payload bytes: `run_1776643908440`, 2,542 events, **1.22 MB** of `data_json`. Three runs in the same range. (These runs predate the four 2026-04-26 audit failures by several days.)
- Largest trace by total event-payload bytes: `trc_a71311b0cc496ba6`, 2,542 events, **1.22 MB** of `data_json`.

The single largest run-timeline materialization the database currently permits is therefore on the order of 1.2 MB of JSON. That is well below the per-call ceiling that triggered the original archived crash (the archived audit measured `slack/messages` at 152 MB and `record_changes` at 1.2 GB cumulative). Two consequences follow:

1. A single direct request to `/_ref/runs/:runId/timeline` for the worst current run is unlikely on its own to drive the apps/web Next.js dev server to OOM.
2. The dashboard renders multi-section pages: a run-peek view fans out into related fetches (the run's grant timeline, the trace timeline, list-page bootstraps, and Next.js dev-mode source maps and module graphs). Under SSR/RSC fan-out, multiple unbounded materializations live simultaneously in the Next.js process memory. The archived audit explicitly cited "multiple copies of these result arrays lived simultaneously" as the proximate trigger for the V8 corner.

The crash signature observed on 2026-04-27 is consistent with the SSR-fan-out shape, not with a single-call ceiling.

## 7. Where the crash actually happened

A subtlety worth recording: the segfault was in the **Next.js dev server (apps/web)**, not in the reference-implementation server. The apps/web process consumed the timeline JSON envelopes returned by the RS, allocated React server-component graphs and source-maps over them, and crashed during a young-gen scavenge.

The archived change rewrote the server-side read paths so that the RS itself does not materialize unbounded arrays. It did not directly address the SSR consumer side — but in practice, fixing the source of unbounded JSON envelopes also reduced the consumer-side allocation pressure, because no consumer can be smaller than the data it ingests. The four call sites in §5 emit envelopes whose size scales linearly with `spine_events` rows that share a correlation column. The unbounded source is the un-fixed call sites; SSR is the amplifier.

The crash being on the consumer side does not contradict the diagnosis; it is the same root cause, observed at a different layer of the stack.

## 8. Material that may have been an unstated assumption in the archived change

The archived change's audit table named these tables and the sizes that motivated rewrites:

```
gmail/message_bodies:    370 MB per .all() call
slack/messages:           152 MB
claude-code/messages:     102 MB
record_changes:           1.2 GB (cumulative)
spine_events:             21 MB (scanned 3× in distinct handlers)
```

The line "spine_events: 21 MB (scanned 3× in distinct handlers)" is consistent with the pattern in `listSpineCorrelations` and `searchSpine` (which were rewritten) but does not on its face cover `listSpineEvents` (the timeline-fetch helper, which scans by single correlation column). The archived change's selection criterion was "the four sites observed to crash on the 3.3 GB snapshot." Whether `listSpineEvents` did not crash on that snapshot, or whether it crashed and was excluded, or whether it was simply not exercised in the repro harness, cannot be reconstructed from the archived artifacts. A reviewer would need to consult the harness in `repro-crash.sh` and the design notes referenced from the archived `proposal.md`.

## 9. Other contextual facts that interact with this regression

- The dev environment's core-dump configuration was misrouted at the time of the crash (`kernel.core_pattern = core`, writing into the working tree rather than `systemd-coredump`). This was changed during the same session. It does not affect the diagnosis but does explain why the core file was found inside the repo rather than under `coredumpctl`.
- Both dev scripts now write Node diagnostic reports to `tmp/node-reports/` on fatal V8 errors and uncaught exceptions. The 2026-04-27 crash predates that change, so no JSON report exists for it; the only artifact was the core. Future occurrences of the same pathology should produce a small JSON report alongside the core.
- The archived change's repro harness (`repro-crash.sh`) was written against a large frozen SQLite snapshot. It is not known whether that snapshot is still available or whether a current snapshot of `pdpp.sqlite` (96,972 spine events, ~1.2 MB worst-case timeline) reproduces the crash deterministically. The `repro-crash.sh --runs=N` harness reports PASS (0 crashes) / FAIL (any crash); it could be re-run against a current snapshot to characterize the baseline rate.
- The web-side rendering path that reaches these endpoints is at `apps/web/src/app/dashboard/lib/ref-client.ts:224, 235, 246`, normalized through `normalizeTimeline` (line 51), and consumed by `apps/web/src/app/dashboard/runs/page.tsx` (peek path) and adjacent dashboard pages.

## 10. Options that surfaced during analysis (descriptive only, not recommendations)

- **Extend the archived spec's enumerated set to cover `listSpineEvents`.** The archived requirement names specific files; this would either rewrite the requirement to enumerate the four new call sites in §5 or generalize the requirement to "spine-event read paths SHALL not materialize unbounded result arrays" without enumerating sites. Open question: how the requirement reads after generalization without obscuring which call sites a reviewer can mechanically check.

- **Rewrite `listSpineEvents` to stream + cap.** Replace `.all()` with `.iterate()` and a caller-supplied `limit` plus pagination cursor on `(rowid)`. The four callers in §5 each currently consume the whole array; a pagination contract on the public route would change the response envelope shape (`run_timeline` → paginated `list` envelope), which is a contract change. Open question: whether the four `_ref` timeline routes are reference-only (which the architecture spec already says) and therefore have lower cost-of-change than a public PDPP route would.

- **Bound at the consumer instead of the source.** Apps/web's `normalizeTimeline` could refuse to render envelopes above a threshold and instead show a placeholder ("timeline too large; use CLI to inspect"). Does not change the RS contract. Does not address direct callers (CLI, third-party) that don't go through apps/web.

- **No protocol change; investigation only.** Treat as a known operational hazard, document the URL pattern that triggers it, and do not fix it until a real-world (rather than synthetic) timeline grows large enough to trigger again. Open question: whether the next occurrence is recoverable from the diagnostic reports added 2026-04-27, or whether the OOM happens before the report is flushed.

- **Re-validate the archived repro harness against current substrate.** Run `bash repro-crash.sh --runs=5` against a current snapshot of `pdpp.sqlite` to determine whether the archived test suite still PASSes. If it FAILs, the regression is detected by the original harness; if it PASSes despite the 2026-04-27 crash, the harness has a coverage gap (the URLs it exercises do not include `/dashboard/runs?peek=...` or its server-side equivalents).

## 11. Specific facts the reviewer may want to verify

- `reference-implementation/lib/spine.ts:383-411` — `listSpineEvents` uses `.all()` in every branch.
- `reference-implementation/server/index.js:2111, 2122, 2133` — the three `_ref` timeline endpoints that call it.
- `reference-implementation/server/ref-control.ts:298` — the fourth caller.
- `apps/web/src/app/dashboard/lib/ref-client.ts:224, 235, 246` — the web-side fetchers.
- `apps/web/src/app/dashboard/runs/page.tsx` — the peek rendering path that triggered the 2026-04-27 crash.
- `openspec/changes/archive/2026-04-24-fix-rs-query-memory-pressure/proposal.md` — the prior change establishing the invariant. Its §spec-delta is the archive of the requirement now living in the canonical spec.
- `openspec/specs/reference-implementation-architecture/spec.md`, the requirement "The RS read-path for enumerated routes SHALL not materialize unbounded result arrays" — the canonical normative text inherited from the archived change.
- `repro-crash.sh` — the existing N-run harness from the archived change. Reports PASS/FAIL on a frozen substrate.
- The backtrace excerpt in this note — preserved gdb output for the 2026-04-27 crash.

## 12. Out of scope of this memo

- Whether the four call sites in §5 are the only `listSpineEvents` use sites that warrant attention. The grep was scoped to non-test, non-node_modules sources in `reference-implementation/`. CLI surfaces and bench scripts were not separately surveyed.
- Whether the existing repro harness still reproduces the original archived crash on the current substrate. It has not been re-run.
- Whether apps/web's dev configuration (Next 16.2.x, `--webpack` workaround for an upstream issue) materially affects the SSR-amplification factor versus a production build. Not measured.
- Whether the web-side crash on 2026-04-27 represents a new bug class beyond the archived diagnosis. The signature is identical at the V8 layer; whether the SSR amplification adds a distinct failure mode is not characterized in this memo.
- Recommendations.

## 13. Why this memo exists separately from the connector-failure-diagnostics memos

Two earlier local investigation memos describe a different class of problem (connector child processes whose stderr is collected and then discarded). The pathology in the present memo is structurally unrelated: it is about the runtime's own read paths against the SQLite substrate, not about the runtime's handling of child-process output. The prior memos do not mention `listSpineEvents` or the timeline endpoints, and would not have surfaced this regression to a reviewer. This memo closes that handoff gap.
