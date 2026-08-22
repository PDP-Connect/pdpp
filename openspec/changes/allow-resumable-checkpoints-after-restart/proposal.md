## Why

A run interrupted by a server restart resumes from zero. The owner's standard
for #166 is "if I restart the server, my data doesn't all go unhealthy"; this
is the largest remaining gap against it, and it needs a spec change, so it is
proposed rather than implemented.

`commitState` has exactly two call sites, both inside `handleDoneClose`
(`runtime/index.ts`). `handleStateMessage` only stages cursors in the
in-process `newState` map, which dies with the process. **A run that never
reaches DONE commits no cursor at all, however long it ran.**

Concrete cost. A Slack archive walk takes ~54 minutes. Killed at minute 50, it
re-fetches all 50 minutes of work on the next run. If deploys land closer
together than one walk length, such a connection can never finish — it is not
slow, it is non-converging. 45 runs were ended by restarts between 2026-08-15
and 2026-08-22 (28 `controller_terminated_before_run_finished` + 17
`controller_restarted`), concentrated in the longest walks: 9 Slack, 4 Gmail,
3 YNAB, plus Amazon and Google Maps.

**This is bounded, not catastrophic.** `records` carries a UNIQUE CONSTRAINT
`records_connector_instance_stream_key (connector_instance_id, stream,
record_key)`, so ingest is idempotent: a re-walk re-upserts rather than
duplicating, and no already-collected record is lost. The cost of the current
rule is **wasted work and staleness, never data loss.** Any change here must
preserve that property — the current rule is conservative in the right
direction, and a careless relaxation would trade a real-but-bounded cost for an
unbounded one.

## The rule today, and why it exists

`spec-collection-profile.md` states it twice, and deliberately:

- Line 151: "The runtime MUST NOT persist STATE checkpoints from a run that
  terminates in the `failed` state, except for the certified stream-scoped
  failure described under DONE. State is otherwise persisted only after a
  successful DONE."
- Line 497: "A missing or mismatched terminal code, a missing or untargeted
  skip, an out-of-scope stream, a protocol violation, an invalid terminal count
  or exit code, **a process exit without valid DONE**, or cancellation MUST
  preserve the default fail-closed rule and persist no staged STATE."

Line 497 covers a restart directly — a restart *is* a process exit without
valid DONE. There is no `abandoned` loophole; the case was considered and
closed. The rule is correct in its purpose: a cursor must not advance past
records whose detail coverage was never proven. `DETAIL_COVERAGE` is evaluated
at DONE, and a detail stream may emit coverage for a parent long after that
parent's own STATE message. Committing a parent early could advance past
unhydrated detail that no later run would revisit — converting today's honest
re-fetch into silent data loss.

An implementation attempt confirmed this is load-bearing, not incidental:
committing at STATE time broke 19 existing tests in
`test/collection-profile.test.ts`, including the explicit contract "STATE is
only committed when DONE status is succeeded". It was reverted.

## What Changes

A narrow exception, for a restart only, limited to checkpoints whose coverage
is already PROVEN at the moment the STATE message is handled.

- Add a terminal disposition for a run ended by controller restart, distinct
  from `failed`: the run's outcome was never observed, rather than observed to
  be bad. (This mirrors the distinction already drawn on the read side, where
  restart-abandoned runs no longer classify connection health.)
- Permit a runtime to persist a staged checkpoint at STATE time **only when
  every one of these holds**:
  1. The checkpoint stream is not named as a detail parent by any in-scope
     stream's manifest `parent_streams`/`state_stream` declaration — so no
     DONE-time `DETAIL_COVERAGE` verdict can ever apply to it. This is
     decidable from the manifest before the run starts, and is exactly the
     predicate `missingDetailCoverageReports` already uses.
  2. The records the cursor covers are already durably ingested.
     `handleStateMessage` already awaits `flushBatch(stateStream)` before
     staging, so this holds today at that point.
  3. The connector declared no gap for that stream this run.
- Keep the fail-closed default for every other case: any stream that could
  shortfall, any protocol violation, any connector-reported failure, and any
  owner cancellation continue to persist nothing.

Under this exception a restart-interrupted Slack walk resumes near minute 50
instead of zero, while a list+detail connector like ChatGPT — whose
`conversations` checkpoint gates `messages` detail — is unaffected and keeps
committing only at DONE.

## What this does NOT propose

- No change to the `failed`-run rule. A connector that reports failure still
  commits nothing beyond the existing certified stream-scoped exception.
- No change to cancellation. An owner cancel still persists nothing.
- No weakening of the coverage gate. A stream that could shortfall is excluded
  by construction, not by a runtime judgement call.
- No trust in connector self-declaration. Eligibility is derived from the
  manifest and the runtime's own flush ordering, never from a connector flag —
  a manifest claim of "safe to commit early" would be voluntary honesty, which
  this program has been burned by before.

## Alternatives considered

- **Do nothing.** Defensible, because idempotency bounds the cost to wasted
  work. Rejected as the default answer because a walk longer than the interval
  between deploys never converges — the owner cannot get a complete Slack
  archive, which is a data-completeness failure, not a performance one.
- **Shorten the walks instead.** Real, and worth doing independently, but it
  does not fix restart-during-walk; it only narrows the window.
- **Graceful drain on SIGTERM.** Already built, deployed, measured, and
  removed in `2ddcca1b8` — production logged `drained:0, elapsedMs:5000,
  timedOut:1`. Docker's stop timeout is 10s and fixed at container creation
  while real runs take minutes, and a `kill -9` gets no drain at all. Not a
  viable path; see `design-notes/graceful-drain-verdict-2026-08-22.md`.

## Impact

- Affects `spec-collection-profile.md` (normative), and `runtime/index.ts`
  `handleStateMessage` once the spec permits it.
- The eligibility predicate is manifest-derived and computable before the run
  starts, so conformance is testable offline.
- Verification should follow D15: kill a run mid-walk, then prove the next run
  re-fetches nothing before the last committed boundary AND that a
  detail-parent checkpoint did not advance.

## Owner decision required

The owner gates spec changes. The question is narrow: **may a checkpoint whose
coverage is already proven survive a restart, when the alternative is that
long walks never converge?** The safety property that makes this askable is
that eligibility is decided from the manifest, not from connector claims.
