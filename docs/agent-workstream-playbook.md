# Agent Workstream Playbook

This document is the operating system for multi-agent work in this repo. It
does not replace `AGENTS.md` or OpenSpec:

- `AGENTS.md` contains the hard repo rules every agent must follow.
- OpenSpec contains durable product, protocol, reference, and architecture truth.
- This playbook explains how to split, run, report, review, and merge agent work
  without losing state or letting parallel branches drift.

## Roles

### Owner Agent

The owner agent is the integration gatekeeper. The owner:

- classifies work before implementation starts;
- decides whether OpenSpec is required;
- assigns bounded, non-overlapping worker lanes;
- reviews worker commits before merge;
- runs final validation after integration;
- keeps the canonical task list up to date;
- stops work when a branch, worktree, or repository state looks unsafe.

Workers do not merge to `main` unless explicitly told to do so.

### Worker Agent

A worker owns one bounded lane. A worker:

- works in a separate worktree or clearly named branch;
- commits its own completed slice;
- does not rewrite, reset, or rebase over local-only commits without preserving
  them first;
- does not broaden scope without reporting;
- validates the slice before reporting;
- returns exact files changed, tests run, residual risks, and next slice.

### Explorer / Reviewer Agent

Use explorer-style agents for short, read-only audits, design comparison,
failure triage, and review. They should usually produce a memo, matrix, or
recommendation, not code.

## Work Categories

Classify work before assigning it. This avoids forcing every task through the
same process.

| Category | Examples | OpenSpec? | Default Owner Action |
| --- | --- | --- | --- |
| Trivial fix | typo, one-line test correction, small copy tweak | No | Implement directly |
| Bug fix | crash, SQL error, routing loop, connector regression | Usually no, unless contract behavior changes | Assign or fix with regression test |
| Implementation gap | `expand[]` promised but broken, attachment blobs missing | Usually yes if durable behavior is affected | Audit first, then implement |
| New contract | new endpoint, response field, header, manifest field | Yes | OpenSpec proposal before code |
| New dependency | Docker base, embedding model, database driver | Yes | OpenSpec proposal before code |
| UI/operator polish | dashboard liveness, progress UI, diagnostics copy | Sometimes | Use judgment; spec if durable/operator contract changes |
| Investigation | "why is GitHub failing?" | No, unless it becomes design work | Produce memo + repro |
| Refactor | TS migration, query extraction, module split | Yes if broad or architecture-shaping | Slice by module, validate per slice |
| Open question | credentials, identity graph, partial-run honesty | Design note first | Promote to OpenSpec when actionable |

When unsure, ask the owner for classification before writing code.

## OpenSpec Rules For Workers

Use OpenSpec when work changes durable behavior that future reviewers should be
able to audit. Examples:

- public endpoints, request parameters, response shapes, headers, or error codes;
- manifest fields, schema semantics, grant shape, or collection-profile messages;
- reference architecture, storage topology, security posture, or deployment model;
- multi-step user-visible behavior such as search semantics or run interactions;
- new dependencies that operators must understand.

Do not use OpenSpec for:

- one-off bug fixes that preserve existing contract;
- pure investigation memos;
- isolated test repairs;
- local-only process documentation like this playbook.

If a worker discovers that its task requires OpenSpec and no change exists, it
must stop and report. Do not invent a durable contract inside code.

## Worktree And Branch Rules

- Use a separate worktree for worker implementation.
- Name branches by outcome, not agent identity: `fix-github-progress-stream`,
  `add-reference-docker`, `audit-query-capabilities`.
- Before changing code, record:
  - `git status --short`
  - `git branch --show-current`
  - `git rev-parse --short HEAD`
  - `git worktree list`
- Treat existing dirty files as user or other-agent work unless proven otherwise.
- Never run `git reset --hard`, `git checkout -- <path>`, `git clean`, or
  destructive rebase commands unless explicitly approved for that exact state.
- If a commit, object, or worktree looks corrupt, back up the worktree contents
  before repair.
- If a rebase or merge would drop local-only commits, stop and report the exact
  commit range.

## Worker Task Packet

Use this shape when assigning work to a worker.

```text
Task: <one-sentence outcome>

Repo/worktree:
- Work in a fresh worktree from current main unless told otherwise.
- Do not merge to main.
- Do not revert unrelated changes.

Context:
- <links to OpenSpec change, design note, bug report, run id, or file paths>

Owned scope:
- <files, modules, connector, endpoint, or UI surface the worker may change>

Out of scope:
- <nearby things they must not touch>

Implementation requirements:
- <specific behavior>
- <tests that must be added or updated>
- <docs/OpenSpec updates if required>

Validation:
- <commands to run>
- Known acceptable baseline failures: <exact names only>

Stop-and-report triggers:
- <decisions owner must make>
- <unexpected contract/design implications>
- <repo corruption / dropped commits / external dirty conflicts>

Final report must include:
- commit hash(es)
- exact files changed
- root cause or design decision
- tests/checks run
- residual risks
- next recommended slice
- `git status --short`
```

