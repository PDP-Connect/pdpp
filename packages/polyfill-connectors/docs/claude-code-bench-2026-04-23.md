# claude_code two-pass benchmark — 2026-04-23

**Date:** 2026-04-23
**Script:** `bench/claude-code-two-pass.ts`
**Corpus:** `~/.claude/projects` (3.2 GB, 752 sessions, 686,623 records: 641,523 messages, 44,348 attachments)
**Machine:** local dev machine, warm OS filesystem cache (explicit warmup run before measurement)
**Iterations:** 3 runs per mode; median reported

## Question

Per the closure instruction: **is the two-pass parent-first implementation
acceptable for real operator use?**

## Method

- **Mode A (baseline):** single-pass — call `scanProjectDirs` once with
  `buildOnly: false`, then `emitSessionsFromAccumulators`. Behaviorally
  matches pre-Tranche-C (one scan; emits messages, attachments, and —
  at the end — sessions).
- **Mode B (current):** two-pass — `scanProjectDirs` with
  `buildOnly: true` (silent accumulator build), then
  `emitSessionsFromAccumulators`, then `scanProjectDirs` with
  `buildOnly: false`. This is what landed in commit `0cf0f51`.
- `emitRecord` is a no-op counter in both modes. We're measuring scan
  + parse cost, not downstream ingest.
- Warmup pass executed before measurement to level filesystem cache
  asymmetry.

## Result

| Mode | Median wall-clock | Records emitted |
|---|---|---|
| single-pass (baseline) | **11,516 ms** | 685,553 |
| two-pass (current) | **23,210 ms** | 686,623 |

Per-phase split of the two-pass run (median across 3):

- Pass 1 (buildOnly=true, accumulator build): **11,620 ms**
- `emitSessionsFromAccumulators`: **0 ms** (in-memory only)
- Pass 2 (buildOnly=false, emit children): **11,601 ms**

**Regression: +101.5%** — the two-pass structure effectively doubles
wall-clock on this corpus. The parse cost of the full jsonl scan is
essentially paid twice, once silently and once to emit.

## Verdict

**NEEDS REDESIGN.** Per the closure instruction's stop-and-report
threshold (>25% median regression):

> If the median regression appears meaningfully large (for example
> >25%), stop and report instead of optimizing speculatively.

This one is +101.5%, ~4x the threshold. The commit message on
`0cf0f51` ("~seconds, not minutes") was directionally correct but
misjudged the magnitude — we're adding **~11.7 seconds per run on
this corpus**, which a user running the connector manually will
feel.

## Honest contextualization

This is still below the pain threshold for a periodic background
run (the connector is not hot-path). A user who schedules it
hourly pays roughly +0.3% of an hour per extra run. But:

- the operator running it manually sees a 2x wait
- on a larger corpus (user with 10 GB of projects) the absolute
  cost scales with corpus size — could easily exceed a minute

Accepting the regression silently would be fine-ish on paper. But
the claim "acceptable" isn't supported by the measurement.

## Not-started options for the owner to consider

Per the instruction, **I am not starting a redesign.** This section
is a planning artifact — three possible paths, their trade-offs, and
my recommendation.

### Option 1: accept the regression, document it

Smallest change. Update `docs/behavior-changes-2026-04-23.md` with
the measured +100% cost. The operator reads it, decides whether to
run claude_code on the background schedule or on-demand.

- pro: zero code change; most honest about the trade we made
- con: the "A++" standard doesn't tolerate a 2x regression when
  there's a known fix

### Option 2: buffer messages in memory during pass 1

Instead of a second disk scan, cache parsed JsonlObject arrays
per-file in memory during pass 1. Pass 2 reads from memory. Cost:
~240-480 MB of memory on this corpus (686k records, ~512 bytes per
line after parse), but zero extra I/O.

- pro: ~50% of the regression eliminated (one pass + re-emit)
- con: memory footprint becomes a function of corpus size; could
  OOM on multi-tenant machines
- mitigation: stream per-file (buffer one file's parsed lines,
  emit its messages while the next file reads). Bounded memory,
  preserves parent-first at the file level.

### Option 3: emit sessions with pending-update semantics

Emit session record first with the OBSERVED-SO-FAR aggregate, then
emit messages. Accept that the session record's `message_count`
might be an under-count until the next run's session-level
re-emit.

- pro: eliminates the full second pass
- con: changes record-level semantics (aggregates now "eventually
  consistent"), which is a bigger contract change than the
  parent-first ordering itself

### My recommendation (owner decision still needed)

**Option 2 with per-file streaming.** It preserves the parent-first
contract exactly, bounds memory, and targets the measured cost.
Session aggregate is built incrementally during pass 1; the file's
parsed lines are buffered only for the duration of that file's
emit. Bounded memory, no extra I/O.

Rough estimate: regression should drop to <25% (the parse work
stays, but the disk re-read goes away, and disk is the dominant
cost on warm cache).

Awaiting owner direction on which option to pursue (if any) before
starting code changes.

## Running the bench

```bash
cd packages/polyfill-connectors
npx tsx bench/claude-code-two-pass.ts
```

Set `CLAUDE_CODE_PROJECTS_DIR` to point at an alternative corpus.
Exits non-zero if the regression exceeds 25% (owner-instruction
stop condition).

## Raw numbers from this run

```
[bench] corpus: /home/user/.claude/projects
[bench] warmup pass (results ignored)...
[bench] MODE A — single-pass (baseline), 3 runs
  run 1: 11516ms (records=685540, sessions=0, messages=641507, attachments=44033)
  run 2: 11568ms (records=685556, sessions=0, messages=641514, attachments=44042)
  run 3: 11447ms (records=685565, sessions=0, messages=641519, attachments=44046)
[bench] MODE B — two-pass (current), 3 runs
  run 1: 23210ms (pass1=11620ms emitSessions=0ms pass2=11589ms)
  run 2: 23069ms (pass1=11467ms emitSessions=0ms pass2=11601ms)
  run 3: 24474ms (pass1=12108ms emitSessions=0ms pass2=12366ms)

single-pass median: 11516ms (baseline)
two-pass median:    23210ms
  pass 1 (build):   11620ms
  emit sessions:    0ms
  pass 2 (emit):    11601ms

Regression: +101.5%
Verdict: REGRESSION > 25% — stop-and-report per closure instruction.
```
