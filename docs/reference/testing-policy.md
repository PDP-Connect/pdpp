# Testing policy

This policy defines what evidence PDPP tests should provide and how contributors
and coding agents should change the test system. It applies to production code,
tests, fixtures, runners, and CI.

`test-accounting.manifest.json` owns executable-test accounting, suite and
profile membership, leaf commands, and declared skips. The test-accounting
runners enforce that manifest and issue receipts. Package scripts are entry
points; workflow files and repository rules/CI mode define hosted execution and
merge-required statuses. If prose conflicts with executable configuration, the
executable configuration wins.

## Objective

Optimize confidence in observable behavior per unit of execution and maintenance
cost. Do not optimize raw test count, test lines, coverage percentage, mutation
score, or a fixed unit/integration/end-to-end ratio.

A useful test detects a plausible failure at a meaningful boundary more cheaply
or reliably than the remaining suite. Expensive tests are justified when they
provide evidence that cheaper tests cannot.

## Choose the smallest sufficient oracle

Use the lowest-cost layer that preserves the required confidence:

| Risk | Preferred evidence |
| --- | --- |
| Pure rule, parser, projection, or state transition | Deterministic direct test with discriminating boundary and failure cases |
| Adapter or public contract | State-based contract test against the authoritative schema or implementation |
| Persistence, concurrency, process, or transaction behavior | Real backend or process with isolated state and controlled fault injection |
| Third-party connector behavior | Hermetic fixture or local protocol server, plus sparse independent live-contract evidence where feasible |
| Owner journey or cross-component seam | Focused integration test and a small black-box journey backstop |

Keep intentional independent evidence across security, privacy, authorization,
deletion, persistence, concurrency, data-loss, and public-contract boundaries.
Do not move a check down a layer if doing so stops testing the boundary at risk.

## Adding or changing tests

Every new or materially changed test must make these facts clear in its name,
structure, nearby comment, or change description:

1. The observable behavior, contract, or risk it protects.
2. The plausible defect that would make it fail.
3. The oracle and dependency truth source.
4. Why a cheaper existing test is insufficient.
5. Which suite, profile, backend, fixture, or environment it requires.

For regressions, prefer evidence that failed before the fix. If the same AI model
or agent produced the implementation, test, and mock, add an independent truth
source when correlated error matters: an authoritative contract, captured fixture
with provenance, relevant mutant or fault injection, real backend, or independent
review. The implementation author is not the sole judge of the test.

Test observable public state and behavior where practical. Interaction assertions
are appropriate when the interaction itself is the contract, such as avoiding a
forbidden read or preserving an exact protocol call.

When adding, renaming, or deleting an executable test file, or changing its
suite or profile, update `test-accounting.manifest.json` and run
`pnpm test-accounting:inventory`. Do not create an unaccounted package-script
side lane.

## Readability and reuse

Tests should be descriptive enough that a failure identifies the scenario and
violated property. A little duplication is preferable to helpers, loops, or
parameterization that hide the setup or oracle.

Share irrelevant construction and expensive hermetic setup when the shared
boundary has honest reset and isolation semantics. Do not pool mutable servers,
databases, clocks, or global state merely to reduce runtime.

Use data-driven matrices for exhaustive rules. Give cases stable diagnostic names;
do not unroll a clear matrix into repetitive tests solely for style.

## Fixtures, doubles, and remote services

Presubmit tests must be deterministic and must not depend on live third-party
credentials or network availability unless their profile explicitly declares that
contract.

Contributed third-party fixtures must be scrubbed and reviewed. Record source or
connector, scenario, capture date, provider/API version when known, redaction or
provenance, and the refresh owner or cadence. Cover relevant success, pagination,
auth expiry, malformed or partial data, rate limits, and absence/deletion shapes.

A mock can be wrong on day one. Validate important doubles against an independent
schema, captured response, local protocol implementation, sandbox, or scheduled
live probe. Live probes detect reachability and drift; they do not replace
deterministic semantic tests or become ordinary merge gates.

## Time, ordering, and flakes

Prefer controlled clocks, deterministic barriers, and observable conditions over
unconditional sleeps. Bounded polling is appropriate for black-box HTTP, process,
or database convergence when a private event hook would reduce fidelity.

