# Overnight Worker Brief: TS + Ultracite + A++ Refactor Across the Live Codebase

This brief is for a worker agent operating in a dedicated worktree.

The goal is not to "make the repo look more modern." The goal is to move the
live codebase toward the same standard we reached in
`packages/polyfill-connectors`: higher tooling floor, cleaner seams, stronger
proof, less accidental complexity, and a more obviously elite 2026 codebase.

This is not about connectors specifically. It is about applying the same
quality doctrine to the rest of the app.

## Core standard

Use this blend of values:

- **Rich Hickey**: remove accidental complexity; preserve essential complexity
  honestly instead of hiding it behind abstraction theater.
- **Uncle Bob / DRY**: remove duplication when it improves clarity and reduces
  drift; do not chase abstraction for its own sake.
- **SLVP-inspired**: choose the smallest lovable/provable vertical slice that
  materially raises quality, then ship that slice green before moving on.
- **Modern elite codebase**: strong types, strict toolchain, import-safe
  modules, behavior-level tests, readable boundaries, honest performance
  claims, no shortcut culture.

The reference exemplar is not the connector domain itself. The exemplar is the
quality bar established in:

- `packages/polyfill-connectors/AGENTS.md`
- `packages/polyfill-connectors/docs/authoring-guide.md`
- `packages/polyfill-connectors/docs/aplusplus-followups-memo.md`
- `packages/polyfill-connectors/docs/aplusplus-closure-instruction-2026-04-23.md`

## Mission

Apply the same TS + Ultracite + honest A++ refactor standard across the live
codebase, iteratively, all night, in a way that produces multiple independently
mergeable green slices rather than one giant half-finished rewrite.

By morning, success means:

- multiple high-quality green commits
- materially safer and cleaner code in real packages
- stronger package-local verification
- higher consistency of structure and tooling
- no obvious "migration hack" smell

Success does **not** mean:

- every file in the repo is migrated
- every config is globally unified
- every package is fully strict in one pass
- the branch looks impressive but is operationally risky

## Worktree assumption

You are operating in a dedicated worktree on a dedicated branch.

That means:

- do not worry about conflicts in the main checkout
- do not avoid important files just because they are hot in another branch
- still keep slices coherent and green
- still avoid giant multi-system rewrites when a narrower slice is better

## In scope

Live codebase only:

- `reference-implementation/`
- `packages/reference-contract/`
- `apps/web/`
- `packages/pdpp-brand/`
- root config/scripts only where necessary to support the quality floor above

Out of scope by default:

- `packages/polyfill-connectors/` except as the quality exemplar
- `demo_archived/`
- generated outputs
- `.next/`
- fixtures and captured artifacts
- lockfile churn unless truly needed
- protocol/OpenSpec changes unless a concrete contradiction forces them

## What "same treatment" means in practice

### 1. Raise the tooling floor

Move packages toward the same kind of floor established in
`polyfill-connectors`:

- TypeScript as the real implementation language where code is still JS
- Ultracite as a real gate, not a decorative dependency
- no `any`
- no `@ts-ignore`
- no non-null assertion `!`
- no `as unknown as X`
- no lazy suppression culture
- cognitive complexity kept low by design, not ignored by default

### 2. Raise the structural floor

Make the code easier to reason about:

- split pure logic from runtime glue where it materially helps
- prefer typed boundary parsing over scattered assertions
- prefer narrow helpers over giant utility dumping grounds
- make entrypoints import-safe and testable where applicable
- keep one clear source of truth for important semantics

### 3. Raise the proof ceiling

Do not stop at "tsc passes."

When behavior-affecting code changes:

- add or strengthen tests at the real boundary affected
- prefer orchestration-level proof over internal mock theater
- measure if the refactor changes a performance-sensitive shape
- write down intentional behavior changes when they matter

## Package-by-package intent

### `packages/reference-contract`

This is a strong early target:

- contained surface
- mostly pure logic
- lower coordination risk
- a good place to establish package-local TS + Ultracite + verify discipline

