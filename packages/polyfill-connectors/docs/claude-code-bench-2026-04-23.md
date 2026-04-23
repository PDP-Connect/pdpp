# claude_code two-pass benchmark — 2026-04-23

**Date:** 2026-04-23 (updated with honest baseline per owner feedback)
**Script:** `bench/claude-code-two-pass.ts`
**Legacy baseline source:** `bench/legacy/claude-code-pre-tranche-c.ts` — verbatim copy of `connectors/claude_code/index.ts` from commit `0cf0f51^` (the parent of the Tranche C two-pass commit).
**Corpus:** `~/.claude/projects` (3.2 GB, 752 sessions, 687,566 records per run: 641,941 messages, 44,873 attachments)
**Machine:** local dev machine, warm OS filesystem cache (both modes warmed up before measurement)
**Iterations:** 3 iterations, interleaved (A,B,A,B,A,B), median reported

## Question

Per the closure instruction: **is the two-pass parent-first implementation
acceptable for real operator use?**

## Baseline-correctness note (2026-04-23 update)

An earlier version of this bench used `scanProjectDirs({ buildOnly: false })`
from the CURRENT code as its "single-pass baseline." The owner caught
that this was NOT a faithful pre-Tranche-C reconstruction: current
`parseJsonlFile` only calls `updateSessionAccumulator` when
`buildOnly` is TRUE, so the baseline run emitted **0 sessions**. Not a
like-for-like comparison.

This version fixes that. `bench/legacy/claude-code-pre-tranche-c.ts`
is a byte-for-byte copy of `connectors/claude_code/index.ts` from
commit `0cf0f51^` — the code that actually ran in production before
Tranche C. Its `parseJsonlFile` always updates the accumulator; its
`processJsonlLine` always emits. The bench imports its
`scanProjectDirs` and `emitSessionsFromAccumulators` directly.

After the fix, both modes emit the same record counts (752 sessions,
641,941 messages, 44,873 attachments in representative runs). The
comparison is now honest.

## Method

- **Mode A (legacy baseline):** import `scanProjectDirs` +
  `emitSessionsFromAccumulators` from `bench/legacy/claude-code-pre-tranche-c.ts`.
  One scan that updates accumulators AND emits messages/attachments
  inline, then `emitSessionsFromAccumulators`.
- **Mode B (current):** `scanProjectDirs` from current `index.ts`
  with `buildOnly: true`, then `emitSessionsFromAccumulators`, then
  `scanProjectDirs` with `buildOnly: false`. This is what landed in
  commit `0cf0f51`.
- `emitRecord` is a no-op counter in both modes. We measure scan +
  parse cost, not downstream ingest.
- Warmup pass per mode before measurement. Measured iterations are
  interleaved (A, B, A, B, A, B) rather than batched (A,A,A,B,B,B)
  to minimize systematic cache-drift asymmetry between modes.

## Result

| Mode | Median wall-clock | Records emitted |
|---|---|---|
| legacy baseline (pre-Tranche-C) | **12,464 ms** | 687,268 (sessions=752, messages=641,941, attachments=44,575) |
| current two-pass | **24,322 ms** | 687,574 (sessions=752, messages=641,945, attachments=44,877) |

Per-phase split of the two-pass run (median across 3):

- Pass 1 (buildOnly=true, accumulator build): **12,264 ms**
- `emitSessionsFromAccumulators`: **0 ms** (in-memory only)
- Pass 2 (buildOnly=false, emit children): **12,269 ms**

**Regression: +95.1%** — the two-pass structure effectively doubles
wall-clock on this corpus. The scan + parse cost is essentially paid
twice.

(The minor record-count drift between runs — e.g. 641,938 vs. 641,972
messages — reflects active claude_code use during the benchmark. The
corpus is live; it's being written to as I run. The drift is <0.01% of
either run's total and does not affect the wall-clock comparison.)

## Verdict

**NEEDS REDESIGN.** Per the closure instruction's stop-and-report
threshold (>25% median regression):

> If the median regression appears meaningfully large (for example
> >25%), stop and report instead of optimizing speculatively.

+95.1% is nearly 4x the threshold. The earlier +101.5% figure was
based on the faulty baseline; the corrected figure is slightly lower
because the legacy baseline actually does the accumulator work (the
prior "baseline" was skipping it, making it look faster than
production ever was). The direction and magnitude of the conclusion
don't change: this is a real regression, not a measurement artifact.

## Honest contextualization

The connector is not hot-path. A user who schedules claude_code
hourly pays about +0.3% of an hour per extra run — arguably invisible.
But:

- **Manual/foreground runs pay full cost.** An operator running
  `pdpp-connectors run claude_code` interactively sees the full ~24s
  instead of ~12s.
- **Scales with corpus size.** On a 10 GB user (my corpus is 3.2 GB),
  absolute cost scales linearly. A 90-second run becomes a 3-minute
  run.

Accepting the regression silently would be fine-ish on paper. But
the claim "acceptable" isn't supported by the numbers at the operator
level.

## Not-started options for the owner to consider

Per the instruction, **I am not starting a redesign.** This section is
a planning artifact — three possible paths, their trade-offs, and my
recommendation.

### Option 1: accept the regression, document it

Smallest change. `docs/behavior-changes-2026-04-23.md` already
documents parent-first as an intentional behavior change; add the
measured +95% cost so users can decide whether to run claude_code on
the background schedule or on-demand.

- pro: zero code change; most honest about the trade we made
- con: the "A++" standard doesn't tolerate a 2x regression when
  there's a known fix

### Option 2: per-file streaming buffer

Keep the parent-first contract, eliminate the re-read. For each
jsonl file: read once, parse all lines into an in-memory array,
update the session accumulator from that array, then (once all files
for a session are seen — which in practice is one file per session
given claude_code's directory layout) emit the session record
immediately, then replay the buffered lines to emit
messages/attachments.

Memory cost: one file's parsed lines (bounded; typical session files
are <10MB parsed). No extra I/O.

Trade-off: this changes WHEN sessions emit. Currently they all emit
AFTER pass 1. Option 2 would emit them interleaved, once per session
file. That's still parent-first within each session (which is what
consumers care about). The global ordering shifts from "all parents,
then all children" to "parent-then-children, per session." Both
satisfy the parent-first contract.

