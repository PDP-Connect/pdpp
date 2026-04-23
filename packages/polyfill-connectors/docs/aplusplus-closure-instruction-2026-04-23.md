# Instruction: Close the Remaining A++ Gaps Without Adding Incidental Complexity

**Author:** Codex (owner-mode)
**Date:** 2026-04-23
**Audience:** anyone continuing work in `packages/polyfill-connectors/`
**Status:** active execution instruction

## Why this exists

Tranches A, B, and C materially improved the package. They also left a set of
honest verification gaps. Those are not reasons to throw out the work. They are
reasons to finish it to a higher standard.

The goal here is **not** to chase incidental complexity in the name of rigor.
Per Rich Hickey's distinction, we want to remove accidental complexity and add
only the **minimum essential machinery** needed to prove the important claims.

That means:

- prefer targeted evidence over broad frameworks
- prefer narrow tests over generic harnesses until the narrow tests stop scaling
- measure the specific performance risks we introduced before building
  abstractions around them
- document intentional behavior changes where consumers could be surprised
- keep "A++" grounded in truthfulness, not architecture astronautics

## Current state

What is already true:

- Tranche A is complete and produced real findings.
- Tranches B and C are landed and accepted.
- Package checks are green:
  - `pnpm --dir packages/polyfill-connectors test`
  - `pnpm --dir packages/polyfill-connectors verify`
- `collect-helpers.ts` is gone as a live architecture.
- `parent-first` is now the documented convention.

What is **not** yet fully A++:

1. Some new behavior is under-tested in the exact place it changed.
2. Some performance-sensitive changes were shipped without measurement.
3. Some intentional behavior changes were not yet surfaced to downstream
   consumers as explicitly as they should be.
4. Some "green" claims still rest on local evidence rather than the strongest
   available operational proof.

## Execution mode

This document is meant to be executable by a worker agent, not just read as an
owner essay.

Default assumption:

- make the smallest change that closes the stated gap
- if a gap can be closed with a connector-local test, benchmark note, or doc
  file, do that instead of creating new shared machinery

If any item below turns out to require a broader harness or architecture
change, **stop and report** rather than improvising.

## Exact deliverables

Unless a stronger reason emerges, the worker should produce exactly these
artifacts:

1. `packages/polyfill-connectors/docs/behavior-changes-2026-04-23.md`
   - the canonical consumer-facing note for the parent-first behavior change
   - also the place to state the current partial shape-validation truth
2. updates to `packages/polyfill-connectors/connectors/claude_code/integration.test.ts`
   - for the two-pass behavior proofs
3. updates to `packages/polyfill-connectors/connectors/chatgpt/integration.test.ts`
   - or another existing chatgpt test file in the same connector directory
   - but only if the test proves behavior at the orchestration boundary named
     below
4. one new test file for `isMainModule` import safety if the existing
   `src/is-main-module.test.ts` is not the right place
5. one benchmark/result note for `claude_code`
6. one benchmark/result note for `gmail`
7. if a real GitHub Actions run is available, one short CI outcome note

Do not create extra docs unless one of the deliverables above clearly needs to
be split for readability.

## Non-negotiable principles

1. **No fake rigor.**
   If a test does not actually exercise the changed behavior, do not cite it as
   evidence for that behavior.

2. **No speculative framework work.**
   Do not build a generalized subprocess/E2E harness unless the narrowest
   targeted tests are clearly insufficient.

3. **Measure before optimizing or apologizing.**
   If we claim a two-pass change is acceptable, or a reordered fetch is cheap,
   we need an actual measurement.

4. **Intentional behavior changes must be called out.**
   If downstream consumers could observe the change, it needs an explicit note
   in docs/changelog/release notes.

5. **One claim, one proof.**
   For each risk below, add the smallest durable artifact that proves or bounds
   it:
   - test
   - benchmark result
   - doc note
   - CI run evidence

6. **Do not inflate the architecture to satisfy the checklist.**
   If a small connector-local test proves the point, do not add a package-wide
   harness.

7. **No silent scope expansion.**
   This instruction does not authorize connector rewrites, runtime redesign, or
   a new test platform. If the requested proof cannot be added surgically, stop
   and report.

## Priority order

### P0 — Consumer-facing honesty

This is the fastest high-value gap to close.

#### Required

- Create exactly:
  `packages/polyfill-connectors/docs/behavior-changes-2026-04-23.md`

- Put in that file, explicitly:
  - parent-child emit ordering was standardized to `parent-first`
  - this was an intentional behavior change for:
    - `gmail`
    - `chatgpt`
    - `claude_code`
  - the record shapes and stream names did not change
  - consumers that rely on streaming temporal order should now assume
    `parent-first`
  - shape-validation coverage is still partial
  - the connectors still running pass-through integration validation because
    they do not yet have `schemas.ts`

