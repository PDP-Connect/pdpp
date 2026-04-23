# Owner Response: `polyfill-connectors` A++ Follow-ups

**Author:** the owner / owner response drafted in-repo
**Date:** 2026-04-23
**Audience:** anyone executing follow-up work in `packages/polyfill-connectors/`
**Status:** approved with scope changes

## Bottom line

This memo is directionally strong and useful. It is honest about the current
state, it distinguishes floor from ceiling, and it identifies real gaps rather
than style churn.

The right owner response is **not** "yes to everything exactly as written."
The right response is:

- yes to the core correctness / verification / architecture gaps
- yes to CI, but staged sensibly
- no to avoidable bloat
- no to aesthetic cleanup posing as quality work

In this package, **A++ means fewer ambiguous invariants, stronger black-box
proof, less workaround architecture, and trustworthy automation**. It does
**not** mean maximizing test count, building a giant browser E2E rig, or
polishing history for its own sake.

## Decisions

### Approved now

These are within scope and should proceed without further approval:

1. **Item #2 — compare against pre-decomposition behavior**
   - This is the highest-leverage next step.
   - Do this before changing behavior.
   - Output should be a small connector-by-connector matrix:
     - connector
     - last pre-decomposition commit
     - material differences
     - intentional / regression
     - required action

2. **Item #5 — make integration emit mocks validate record shape**
   - Approved as written.
   - This is cheap and raises truthfulness immediately.

3. **Item #7 — remove or replace stale `@ts-expect-error` in `page.evaluate`**
   - Approved.
   - Default assumption: these are stale until proven otherwise.
   - Prefer deleting them over adding new ambient complexity unless the
     investigation proves a real type-boundary need.

4. **Item #6 — apple_health timeout investigation**
   - Approved.
   - Keep it factual: identify whether this is warmup or a real pathological
     test. Do not overreact.

5. **Item #9 — broaden bench coverage to the three likely hot paths**
   - Approved.
   - Keep it small and documentary, not framework-heavy.

6. **Item #11 — add CI**
   - Approved.
   - This is required for "trustworthy" status.
   - But do it in a staged way:
     - package-scoped workflow
     - path-filtered to `packages/polyfill-connectors/**`
     - start as a normal PR workflow
     - do **not** treat it as a required merge gate until it has been stable
       for at least a short proving period

### Approved, but with modified implementation shape

1. **Item #3 — remove `collect-helpers.ts` workaround**
   - Approved in spirit, **not** exactly as proposed.
   - Do **not** smear `process.argv` / entrypoint semantics into
     `runConnector()` itself unless that turns out to be clearly the cleanest
     design after a small spike.
   - Preferred shape:
     - add a tiny explicit helper like `isMainModule()` or `runConnectorIfMain()`
       in `src/connector-runtime.ts`
     - keep `runConnector()` itself focused on runtime protocol behavior
     - migrate connectors incrementally
   - Goal: remove workaround architecture without making the runtime own too
     many process-launch concerns.

2. **Item #1 — emit-order convention**
   - Approved as a direction, but it depends on Item #2.
   - Owner decision:
     - **default convention is parent-first**
   - Rationale:
     - streaming upserts
     - easier referential reasoning
     - aligns with the majority of connectors already
   - But do not blindly flip gmail/chatgpt until Item #2 confirms whether the
     current inversion is intentional design or refactor drift.
   - Once confirmed:
     - migrate to parent-first
     - update the tests
     - update `docs/authoring-guide.md`

### Narrowed / phased

1. **Item #4 — protocol-level subprocess tests**
   - Approved **only as a phased, narrow tranche**.
   - The memo's current framing is too broad and risks ballooning into a second
     test architecture.

   Phase 1:
   - build the subprocess harness
   - add protocol tests for a very small set:
     - one non-browser connector
     - one browser connector
   - prove that the harness is stable and actually catches something the current
     tests do not
   - keep it opt-in if needed while it stabilizes

   Phase 2:
   - widen only if Phase 1 proves real value without flake or heavy fixture drag

   Explicit non-goal:
   - do **not** build an expansive "real browser E2E for every connector"
     framework in one go

2. **Item #10 — lefthook staged/unstaged reconciliation**
   - Narrowed heavily.
   - Do **not** port clever merge machinery unless there is a concrete,
     reproducible data-loss case in this repo.
   - If we act here, the acceptable version is the simple one:
     - refuse auto-format on partially staged same-file changes
   - If no real user pain exists, defer it.

### Deferred / not worth doing now

1. **Item #8 — more tests because parser-heavy distribution feels imbalanced**
   - Deferred.
   - Test-count balancing is not a goal.
   - If Item #4 succeeds, reassess from actual blind spots, not from suite ratios.

2. **Item #12 — commit history cleanup**
   - Rejected for this tranche.
   - The memo already reaches the right conclusion here.

## Execution order

Proceed in this order:

### Tranche A — establish truth

1. Item #2 — pre-decomposition behavior audit
2. Item #5 — shape-validating integration emit helper
3. Item #7 — remove stale `@ts-expect-error` or document the real reason
4. Item #6 — apple_health timeout investigation

### Tranche B — remove accidental complexity

5. Item #3 — entrypoint helper / incremental `collect-helpers.ts` removal
6. Item #11 — CI workflow, initially non-blocking

### Tranche C — behavior corrections

7. Item #1 — parent-first emit ordering, **if** Tranche A confirms drift or
   confirms that standardizing is the right correction

### Tranche D — prove the protocol seam

8. Item #4 Phase 1 — narrow subprocess harness
9. Only then decide whether Item #4 Phase 2 is justified

### Optional later

10. Item #9 — extra benches
11. Item #10 — only if a real hook UX/data-loss issue is reproduced

## What I want back after Tranche A

Before any broad follow-up execution, I want one short artifact with:

- the Item #2 connector diff matrix
- whether gmail/chatgpt ordering is confirmed drift or confirmed intent
- whether the `page.evaluate` suppressions were stale
- whether apple_health was warmup-only or pathological

That artifact should let us proceed on evidence, not aesthetic momentum.

## Unblocking answer

So the direct answer is:

- **Yes, proceed.**
- But proceed with the scoped plan above, not the memo literally.
- **Do Item #2 first.**
- **Assume parent-first is the target convention unless Tranche A surfaces a
  compelling reason otherwise.**
- **Do CI.**
- **Do not let Item #4 sprawl.**
- **Do not spend time on history cleanup or test-count aesthetics.**

That is the owner-approved path.