## Standard Validation Matrix

Pick the smallest set that proves the slice. Do not claim readiness without
running the relevant checks.

| Area | Minimum checks |
| --- | --- |
| OpenSpec change | `openspec validate <change> --strict`; often also `openspec validate --all --strict` |
| Reference server | targeted `node --test ...`; `pnpm --dir reference-implementation run verify` |
| Full reference behavior | `pnpm --dir reference-implementation run test`; note known `composed-origin.test.js` only if still baseline |
| Web UI | `pnpm --dir apps/web run types:check`; `pnpm --dir apps/web run check`; `pnpm --dir apps/web run build` when routing/build output changes |
| Contract generation | `pnpm --filter @pdpp/reference-contract run verify`; `pnpm --filter @pdpp/reference-contract run check:generated` |
| Connector package | `pnpm --dir packages/polyfill-connectors run verify`; targeted connector tests |
| Runtime/connector live bug | targeted unit test plus one reproducible smoke or captured run timeline |
| Markdown-only process doc | read the changed docs, run `git diff --check`, and verify links/paths exist |

If a known baseline failure appears, verify it still fails on unchanged `main`
or cite the prior owner-approved baseline report.

## Report Format

Use concise, evidence-first reports.

```text
Status: complete | blocked | needs owner review
Branch/worktree:
Commit(s):

Files changed:
- <path> — <purpose>

What changed:
- <behavioral summary>

Validation:
- <command> — pass/fail

Residual risks:
- <risk and why it remains>

Next slice:
- <one concrete recommendation>

git status --short:
<output>
```

For blocked reports, include the last line or distinctive phrase the owner can
quote back to locate the right agent.

## Merge Queue

The owner should merge in dependency order:

1. safety and data-loss fixes;
2. contract/spec changes;
3. backend behavior changes;
4. web/operator surfaces that depend on backend behavior;
5. docs and cleanup.

Before each merge:

- inspect `git log --oneline main..branch`;
- skim each commit or review the aggregate diff;
- run the relevant validation matrix;
- confirm no unrelated dirty files are staged;
- commit or merge with a message that names the capability, not the agent.

After merge:

- rerun the narrow checks most likely to catch integration fallout;
- update OpenSpec task checkboxes if the merge completed a task;
- close or remove the worker worktree only after the branch is merged and clean.

## Stop-And-Report Triggers

Stop instead of guessing when:

- the implementation would change a public contract but no OpenSpec change covers it;
- an approved design appears wrong or incomplete;
- a dependency choice affects deployment, security, or operator burden;
- a branch contains local-only commits that would be dropped;
- Git reports corrupt objects or missing refs;
- tests fail in a way not already verified as baseline;
- live connector behavior contradicts the manifest or docs;
- fixing the bug requires touching unrelated hot files.

Do not stop for ordinary implementation details that are local and reversible.
Make a reasonable assumption, document it in the report, and continue.

## Current High-Throughput Lanes

Use these buckets when spinning up multiple workers. They are intentionally
non-overlapping.

| Lane | Owner | Example tasks |
| --- | --- | --- |
| Runtime/search core | Owner agent | semantic backfill resume, query semantics, auth gates |
| Docker/ops | Worker | image, compose, volumes, env, cache, runbook |
| Connector reliability | One worker per connector | GitHub progress stream, Gmail runtime failure, USAA login, Claude Code ingest |
| Query/API audit | Explorer or worker | range filters, schema endpoint, `expand[]`, `changes_since`, attachments |
| Web/operator UI | Worker | live run refresh, progress cards, interaction UX, last-sync display |
| OpenSpec cleanup | Worker | split broad changes, archive completed changes, normalize design notes |
| Small polish | Worker | revision header, diagnostics copy, docs links |

The owner should keep new contract work out of implementation lanes until a
proposal exists.

## Anti-Patterns

- One worker owns "the dashboard" or "all connectors."
- A worker combines investigation, proposal, implementation, and cleanup in one
  unreviewed branch.
- A branch says "all tests pass" but omits exact commands.
- An agent marks OpenSpec tasks complete without code or tests proving them.
- A worker fixes a live connector by weakening runtime protocol validation.
- A dashboard hides backend uncertainty instead of linking to inspectable data.
- A process doc starts duplicating durable protocol requirements that belong in
  OpenSpec.

## Owner Checklist Before Saying "Done"

- The implemented behavior matches the applicable OpenSpec change or the task
  was correctly classified as non-OpenSpec.
- The final diff contains no unrelated files.
- Relevant tests/checks ran and are reported.
- Known failures are verified as baseline, not assumed.
- OpenSpec tasks and docs are updated if the work changes durable behavior.
- The worker branch is clean or remaining uncommitted files are explicitly
  accounted for.
- The next action is either obvious from the report or captured in a task list.