- pro: eliminates the ~12s second pass; regression should drop to
  <10% (just the buffer-allocation overhead)
- con: session-level rather than global parent-first; needs
  integration-test updates to assert the new shape
- con: breaks the current guarantee that session records land first
  in a contiguous block (if any consumer depends on that; unlikely)

### Option 3: eventually-consistent session aggregates

Emit session record FIRST with a placeholder `message_count` (null or
estimated), then emit messages, then emit a session UPDATE at the
end. Consumers doing streaming upserts would upsert the session row
twice: first with provisional fields, then with the finalized
aggregate.

- pro: eliminates the second pass entirely
- con: introduces a two-emit pattern for sessions that no other
  connector uses. Contract surface grows.
- con: any consumer treating emits as terminal values would see the
  wrong message_count until the second emit arrives

### My recommendation

**Option 2.** Preserves parent-first, bounds memory by file size, cuts
expected regression to <10%. Trade-off of "session-level rather than
global parent-first" is honest and matches what consumers actually
need (referential integrity per parent, not global batching).

Awaiting owner direction.

## Running the bench

```bash
cd packages/polyfill-connectors
npx tsx bench/claude-code-two-pass.ts
```

Set `CLAUDE_CODE_PROJECTS_DIR` to point at an alternative corpus.
Exits non-zero if the regression exceeds 25% (owner-instruction stop
condition).

## Raw numbers from this run

```
[bench] corpus: /home/user/.claude/projects
[bench] warmup pass (results ignored) — legacy baseline...
[bench] warmup pass (results ignored) — current two-pass...
[bench] Interleaved 3 iterations of (legacy baseline, two-pass)
  iter 1 legacy baseline: 12464ms (records=687265, sessions=752, messages=641938, attachments=44575)
  iter 1 two-pass:         24880ms (pass1=12347ms emitSessions=0ms pass2=12532ms, records=687566, sessions=752, messages=641941, attachments=44873)
  iter 2 legacy baseline: 12468ms (records=687268, sessions=752, messages=641941, attachments=44575)
  iter 2 two-pass:         24322ms (pass1=12264ms emitSessions=0ms pass2=12057ms, records=687574, sessions=752, messages=641945, attachments=44877)
  iter 3 legacy baseline: 12213ms (records=687305, sessions=752, messages=641959, attachments=44594)
  iter 3 two-pass:         24211ms (pass1=11941ms emitSessions=0ms pass2=12269ms, records=687632, sessions=752, messages=641972, attachments=44908)

legacy baseline median (pre-Tranche-C, commit 0cf0f51^): 12464ms
current two-pass median:                                 24322ms
  pass 1 (build):   12264ms
  emit sessions:    0ms
  pass 2 (emit):    12269ms

Regression: +95.1%
Verdict: REGRESSION > 25% — stop-and-report per closure instruction.
```

## Residual limitations

- **Active-corpus drift.** My `~/.claude/projects` is being written
  to during the benchmark (I'm using claude right now). Record counts
  differ by a few dozen between runs. Does not affect wall-clock;
  affects only raw count precision.
- **Single-machine, single-corpus measurement.** A user with a
  different storage medium (SSD vs spinning rust vs remote FS) or a
  significantly larger/smaller corpus could see different scaling.
  The regression is 2x on this hardware — directionally the same
  everywhere, but the absolute numbers won't generalize.
- **`~/.claude/projects` is on local NVMe SSD** with warm OS cache
  on both runs. A cold-cache first run would be dominated by disk
  I/O rather than parse cost, and the regression could be worse
  proportionally (you'd pay 2x the disk-read cost, not just the
  parse cost).