Use real time when time or deadline behavior is the contract. Choose meaningful
ordering margins and record why they are robust.

A retry-pass is flaky, not green. Record the original outcome, retry outcome,
failure signature, revision, profile, and duration. Quarantine only to preserve
signal while repairing a test; every quarantine needs a visible owner, reason, and
expiry.

## Source and architecture policy checks

Source-reading checks can protect real architecture, security, generated-artifact,
or authorship boundaries. Do not delete them merely because they use text or a
regular expression.

Prefer AST, lint, type, import-boundary, or behavioral enforcement when it is more
semantic and equally discriminating. Any replacement must remain a required,
fail-closed, test-accounted CI gate before the original check is removed.

## Consolidating or deleting tests

Delete or consolidate a test only when all of these are true:

- A surviving test protects the same observable behavior and relevant boundary.
- The candidate has no unique edge, failure mode, regression role, truth source,
  or intentionally independent defense.
- Available branch/coverage and sampled mutation or fault evidence shows no unique
  relevant contribution, or an equivalent deterministic falsification experiment
  supplies that proof.
- The surviving test provides an equal or better oracle at lower lifecycle cost.
- Focused tests and the complete required backstop remain clean after the change.

Textual similarity, identical coverage, or a passing suite alone does not prove
zero marginal value. Consolidate in small reversible batches and preserve the
union of unique cases.

## Coverage and mutation

Coverage shows execution, not correctness or assertion strength. Use line and
branch coverage to find unexecuted critical code and to understand changed code;
do not impose a universal percentage target.

Use mutation testing on changed code or sampled risk hotspots. Cap operators,
mutants, and wall time. Triage killed, survived, no-coverage, timeout, and
equivalent-suspect outcomes separately. A survived mutant nominates investigation;
it is not an automatic requirement to add a test. Do not pursue repository-wide
mutation adequacy.

## Fast feedback and complete backstops

Use the smallest focused test set that covers the changed behavior and its
affected boundaries while iterating. Do not run unrelated package or repository
suites as a reflex. Then run the signoff gates required for the changed behavior
and boundary. Profile-gated behavior must run under the relevant profile before
the change is accepted.

An affected-test selector may become the fast PR lane only after it runs in shadow
against complete suites and demonstrates an acceptable miss rate. Selection must
model fixtures, schemas, OpenAPI, generated artifacts, CSS/source-policy files,
migrations, configuration, environment, and dynamic paths. Before an affected-test
selector becomes a fast PR lane, assign the complete accounted suites to at least
one explicit merge, scheduled, release, or audited local-signoff control lane, and
record that lane in executable configuration.

Cache only hermetic targets with every behavior-affecting input and tool/runtime
version in the key. Optimize p95 time to an actionable result and compute-minutes,
not maximum parallelism.

Bound local parallelism to the machine's capacity. `pnpm test-accounting:check`
serializes complete local accounting runs across worktrees that share a Git
repository. Package test entry points and direct accounting leaves default to two
concurrent Node test files locally; hosted CI retains its worker-sized default
unless a suite declares a tighter limit. Do not bypass these controls or start
overlapping broad suites in separate agent sessions. CI may use a higher explicit
limit when its worker size and memory budget justify it.

## Evidence required in a change

Report:

- the behavior preserved or intentionally changed;
- the focused and signoff commands actually run;
- the required profiles/backends and whether they ran;
- coverage, mutation, timing, or flake evidence when the recommendation depends on it;
- any unverified boundary or unavailable external service.

Do not weaken assertions, add skips, special-case production code, or update fixtures
solely to make a failing change green.

## Execution references

- `CONTRIBUTING.md` — contributor quickstart and common commands
- `test-accounting.manifest.json` — suite, profile, command, and skip authority
- `scripts/test-accounting/` — inventory, authority, execution packets, and receipts
- `docs/reference/ci-mode.md` — local and hosted signoff mechanics
- `docs/reference/local-testing-e2e.md` — local end-to-end operator runbook
- Package-local `AGENTS.md` and READMEs — subsystem-specific additions to this policy
