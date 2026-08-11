## Context

See `proposal.md` for motivation. PDPP uses Node's built-in test runner with `tsx`, a fail-closed test-accounting manifest, and several bespoke falsifiability tools. Two current examples are `scripts/test-migration/mutation-oracle.ts`, which applies named defects and proves rollback, and `packages/polyfill-connectors/scripts/mock-mutation-check.ts`, which mutates fake-server path facts. These tools produce useful evidence but have different inputs, classifications, and receipts.

The repository is large enough that exhaustive mutation is an unattractive default. Tests also span subprocesses, databases, browsers, fixtures, and dynamic inputs, so a library's import graph cannot be the sole selection authority. Local execution must respect constrained-host concurrency controls.

## Goals / Non-Goals

**Goals:**

- Make deliberate-fault evidence deterministic, reviewable, replayable, and cheap enough for routine agent use.
- Reuse existing test accounting, local resource controls, and falsifiability oracles.
- Optimize useful risk findings per reviewer-minute and compute-minute.
- Create an adapter boundary that permits domain operators, third-party engines, and later agent-generated mutants.

**Non-Goals:**

- A repository-wide mutation score or a 100% mutation target.
- Exhaustive mutation of the monorepo.
- Automatic test generation, deletion, or quality grading.
- Mutating live services, personal data, or credentialed browser sessions.
- Replacing coverage, integration tests, or existing conformance harnesses.

## Decisions

### 1. The stable abstraction is a risk-falsification packet, not a mutation engine

A packet carries the risk source, exact mutation, expected affected behavior, selected tests, backstop, and budget. A receipt carries what ran and what happened. Generators and runners sit behind adapters.

This keeps StrykerJS, bespoke TypeScript transforms, historical bug patches, and future agent-generated mutations interchangeable. It also makes the judgment boundary explicit: generators propose faults; deterministic tests and receipt validation judge them.

Alternative: make StrykerJS configuration the architecture. Rejected because PDPP primarily uses `node:test` through `tsx`; StrykerJS has no native Node test-runner integration, and its command runner loses per-test intelligence. It remains a useful feasibility adapter for pure, precompiled TypeScript islands.

### 2. Start by wrapping the test-migration oracle

The first adapter will express the named cases from `scripts/test-migration/mutation-oracle.ts` as packets and preserve its byte-identical rollback proof. This surface is small, deterministic, already falsifiable, and has no live-service dependency. It proves the substrate without first inventing a source transformer.

After the substrate works, add two or three domain mutations on one small high-risk pure surface. Good candidates include authorization decisions, projection/filter boundaries, or connector cursor/frontier rules. Select the final target by runtime, isolation, and the availability of an independent oracle.

Alternative: begin with all connector path mutations. Rejected for the first slice because the current connector tool intentionally reports many unknown surfaces and has broader runtime variability.

### 3. Use explicit selection first, then measure smarter routing

Version one packets name focused tests and a relevant accounted backstop. The runner does not infer completeness from static imports. It records both results so later analysis can measure whether focused selection missed a kill found by the backstop.

Later routing may combine changed-code coverage, import and literal-input graphs, historical failures, and test accounting. It may become a fast lane only after shadow comparisons establish an acceptable miss rate.

Alternative: immediately implement whole-repository per-test coverage selection. Rejected because it adds substantial instrumentation cost before the packet and receipt model is proven.

### 4. Execute in disposable workspaces with baseline-first judgment

The executor uses a clean, disposable worktree or fixture repository. For each packet it:

1. validates revision and packet bindings;
2. runs the focused clean baseline;
3. applies one mutation;
4. runs the focused tests;
5. optionally runs the declared backstop according to packet policy;
6. restores and verifies the exact tree;
7. emits and validates a receipt.

Killed requires a passing baseline plus a mutation-present failure attributable in the receipt. A green mutant is survived unless execution evidence supports not-exercised, or a reviewer records equivalent-suspect or uninteresting with independent justification.

Alternative: edit the developer's working tree and revert files in place. Rejected because interruption, concurrent agents, and unrelated dirty changes make cleanup evidence weaker.

### 5. Bind receipts to content and effective execution

Canonical JSON packets and receipts use a versioned schema. Content hashes bind the packet, base tree, mutated target before and after, mutation patch/operator parameters, exact effective argv, selected profile, captured results, and restored tree. The runner writes receipts atomically. Validation recomputes bindings and rejects partial or forged records.

The schema records generator kind and provenance without assigning it authority. A later agent-generated mutant therefore remains a proposal judged by deterministic execution.

Alternative: human-readable logs only. Rejected because agents cannot reliably compare, replay, or audit unbound prose.

### 6. Calibrate with outcome distributions, not an aggregate score

The pilot records killed, survived, not exercised, timeout, execution error, equivalent-suspect, and uninteresting counts by operator and risk source. Primary operating measures are productive-mutant rate, actionable-survivor rate, reviewer time, compute time, focused-to-backstop miss rate, cleanup failures, and flaky baseline rate.

No aggregate mutation percentage gates a pull request. A future gate must be scoped to a stable risk/operator class and justified by observed signal and cost.

## Risks / Trade-offs

- **Mutants are easy to generate but expensive to judge** → cap packets, suppress obviously arid targets, and measure actionable findings per reviewer-minute.
- **Equivalent or uninteresting mutants create false urgency** → preserve distinct classifications and require recorded triage rather than forcing tests to kill everything.
- **Focused selection misses dynamic dependencies** → require an explicit backstop and measure focused-to-backstop misses before using selection as a gate.
- **Mutation trials overload local hosts** → use finite packet budgets, low default concurrency, and the repository's cross-process local test guard.
- **An interrupted mutation contaminates later work** → use disposable workspaces, atomic receipts, bounded cleanup, and exact tree-identity verification.
- **The same agent authors code, mutant, and test** → treat generator output as untrusted; require deterministic oracles and preserve generator/reviewer provenance.
- **A generic engine becomes a maintenance burden** → keep it behind the adapter contract and continue only if a measured pilot outperforms focused domain operators.

## Migration Plan

1. Add schemas, validators, receipt verification, and adversarial self-tests.
2. Wrap the existing test-migration oracle and run it locally in advisory mode.
3. Add one bounded domain pilot and compare focused tests with its accounted backstop.
4. Run a separate StrykerJS feasibility experiment on precompiled pure TypeScript; retain it only if setup, routing, and signal costs are competitive.
5. Review pilot evidence before adding CI scheduling, additional operators, or any narrow blocking rule.

Rollback removes the advisory entry point and generated receipts. Existing mutation oracles remain independently runnable until their adapter demonstrates equivalent evidence.