- Optionally add a one-line pointer to this note from
  `packages/polyfill-connectors/docs/authoring-guide.md` if you think discoverability
  would otherwise be poor. Do not duplicate the full note there.

#### Acceptance criteria

- A reviewer can find one concise canonical note without reading commits.
- The note is phrased as a behavior change, not a bugfix.
- The note explicitly names the still-pass-through connectors if that remains
  true at the time of writing.

## P1 — Targeted verification where the behavior changed

Do **not** start with a broad subprocess harness. Start with the narrowest tests
that directly exercise the risk.

### 1. `claude_code` two-pass correctness

#### Add

- In `packages/polyfill-connectors/connectors/claude_code/integration.test.ts`,
  add a test proving `buildOnly: true`:
  - updates observations / accumulators
  - suppresses message/attachment emits

- In that same file if practical, otherwise a second connector-local test file,
  add a focused integration test proving the actual two-pass orchestration:
  - `sessions` emit before `messages`
  - pass 2 still emits the expected child records
  - no double-emit from pass 1

- Prefer direct calls into existing exported functions. Do not build a package
  harness for this item.

#### Acceptance criteria

- The test would fail if:
  - pass 1 emitted messages
  - pass 2 emitted nothing
  - sessions emitted after messages
  - accumulator updates stopped happening in pass 1
- The proof covers the real orchestration path, not just `processJsonlLine`
  in isolation.

### 2. `chatgpt` cursor semantics after emit reorder

#### Add

- Add a focused test at the `runMessagesAndConversationsWithDetail` /
  caller layer proving:
  - the cursor / state advancement does not race ahead of unfinished child emits
  - the new parent-first order does not strand messages behind a moved cursor

- Acceptable locations:
  - `packages/polyfill-connectors/connectors/chatgpt/integration.test.ts`
  - a new connector-local test file in the same directory

- Not acceptable:
  - only testing `processConversationDetail`
  - a prose argument without an executable assertion
  - a broad package harness created solely for this proof

#### Acceptance criteria

- The proof is at the orchestration boundary, not just `processConversationDetail`.
- The test would fail if cursor advancement moved ahead of child completion.

### 3. `isMainModule` behavioral proof

#### Add

- Add one narrow proof that importing connector `index.ts` does not fire
  runtime bootstrap / hang the process.

This does **not** require a giant matrix over every connector unless the first
proof suggests variation. Start with one or two representative connectors:

- browser connector: `packages/polyfill-connectors/connectors/chatgpt/index.ts`
- non-browser connector: `packages/polyfill-connectors/connectors/claude_code/index.ts`

Method:

- spawn a short-lived child process that imports the module and exits
- use a hard timeout
- fail if the process hangs or unexpectedly starts runtime behavior

Do not rely on "the suite finished, so it must be fine."

#### Acceptance criteria

- The test fails if import-time bootstrap occurs.
- The test does not rely on "the suite finished, so it must be fine."

## P2 — Measure the shipped performance risks

No hand-waving. Add a small, repeatable measurement note.

### 4. `claude_code` two-pass cost

#### Required

- Run a benchmark on a representative local corpus.
- Record:
  - dataset size
  - file count / record count if available
  - before/after wall-clock
  - any notable CPU or parse amplification observations

Method constraints:

- Use the same machine and the same corpus for before/after.
- Run at least 3 times per mode when practical.
- Record median wall-clock, not just the best run.
- If reconstructing the exact "before" code is impractical, say so explicitly
  and record the closest honest baseline you can obtain.
- Do not build a benchmark framework; a small script and a short note are
  enough.

#### Goal

Answer this question honestly:

> Is the two-pass parent-first implementation acceptable for real operator use,
> or do we need a more efficient structure?

#### Acceptance criteria

- One short benchmark note exists in `packages/polyfill-connectors/docs/`.
- It includes methodology and actual numbers.
- It concludes one of:
  - acceptable as-is
  - acceptable with caveat
  - needs redesign
- If the median regression appears meaningfully large (for example >25%), stop
  and report instead of optimizing speculatively.

### 5. Gmail `runThreadsPass` reorder cost and race characterization

#### Required

- Measure the wall-clock effect of moving the `threads` fetch before the message
  pass on a non-trivial mailbox.
- Write down the observed race semantics explicitly:
  - whether "threads snapshot slightly ahead of messages pass" is acceptable
  - whether that should be treated as a documented eventual-consistency property

Method constraints:

- Same benchmarking discipline as `claude_code`.
- If you cannot reproduce on a sufficiently large mailbox, say so plainly.
- Do not claim "cheap" or "safe" without a number and a written race model.

#### Acceptance criteria

- There is a concrete measurement.
- There is an explicit statement of the race model.
- If the race is acceptable, say why.
- If not acceptable, open the redesign path explicitly instead of hand-waving.

## P3 — Strengthen the weakest remaining truth claims

### 6. Shape-validation coverage is still partial