Target outcomes:

- JS source migrated to TS where practical
- package-local `typecheck`, `check`, `verify` scripts if missing
- exports remain stable
- code becomes obviously typed-at-the-boundary rather than asserted-through
- tests still green

### `reference-implementation`

This is the biggest payoff area and the biggest surface still in JS.

Target outcomes:

- migrate JS to TS in vertical slices
- start with leaf/helper modules before central orchestrators when practical
- keep server/runtime behavior stable
- add tests around any behavior-sensitive refactor
- improve architecture without secretly redesigning the product

### `apps/web`

This is already TS, but not at the same bar.

Target outcomes:

- introduce or tighten Ultracite discipline in a way that fits the Next app
- improve types and module boundaries
- reduce complexity and implicitness
- raise the floor honestly instead of flipping a giant strictness switch and
  drowning in noise

### `packages/pdpp-brand`

Tiny cleanup only.

If it is cheap, bring it under the same floor. If it is already fine, do not
manufacture work.

## Operating mode: long-running iterative loop

This is not a one-shot migration.

Run this loop repeatedly until blocked, exhausted, or the branch has delivered
obvious value:

1. Re-orient on the highest-value tractable slice.
2. Choose one coherent slice.
3. Make that slice green.
4. Prove it.
5. Commit it.
6. Reassess.
7. Continue.

Do not keep a giant red tree alive for hours.

## Slice selection rules

Choose slices that are:

- high leverage
- low enough risk to finish green
- locally provable
- meaningful on their own

Bias toward:

- leaf modules before central orchestrators
- contained package-level wins before repo-wide config moves
- areas with existing tests
- areas where unsafe shortcuts can be removed cleanly
- vertical slices that produce a credible commit narrative

Avoid:

- massive blind `.js -> .ts` rename floods
- flipping global strictness before code can satisfy it
- broad abstraction projects
- style churn with no floor/ceiling improvement
- "one last huge slice" behavior after you already have green commits

## Required per-slice loop

Every slice must go through this exact discipline:

### A. Orient

Before touching code:

- read the relevant package config
- read nearby tests
- understand the current module boundary
- state the likely proof strategy for the slice

### B. Refactor narrowly

Make the smallest change that produces a real quality increase.

Examples:

- migrate one helper cluster from JS to TS
- add package-local `check` / `typecheck` / `verify`
- replace boundary assertions with typed parsing in one sub-area
- split one orchestration file at a meaningful seam
- reduce complexity in one hot path and add proof

### C. Prove

At minimum, after every slice:

- reread every touched file
- grep for stale patterns in the touched area
- run the narrowest honest checks for that slice
- if behavior changed or could have changed, add/adjust tests
- rerun until green

### D. Commit

Do not batch unrelated wins into one blob.

Commit every green slice with a precise message.

Good examples:

- `reference-contract: migrate builders to TS and add verify`
- `reference: convert metadata helpers to TS and tighten tests`
- `web: add ultracite checks and simplify server-side search helpers`

### E. Reassess

After each commit:

- identify the new highest-value next slice
- choose the next tractable unit
- continue

## Hard evaluation criteria

The worker needs strong pass/fail gates to sustain quality overnight.

### Slice scorecard

A slice is only done if all are true:

1. **Floor raised**
- fewer unsafe shortcuts than before
- type coverage or lint discipline improved materially

2. **Structure improved**
- the code is easier to read or reason about
- complexity moved down, not sideways

3. **Proof added**
- relevant tests/checks exist and pass
- risky behavior changes are pinned

4. **No migration smell**
- no half-renamed imports
- no temporary hacks left unexplained
- no giant suppression blocks hiding new debt

5. **Mergeable in isolation**
- the commit could be reviewed and merged on its own

If any of these is false, the slice is not complete.

### Package scorecard

A package is materially improved only if:

- its touched surface is under real TS + Ultracite discipline
- it has usable local verification commands
- the boundary logic you refactored is actually proven
- the resulting code looks intentional, not transitional

