# Testing policy

This policy defines what evidence PDPP tests should provide and how contributors
and coding agents should change the test system. It applies to production code,
tests, fixtures, runners, and CI. It also says how to run the tests on a host
that other people and agents share ([Running tests](#running-tests),
[Isolation contract](#isolation-contract)), what the runs cost
([Measured cost](#measured-cost)), and where the suite still falls short of
good practice ([Gap to excellence](#gap-to-excellence)).

`test-accounting.manifest.json` owns executable-test accounting, suite and
profile membership, leaf commands, and declared skips. The test-accounting
runners enforce that manifest and issue receipts. Package scripts are entry
points; workflow files and repository rules/CI mode define hosted execution and
merge-required statuses. If prose conflicts with executable configuration, the
executable configuration wins.

## Running tests

Use the cheapest tier that answers your question. Run the full gate once, on the
exact head, before you merge.

- Editing a file: `pnpm test:fast`.
- Done with a change to one package or app, before you push: run each suite that
  owns a file you changed. A suite owns the files that match its `include` globs
  in `test-accounting.manifest.json`; `pnpm test:fast --dry-run` also names the
  suites for your diff.
- Done with a broad change (more than one suite, or shared config such as
  `package.json`, `tsconfig` or the accounting scripts), and before any merge:
  the full gate.
- A pull request into a branch other than `main` starts no pull-request workflow,
  so run the full gate on the pushed head and report it.

| Tier | Command | Run it | What runs | Gate? |
| --- | --- | --- | --- | --- |
| Edit loop | `pnpm test:fast` | While you edit | Tests that the diff can affect | No |
| One suite | `pnpm test:scratch -- node --import tsx scripts/test-accounting/authority.ts --run --suite <id>` | Before you push, for each suite you changed | Every file of one suite, with a receipt | No |
| Full gate | `pnpm test-accounting:check` | Once on the exact head before you merge | Inventory closure, all suites, receipts | Yes: the local gate |
| CI | `workspace-tests` workflow | Automatically, for `main` | The full gate, on a hosted runner | Runs on pull requests into `main`; not a required check (see Gap to excellence) |

The suite ids are in `test-accounting.manifest.json`: `root-node`,
`scratch-lifecycle`, `root-shell`, `reference-contract`, `list-envelope`,
`conformance-suite`, `display`, `reference-operations-sandbox`, `operator-ui`,
`brand-react`, and `site`.

**`pnpm test:fast`** is for the edit loop. It is never a gate and it prints what
it selected and why. It compares your working tree, including untracked files,
with the merge base of `origin/main` (pass `--base <ref>` when you work on a
stacked or integration branch). A changed test file runs. A changed source file
under `scripts/`, `packages/*` or `apps/site` runs every test that imports it,
directly or through other modules, found by scanning import statements. A
changed `packages/*/package.json` runs every test in that package and every test
that imports it. Each selected group runs through its suite's own manifest
command, so the reporter and per-file isolation are the same as in the gate. If
a group selects files but runs zero tests, the run fails.

`pnpm test:fast` falls back to every unit-test file of every suite when it cannot
map the change. The fallback happens for:

- a deleted file;
- a global input: root `package.json`, `pnpm-lock.yaml`, the manifest, a
  `tsconfig`, or the accounting, scratch, hermetic or sandbox scripts;
- a changed file that is not recognized source, such as Markdown, YAML or JSON,
  so a docs-only change takes this path;
- a source file that no test reaches.

A test whose imports include a computed path runs on every source change.
`--dry-run` prints the selection as JSON without running anything. `--all`
forces the fallback. The fallback skips inventory closure and receipts, so it is
still not the gate.

**Suite runs** go through the accounting authority
(`scripts/test-accounting/authority.ts`). Before it selects a suite, it runs a
global inventory check: every executable test file in the repository must belong
to a suite or to the manifest's exclusion list, so one unaccounted test file fails
a single-suite run too. Then it runs the selected suite's files, checks that every
planned file ran, and writes a receipt, a JSON record of the run. The authority
refuses to start on a dirty source tree, including untracked files, so commit
first. A suite run does not replace the full gate, which runs every suite.

**The full gate** (`pnpm test-accounting:check`) checks inventory closure (every
tracked executable test file is listed in exactly one suite, or in the
manifest's exclusion list with an owner and an expiry), runs all suites, and
verifies a receipt for each. Locally it runs two suites at a time, so up to four
test files run at once (two suites, two files each); the sandbox caps the whole
run at 400% CPU. Set `PDPP_ACCOUNTING_SUITE_CONCURRENCY` to
change that, and note that a wider run costs more memory without a shorter wall
time (see [Measured cost](#measured-cost)). Each Node test leaf also runs two
test files at a time locally. Only one full gate runs at a time per Git
repository (see [Isolation contract](#isolation-contract)).

**CI.** `workspace-tests` runs the full gate with `CI=true` on every pull
request into `main` and on every push to `main`. With `CI=true` the gate skips
the local full-suite lock and the local two-file concurrency, and the suites run
one at a time. A few path-scoped workflows (`test-accounting`, `conformance`,
`test-scratch-lifecycle`, `site-generated-docs-check`) also run on pull requests
into `main`. Pull requests into any other branch, such as an integration branch,
start no pull-request workflow, so the full gate does not run for them. They are
gated by the full gate run locally on the exact head, plus review. Two workflows,
`consumer-drift-signal` and `community-invite-liveness`, have a `push` trigger with
path filters and no branch filter, so a push to any branch that touches their
paths starts them. Neither runs the test gate. To run a hosted check on any
pushed branch, use `gh workflow run workspace-tests.yml --ref <branch>`. Because
CI skips the local concurrency, run each suite you changed once with `CI=true`
before you push (see `CONTRIBUTING.md`).

## Isolation contract

Every command that `pnpm test:fast`, `pnpm test:scratch -- ...` and
`pnpm test-accounting:check` start runs inside the vendored `test-sandbox`
(`scripts/test-sandbox/`). A bare `node --test`, `tsx file.test.ts` or other
direct command is a bypass of this contract. If you wrap a command in your own
`test-sandbox --`, the inner call runs directly and does not take a second slot.

| Scope | What is isolated or limited | How |
| --- | --- | --- |
| Shared by every run on the host | The pnpm store and the source tree. Tests run TypeScript directly with `tsx`, so no build step writes into the tree, except the generated site files described below. | Nothing to do; do not write into the tree from a test. |
| Per checkout | The tsx transform cache and Node's compile cache, which persist between runs so unchanged files are not transformed or compiled again. Both key on file content and path, so a checkout never hits another checkout's entries. | `scripts/hermetic/test-caches.ts` keeps them in `node_modules/.cache/pdpp-test/`, so they go away with the checkout. It sets `NODE_COMPILE_CACHE` to that directory and links `$TMPDIR/tsx-<uid>` to it. tsx drops its entries after about eight days; the launcher drops compile-cache entries older than 14 days. Delete the directory to start cold. |
| Shared admission, per user | One `agent-tests` user slice (`systemd-run --user`) with six slots by default. The slots belong to one user, so another user on the same host gets its own. A run waits when all of its user's slots are busy. | `test-sandbox` takes a slot with a file lock in `agent-tests/slots/` under `$XDG_RUNTIME_DIR` (`~/.cache` when it is unset). `TEST_SANDBOX_SLOTS` changes the count and `TEST_SANDBOX_STATE_DIR` the directory. Start at most two test commands at once from one session. |
| Per run | CPU, memory and task caps (defaults: 400% CPU, 8 GB, 4096 tasks), a loopback-only network, a private `/tmp`, and an owned scratch root that `TMPDIR` points to. When the run ends, the scope kills every descendant and the launcher removes the scratch root. | A transient systemd scope plus bubblewrap. `TEST_SANDBOX_CPU`, `_MEM` and `_TASKS` change the caps. One JSON receipt (wall time, CPU-seconds, peak memory, peak process count, the enforcement that applied) goes to stderr. |
| Per test file | Process isolation. | `node --test` runs each file in its own process. |
| Locked | One full gate at a time per Git common directory, so worktrees of one repository queue. | `scripts/test-accounting/with-local-full-suite-lock.mjs`. CI skips it. |

**Direct runs and the host tsx cache.** A bare `tsx` or `node --import tsx`
command keeps its transform cache in the host `$TMPDIR/tsx-<uid>`, shared by every
checkout of that user. tsx expires entries by age, not by count. On the shared agent
host the directory reached 120,000 entries (2.9 GB), and every process that missed
the cache then scanned it, which added about 0.25 CPU-seconds per process. If a
direct run feels slow, run `rm -rf "${TMPDIR:-/tmp}/tsx-$(id -u)"`.

**Generated files.** The `site` suite's `prepare` step
(`apps/site/scripts/sync-spec-docs.mjs`) writes `apps/site/src/generated/` and
generated `.mdx` pages under `apps/site/content/docs/`. Git ignores all of them, so
a clean `git status` does not show them. The `root-node` suite's
`authority-prepare` test deletes and rebuilds `spec-front-matter.ts` in that
directory. The authority runs prepare suites alone, but only within one
invocation, and the full-gate lock does not cover single-suite runs. So two
invocations in one checkout can race on these files. To run `site` and
`root-node` at the same time, use separate worktrees. The authority's clean-tree
checks do not see ignored files.

Without systemd or bubblewrap the sandbox still runs the command, and the
receipt says which limits did not apply. Set `TEST_SANDBOX_REQUIRE=1` to make
that an error. Set `TEST_SANDBOX_DISABLE=1` to bypass the sandbox while you
diagnose a problem; the scratch root and its cleanup still apply.

**Host networking and Postgres.** Inside the sandbox, `127.0.0.1` is the
sandbox's own loopback. A service on the host's loopback, such as a dev server
or a local Postgres, is unreachable. A test must start the servers it needs
itself, on loopback, and the suites do. No suite in this repository needs
Postgres today. If a test needs one:

- For a disposable Postgres, run `scripts/test-sandbox/test-sandbox --pg 18 -- <command>`
  (16 also works). It starts a Postgres on `127.0.0.1:55447` inside the sandbox,
  sets `DATABASE_URL`, `PGHOST`, `PGPORT` and `PGUSER`, and removes it at exit.
  `--pg-port` and `--pg-env` change the port and the variable name. `--pg` needs
  the loopback-only network and bubblewrap.
- For a test that must reach a service on the host, set `TEST_SANDBOX_NET=host`.
  This gives up network isolation for that run; keep it out of anything that
  becomes a suite.

**Network guard.** The sandbox cuts the network at the operating-system level.
The canonical launchers (the accounting authority, the package test runner and
the scratch owner) also set `PDPP_HERMETIC_GUARD=1` and preload
`scripts/hermetic/preload.mjs`, an in-process guard that refuses HTTP requests
to origins the test did not start; a server the test binds is allowed until its
`close()` is called. It is a tripwire for accidental egress, not a security
boundary. It does not check a request that brings its own `agent` or
`dispatcher`, a boxed `String` URL, a relative Unix socket path after `chdir`,
a socket adopted from a file descriptor, or a request already queued in an agent
when its server closes.

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

## Measured cost

These are the measurements that this repository has. Each states its date and
conditions. Wall time depends on host load; CPU-seconds and peak memory are the
steadier numbers. `test-ab` is an interleaved A/B runner (not in this
repository) that runs both sides alternately and reports the median and the
minimum to maximum range of wall time, CPU-seconds and peak memory. When the
two sides' ranges overlap, the difference is noise, and the table says so.

| What | Result | When and how |
| --- | --- | --- |
| Full gate at `main` `4e3909cd` | 52.0 s wall, 73.5 CPU-s, 761 MB peak; 152 files, 1308 assertions; 21 failing | 2026-10-17, before the gate fixes; different code from the next row, so the change between them is not a measure of any one fix |
| Full gate on the integration branch after PR #437 | 36.0 s wall, 98.6 CPU-s, 834 MB peak; 181 files, 1758 assertions; 0 failing | 2026-10-18, inside `test-sandbox` |
| `workspace-tests` in CI | About 89 s | One hosted `ubuntu-latest` run, 2026-10-18 |
| `pnpm test:fast`, no change | About 1 s | 2026-10-18, `test-ab -n 3`, loaded shared host (load not recorded) |
| `pnpm test:fast`, one-line change to a root script | 1.5 to 6 s | 2026-10-18, `test-ab -n 3`, loaded shared host (load not recorded) |
| `pnpm test:fast`, one-line change to a package | 6 to 15 s | 2026-10-18, `test-ab -n 3`, loaded shared host (load not recorded) |
| `root-node` suite, PR #437 | 42.7 s to 9.4 s wall (-78%); CPU 17.1 s to 16.5 s (noise); peak memory 197 MB to 276 MB | `test-ab`, 3 runs a side, interleaved, 2026-10-18 |
| `reference-contract` suite, PR #429 | Wall 3.86 s to 2.72 s and 4.72 s to 3.29 s (about -30%); CPU about -34% | `test-ab`, two comparisons of 3 runs a side, 2026-10-18 |
| Two suites at a time, PR #430 | Wall 81.6 s to 51.4 s (-37%); CPU 100.9 s to 109.6 s (noise); peak memory 689 MB to 850 MB (+23%). Three suites at a time instead of two: no wall gain, about 6% more peak memory | `test-ab`, full gate, 3 runs a side, 2026-10-18 |
| Sandbox overhead (PR #427) | Wall 72.6 s to 76.4 s (noise); CPU 90.2 s to 97.1 s (noise); peak memory 656 MB to 702 MB, +46 MB (the ranges do not overlap) | 2026-10-18, `test-ab -n 3` (3 runs a side): integration `d10d759c` without the sandbox against `a270cb63` with it, full gate through `run-command`, start-of-run host load 26 to 64 |

The suite grew between the first two rows: 29 more files and 450 more
assertions, including the conformance suite. The CPU-seconds rise (73.5 to 98.6)
follows that growth; PR #430 measured the two-at-a-time schedule's own CPU change
as noise. The 52.0 s and 36.0 s figures are therefore not a like-for-like
speed-up.

## Gap to excellence

The comparison below uses an internal cross-project study of 37 well-regarded
test suites (15 patterns and a comparison matrix); the exemplar column names the
project each practice comes from. "Closed" means PDPP does the practice today.
"Partly" means it does part of it, and the table says which part. "Open" means
it does not do it. A "shadow" run, used in one row, runs a new selector next to
the full suite and compares what each one catches.

| Exemplar practice (project) | PDPP today | Measured | Status |
| --- | --- | --- | --- |
| Fast gate on the integrated candidate: each change is tested against the latest base before it merges (Rust bors, Kubernetes Tide, Shopify merge queue) | The full gate runs on pull requests into `main` and on pushes to `main`. There is no merge queue. The ruleset for `main` requires a pull request and the `DCO` status check only; `workspace-tests` is not a required check and branches need not be up to date (read from the repository rules, 2026-10-18). A red `main` is found by the push run. Pull requests into an integration branch start no pull-request workflow. | None | Open |
| Slower scheduled tiers after the fast gate (CPython buildbots, CockroachDB nightlies, OpenJDK tier 2 to 4) | No scheduled test tier. The only scheduled workflows are a weekly probe that community links still work and a nightly supporters publish. There is no soak, ecosystem or live-connector tier. | None | Open |
| Change-based selection with a full-run backstop (Shopify, Meta, Zed) | `pnpm test:fast` selects by import graph and falls back to every test when it cannot map a change. The backstop is the full gate on every pull request into `main`. | `test:fast` about 1 to 15 s | Closed |
| The selector's miss rate is measured (Shopify 99.94% recall over 8,360 commits; Meta over 95% of failures caught) | `test:fast` has never run in shadow against the full gate, so its miss rate is unknown. This is why it is never a gate. | None | Open |
| Flakes are owned: no automatic retries, quarantine with an owner and an expiry (Kubernetes, OpenJDK ProblemLists) | No retry in the authority or the workflows. A retry-pass counts as flaky (see Time, ordering, and flakes). The quarantine mechanism is a manifest exclusion with a reason, an owner and an expiry. | None | Closed |
| Flakes are counted and routed: recurrence is tracked and a failure matches a known issue (Go watchflakes, Meta flakiness score) | No flake ledger, no failure signatures, and no flake rate is collected. | None | Open |
| Every fix ships a regression test that fails without the fix (Django, TypeScript, Node.js, Rails) | Reviewers ask for the fail-before output and the pass-after output. This policy says "prefer" where the exemplars say "must", and no tool checks it. | None | Partly: required in review, not checked by a tool, and this policy says "prefer" |
| Tests are checked for silent non-discovery (CPython's discovery-count test, Astral's undiscovered Markdown tests) | Inventory closure fails when an executable test is not planned. The authority checks that every planned file ran, and `test:fast` fails when selected files ran zero tests. | None | Closed |
| Test the tests with seeded faults or sampled mutation (SQLite, etcd, Rust) | A few authority tests seed a fault, for example removing the suite-concurrency bound makes `4 !== 2` fail (PR #430). This policy asks for sampled mutation on changed code, but this repository has no mutation tooling and no routine seeded-fault run. | None | Open |
| Cost measured as a vector, not wall time alone (a libeatmydata case where wall time fell and CPU did not; a Jest case where fewer workers cut both) | Every sandboxed run prints wall time, CPU-seconds, peak memory and peak process count. Performance changes carry an interleaved A/B with all three. No history is stored and no budget is enforced. | See Measured cost | Partly: measured per change; no history and no budget |
| Admission per host, not per runner: per-build worker limits do not bound several suites on one host | The `agent-tests` user slice, six slots per user, per-run caps, and a full-gate lock per Git repository. A raw command still bypasses them, and the sandbox needs systemd and bubblewrap for full enforcement. | Sandbox overhead noise, +46 MB | Partly: per user, not per host. Closed for runs through the launchers; a raw command bypasses it; not applicable on CI (one job per runner) |
| Oracles borrowed from outside the project (Deno and Bun with the Node.js suite, Oxc with Test262, Kubernetes conformance) | The `conformance-suite` runs the Core v0.1 MUST clauses against the reference implementation at a pinned commit, and the `conformance` workflow compares every result with an expected file on pull requests that touch the suite or `spec-core.md`. | None | Partly: the oracle is PDPP's own spec run against its own reference implementation, not an outside suite |
| Randomized or simulated testing that replays from a seed (FoundationDB, TigerBeetle) | None. The runtime moved to `data-connect`, so there is little state to simulate here. | None | Not applicable |
| Numeric coverage gate (SQLite, Hypothesis; contested elsewhere) | None, by policy (see Coverage and mutation). | None | Not applicable |

## Execution references

- `CONTRIBUTING.md` — contributor quickstart and common commands
- `test-accounting.manifest.json` — suite, profile, command, and skip authority
- `scripts/test-accounting/` — inventory, authority, execution packets, and receipts
- `docs/reference/ci-mode.md` — local and hosted signoff mechanics
- `scripts/test-fast.ts` and `scripts/test-sandbox/README.md` — the edit-loop selector and the sandbox contract
- `docs/reference/local-testing-e2e.md` — local end-to-end operator runbook
- Package-local `AGENTS.md` and READMEs — subsystem-specific additions to this policy