Tranche A improved this materially, but four connectors still run pass-through
integration validation because they do not yet have `schemas.ts`.

#### Required

- Do **not** claim package-wide shape-validation parity yet.
- Record this in
  `packages/polyfill-connectors/docs/behavior-changes-2026-04-23.md` unless
  there is a compelling reason to split it.

- State:
  - which connectors are still pass-through
  - that full shape-validation coverage depends on those schemas existing
  - that Tranche A improved coverage materially but did not finish it

### 7. CI workflow proof

The workflow file is landed. That is not the same thing as it being proven.

#### Required

- Wait for at least one real GitHub Actions run to complete.
- Record whether it passed or what needed adjustment.

If a real hosted run is not available to the worker:

- do not fake completion
- add a short note saying local simulation passed but hosted proof is still
  pending
- stop there

#### Acceptance criteria

- Do not call the CI tranche fully closed until a real hosted run succeeds.
- If branch protection policy matters, document intended policy in a small
  repo-level note only if it is actually useful operationally. Do not create
  docs theater.

## P4 — Only then decide whether Tranche D is necessary

Tranche D was "narrow subprocess-harness protocol tests."

Owner instruction:

- do **not** start by building Tranche D
- first complete P0, P1, and P2
- then reassess what still remains unproven

At that point:

- if the remaining uncertainty is specifically about stdin/stdout protocol
  framing, `DONE`, `STATE`, process lifecycle, or zod behavior at the true
  connector boundary, Tranche D is justified
- if narrow tests already closed the meaningful risk, skip Tranche D entirely

This is important: **A++ does not mean we must build the biggest harness we can
imagine.** It means we close the meaningful gaps with the smallest truthful
artifact set.

## Forbidden moves

Do not:

- introduce a package-wide subprocess harness during P0-P3
- redesign `runConnector`
- add new shared runtime abstractions unless a targeted test is impossible
- rewrite connectors for style while chasing these proofs
- claim a benchmark result without numbers
- claim CI is proven without a real hosted run
- claim package-wide shape-validation parity unless the remaining pass-through
  connectors actually gained schemas and validating integration paths

## Stop-and-report conditions

Stop and report instead of continuing if:

- the `chatgpt` cursor proof seems to require a broad harness rather than a
  connector-local test
- the `claude_code` benchmark suggests a material regression and the fix would
  require redesign rather than a small adjustment
- the `gmail` race model looks meaningfully unsafe
- the worker cannot obtain an honest "before" baseline for a benchmark
- the GitHub-hosted CI run is unavailable
- any item starts pulling in unrelated connector changes

## Suggested execution order

1. Add the consumer-facing behavior-change note.
2. Add the `claude_code` two-pass tests.
3. Add the `chatgpt` cursor-order proof.
4. Add the `isMainModule` import proof.
5. Measure `claude_code`.
6. Measure `gmail`.
7. Record real CI run outcome.
8. Reassess whether any protocol-level gap remains that narrow tests cannot
   cover.

## Required verification before claiming done

At minimum, rerun:

- `pnpm --dir packages/polyfill-connectors test`
- `pnpm --dir packages/polyfill-connectors verify`

If you add benchmark scripts, run those explicitly and record their outputs in
the benchmark notes.

Before claiming done:

- grep touched files for stale wording that contradicts the new proofs
- reread every touched file end to end
- state explicitly which acceptance criteria were met and which, if any, remain
  pending due to external dependence (for example GitHub-hosted CI)

## Required final response format

The worker's closeout must include:

1. `Completed items`
2. `Files changed`
3. `Commands run`
4. `Benchmark results`
5. `Hosted CI status`
6. `Remaining unresolved risks`

## What not to do

- Do not build a generic benchmark framework before one benchmark note exists.
- Do not build a subprocess harness just because it feels "more serious."
- Do not write sweeping "zero drift" claims stronger than the method supports.
- Do not promote local evidence into repo-wide truth without a stronger check.
- Do not add docs that simply restate commit messages with no operational use.
- Do not confuse more moving parts with higher quality.

## Definition of done

We can call this package slice truly A++ when all of the following are true:

- the intentional parent-first behavior change is documented for consumers
- `claude_code` two-pass behavior has direct tests at the orchestration level
- `chatgpt` cursor/ordering semantics are proven at the caller boundary
- `isMainModule` is explicitly proven to prevent import-time bootstrap
- the `claude_code` and `gmail` performance/race questions have actual measured
  answers
- the current partial-vs-full shape-validation coverage is stated honestly
- the CI workflow has passed for real in GitHub Actions
- we have consciously decided, based on residual risk, whether Tranche D is
  still warranted

That is the standard.

Not "we added the most infrastructure."
Not "the test count went up."
Not "the code looks sophisticated."

The standard is: **the important claims are true, measured, documented, and
proven with no unnecessary machinery.**