## Verification strategy

Every slice:

- run the narrowest honest verification that covers the touched area

Every package checkpoint:

- run the broader package test suite
- rerun package-local `typecheck` / `check` / `verify`

Periodically:

- rerun broader repo checks if you changed shared config or scripts

Prefer adding package-local scripts such as:

- `typecheck`
- `check`
- `verify`

Where those scripts do not exist, creating them is in scope if it improves the
package's quality floor.

## Configuration strategy

Do not start by forcing one giant repo-wide config unification.

Instead:

- make package-local progress first
- add package-local Ultracite + TS discipline where needed
- only generalize upward when the code is ready

It is acceptable to:

- add per-package config to raise the floor honestly
- keep root orchestration light initially
- grow toward unification later if it reduces friction without weakening the
  existing bar

It is not acceptable to:

- weaken `polyfill-connectors`
- introduce a root config that creates fake compliance
- declare victory on a package because config exists while the code still
  cannot satisfy it

## Architectural principles for refactoring

Use these decision rules:

### Essential complexity vs accidental complexity

Ask:

- is this branching inherent to the domain or caused by poor structure?
- is this helper clarifying the logic or just moving text around?
- is this abstraction compressing duplication or hiding the truth?

Keep essential complexity visible and named.
Delete accidental complexity aggressively.

### DRY with judgment

Eliminate duplication when it:

- reduces semantic drift
- strengthens a boundary
- makes testing easier
- clarifies intent

Do not DRY unrelated flows into generic mush.

### Prefer truthful boundaries

Good:

- parsing/validation at edges
- explicit data shapes
- narrow interfaces
- import-safe entrypoints

Bad:

- scattered `as` assertions
- utility god-files
- hidden side effects at import time
- test seams that don't match runtime reality

## What not to do

Do not:

- rewrite the whole repo in one go
- flip every package to full strictness immediately
- build frameworky abstractions just because several files are messy
- perform style-only churn
- invent a giant migration harness before the first few slices prove the need
- silently change product behavior without proof
- claim performance wins without numbers
- confuse more code with higher quality

## Practical priorities

Suggested order:

1. `packages/reference-contract`
2. `reference-implementation` helper and leaf modules
3. `reference-implementation` larger seams
4. `apps/web` floor-raising and structural cleanup
5. `packages/pdpp-brand` if worth doing

This order is not mandatory. If one package is stuck, move to the next best
tractable slice and keep grinding.

## Stop-and-report conditions

Stop and report instead of improvising if:

- a strictness/config flip explodes into an unpayable error flood
- a refactor requires a real product or protocol decision
- a linter rule would require a broad rewrite with poor ROI
- a package would only "pass" by weakening the bar
- the proof strategy for a risky refactor becomes dishonest or too indirect
- progress stalls on one heroic file for too long

If blocked:

- shrink the slice
- move to a lower-conflict, high-value sub-area
- keep the branch accumulating green wins

## Expected nightly rhythm

The branch should tell a story like this:

1. establish or tighten package-local floor
2. migrate a contained cluster
3. add proof
4. commit
5. repeat

By morning, I want to see:

- several green commits
- clear upward motion in at least two live packages
- stronger scripts/configs
- fewer unsafe patterns
- more obvious architectural intent

Not:

- one giant unstable migration branch
- 50 renamed files with weak proof
- a config story that outruns the code

## Final report format

When you stop, report in this exact shape:

1. `Completed slices`
2. `Commit list`
3. `Packages/modules materially improved`
4. `New or changed verification commands`
5. `Tests/checks run`
6. `Remaining hotspots`
7. `Recommended next slice`

## Definition of success

The standard is not "maximal churn."

The standard is:

- higher floor
- clearer boundaries
- less accidental complexity
- more trustworthy proof
- stronger package discipline
- a branch made of multiple green, high-quality slices

That is what "same TS + Ultracite + A++ refactoring across the whole app"
means here.
